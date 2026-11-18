import { randomUUID } from "node:crypto";
import {
  decodeJson,
  encodeJson,
  jsonObject,
  ProtocolError,
  type JsonValue,
} from "./json.js";

/** Admission is not an acknowledgement of remote execution. No send is retried. */
export interface WireTransport {
  send(message: JsonValue): Promise<void>;
  onMessage(listener: (message: JsonValue) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export type RpcHandler = (
  payload: JsonValue,
  signal: AbortSignal,
) => Promise<JsonValue>;

export interface RpcPeerOptions {
  transport: WireTransport;
  generation: string;
  handlers?: Record<string, RpcHandler>;
  /** Local-only diagnostics, awaited for at most 250 ms; failures are ignored. */
  onHandlerError?: (method: string, error: unknown) => void | Promise<void>;
  maxPending?: number;
  maxQueuedBytes?: number;
  timeoutMs?: number;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type RequestId = string | number;
type EnvelopeType = "request" | "result" | "error" | "cancel";
interface Envelope {
  version: 1;
  generation: string;
  id: RequestId;
  type: EnvelopeType;
  payload: JsonValue;
}
interface Pending {
  resolve: (value: JsonValue) => void;
  reject: (error: ProtocolError) => void;
  cleanup: () => void;
}

const MAX_PENDING = 64;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const messages: Readonly<Record<string, string>> = {
  CLOSED: "RPC peer is closed",
  CANCELLED: "RPC request was cancelled",
  TIMEOUT: "RPC request timed out",
  PENDING_LIMIT: "RPC pending request limit exceeded",
  QUEUE_LIMIT: "RPC queued byte limit exceeded",
  INVALID_ENVELOPE: "Invalid RPC envelope",
  UNKNOWN_METHOD: "Unknown RPC method",
  HANDLER_ERROR: "RPC handler failed",
  INVALID_RESULT: "RPC handler returned an invalid result",
  TRANSPORT_ERROR: "RPC transport failed",
};

function error(code: string): ProtocolError {
  return new ProtocolError(code, messages[code] ?? "RPC operation failed");
}

function boundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ProtocolError("INVALID_OPTIONS", "Invalid RPC capacity");
  }
  return value;
}

function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new ProtocolError("INVALID_OPTIONS", "Invalid RPC timeout");
  }
  return value;
}

function exactKeys(value: Record<string, JsonValue>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function envelope(value: JsonValue, generation: string): Envelope {
  if (
    !jsonObject(value) ||
    !exactKeys(value, ["version", "generation", "id", "type", "payload"]) ||
    value.version !== 1 ||
    value.generation !== generation ||
    !(
      (typeof value.id === "string" && value.id.length > 0) ||
      (typeof value.id === "number" &&
        Number.isSafeInteger(value.id) &&
        value.id >= 0)
    ) ||
    !["request", "result", "error", "cancel"].includes(String(value.type))
  ) {
    throw error("INVALID_ENVELOPE");
  }
  const { id, type, payload } = value;
  if (payload === undefined) throw error("INVALID_ENVELOPE");
  if (type === "request") {
    if (
      !jsonObject(payload) ||
      !exactKeys(payload, ["method", "params"]) ||
      typeof payload.method !== "string" ||
      payload.method.length === 0
    ) {
      throw error("INVALID_ENVELOPE");
    }
  } else if (type === "error") {
    if (
      !jsonObject(payload) ||
      !exactKeys(payload, ["code", "message"]) ||
      typeof payload.code !== "string" ||
      payload.code.length === 0 ||
      payload.code.length > 64 ||
      typeof payload.message !== "string" ||
      payload.message.length > 256
    ) {
      throw error("INVALID_ENVELOPE");
    }
  } else if (type === "cancel" && payload !== null) {
    throw error("INVALID_ENVELOPE");
  }
  // Narrow the discriminant explicitly rather than trusting a wire assertion.
  if (
    type !== "request" &&
    type !== "result" &&
    type !== "error" &&
    type !== "cancel"
  ) {
    throw error("INVALID_ENVELOPE");
  }
  return { version: 1, generation, id, type, payload };
}

/** Bounded, generation-fenced RPC. Malformed frames close the entire peer. */
export class RpcPeer {
  readonly #transport: WireTransport;
  readonly #generation: string;
  readonly #handlers = new Map<string, RpcHandler>();
  readonly #onHandlerError: RpcPeerOptions["onHandlerError"];
  readonly #maxPending: number;
  readonly #maxQueuedBytes: number;
  readonly #timeoutMs: number;
  readonly #pending = new Map<RequestId, Pending>();
  readonly #running = new Map<RequestId, AbortController>();
  readonly #subscriptions: Array<() => void> = [];
  #queuedBytes = 0;
  #closed = false;

  constructor(options: RpcPeerOptions) {
    this.#transport = options.transport;
    if (typeof options.generation !== "string" || !options.generation.length) {
      throw new ProtocolError("INVALID_OPTIONS", "Invalid RPC generation");
    }
    this.#generation = options.generation;
    this.#onHandlerError = options.onHandlerError;
    this.#maxPending = boundedInteger(
      options.maxPending ?? MAX_PENDING,
      MAX_PENDING,
    );
    this.#maxQueuedBytes = boundedInteger(
      options.maxQueuedBytes ?? MAX_QUEUED_BYTES,
      MAX_QUEUED_BYTES,
    );
    this.#timeoutMs = timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (options.handlers) {
      for (const method of Object.keys(options.handlers)) {
        const handler = options.handlers[method];
        if (typeof handler !== "function") {
          throw new ProtocolError("INVALID_OPTIONS", "Invalid RPC handler");
        }
        this.#handlers.set(method, handler);
      }
    }
    this.#subscriptions.push(
      this.#transport.onMessage((message) => this.#receive(message)),
      this.#transport.onClose(() => this.#shutdown(error("CLOSED"))),
    );
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  request(
    method: string,
    payload: JsonValue,
    options: RpcRequestOptions = {},
  ): Promise<JsonValue> {
    try {
      if (this.#closed) throw error("CLOSED");
      if (options.signal?.aborted) throw error("CANCELLED");
      if (this.#pending.size >= this.#maxPending) throw error("PENDING_LIMIT");
      const timeoutMs = timeout(options.timeoutMs ?? this.#timeoutMs);
      const id = randomUUID();
      const frame = this.#prepare("request", id, { method, params: payload });
      let resolve!: (value: JsonValue) => void;
      let reject!: (reason: ProtocolError) => void;
      const result = new Promise<JsonValue>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      // Teardown may reject before the owner has attached its await/catch.
      void result.catch(() => {});
      const cancel = () => this.#cancel(id, "CANCELLED");
      const timer = setTimeout(() => this.#cancel(id, "TIMEOUT"), timeoutMs);
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
        },
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      void this.#sendPrepared(frame).catch((cause: unknown) => {
        this.#settle(
          id,
          cause instanceof ProtocolError ? cause : error("TRANSPORT_ERROR"),
        );
      });
      return result;
    } catch (cause: unknown) {
      const rejected = Promise.reject<JsonValue>(
        cause instanceof ProtocolError ? cause : error("INVALID_ENVELOPE"),
      );
      void rejected.catch(() => {});
      return rejected;
    }
  }

  close(): void {
    this.#shutdown(error("CLOSED"));
  }

  #shutdown(reason: ProtocolError): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    for (const id of this.#pending.keys()) this.#settle(id, reason);
    for (const controller of this.#running.values()) controller.abort();
    this.#running.clear();
    this.#handlers.clear();
    try {
      this.#transport.close();
    } catch {
      // The peer is already closed; transport errors never disclose details.
    }
  }

  #settle(id: RequestId, outcome: ProtocolError | JsonValue): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.cleanup();
    if (outcome instanceof ProtocolError) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  #cancel(id: RequestId, code: "CANCELLED" | "TIMEOUT"): void {
    if (!this.#pending.has(id)) return;
    this.#settle(id, error(code));
    this.#reply("cancel", id, null);
  }

  #prepare(
    type: EnvelopeType,
    id: RequestId,
    payload: JsonValue,
  ): {
    message: JsonValue;
    bytes: number;
  } {
    const text = encodeJson({
      version: 1,
      generation: this.#generation,
      id,
      type,
      payload,
    });
    const message = decodeJson(text);
    envelope(message, this.#generation);
    return { message, bytes: Buffer.byteLength(text, "utf8") };
  }

  #sendPrepared(frame: { message: JsonValue; bytes: number }): Promise<void> {
    if (this.#closed) return Promise.reject(error("CLOSED"));
    if (frame.bytes > this.#maxQueuedBytes - this.#queuedBytes) {
      return Promise.reject(error("QUEUE_LIMIT"));
    }
    this.#queuedBytes += frame.bytes;
    let sent: Promise<void>;
    try {
      sent = this.#transport.send(frame.message);
    } catch {
      sent = Promise.reject(error("TRANSPORT_ERROR"));
    }
    return sent.then(
      () => {
        this.#queuedBytes -= frame.bytes;
      },
      () => {
        this.#queuedBytes -= frame.bytes;
        this.#shutdown(error("TRANSPORT_ERROR"));
        throw error("TRANSPORT_ERROR");
      },
    );
  }

  #reply(type: EnvelopeType, id: RequestId, payload: JsonValue): void {
    if (this.#closed) return;
    try {
      void this.#sendPrepared(this.#prepare(type, id, payload)).catch(() => {
        this.#shutdown(error("TRANSPORT_ERROR"));
      });
    } catch {
      this.#shutdown(error("INVALID_ENVELOPE"));
    }
  }

  #receive(message: JsonValue): void {
    if (this.#closed) return;
    let frame: Envelope;
    try {
      // A transport implementation is not trusted to enforce JSON or byte limits.
      frame = envelope(decodeJson(encodeJson(message)), this.#generation);
    } catch {
      this.#shutdown(error("INVALID_ENVELOPE"));
      return;
    }
    const { type, id, payload } = frame;
    if (type === "result") this.#settle(id, payload);
    else if (type === "error") {
      // These fields were checked before dispatch, including their size limits.
      if (
        jsonObject(payload) &&
        typeof payload.code === "string" &&
        typeof payload.message === "string"
      ) {
        this.#settle(id, new ProtocolError(payload.code, payload.message));
      }
    } else if (type === "cancel") this.#running.get(id)?.abort();
    else this.#dispatch(id, payload);
  }

  #dispatch(id: RequestId, payload: JsonValue): void {
    if (
      !jsonObject(payload) ||
      typeof payload.method !== "string" ||
      payload.params === undefined
    )
      return;
    if (this.#running.has(id)) {
      this.#shutdown(error("INVALID_ENVELOPE"));
      return;
    }
    const handler = this.#handlers.get(payload.method);
    if (!handler) {
      this.#reply("error", id, {
        code: "UNKNOWN_METHOD",
        message: messages.UNKNOWN_METHOD ?? "Unknown RPC method",
      });
      return;
    }
    if (this.#running.size >= this.#maxPending) {
      this.#reply("error", id, {
        code: "PENDING_LIMIT",
        message: messages.PENDING_LIMIT ?? "RPC pending request limit exceeded",
      });
      return;
    }
    const controller = new AbortController();
    this.#running.set(id, controller);
    void this.#run(id, payload.method, handler, payload.params, controller);
  }

  async #observeHandlerError(method: string, cause: unknown): Promise<void> {
    if (!this.#onHandlerError) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Promise adoption also catches synchronous throws and late rejections.
        Promise.resolve().then(() => this.#onHandlerError?.(method, cause)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } catch {
      // Diagnostics never change the wire reply or runtime control flow.
    } finally {
      clearTimeout(timer);
    }
  }

  async #run(
    id: RequestId,
    method: string,
    handler: RpcHandler,
    params: JsonValue,
    controller: AbortController,
  ): Promise<void> {
    try {
      let result: JsonValue;
      try {
        result = await handler(params, controller.signal);
      } catch (cause: unknown) {
        await this.#observeHandlerError(method, cause);
        if (!controller.signal.aborted && !this.#closed) {
          this.#reply("error", id, {
            code: "HANDLER_ERROR",
            message: "RPC handler failed",
          });
        }
        return;
      }
      if (controller.signal.aborted || this.#closed) return;
      let frame: { message: JsonValue; bytes: number };
      try {
        frame = this.#prepare("result", id, result);
      } catch {
        this.#reply("error", id, {
          code: "INVALID_RESULT",
          message: "RPC handler returned an invalid result",
        });
        return;
      }
      try {
        await this.#sendPrepared(frame);
      } catch {
        this.#shutdown(error("TRANSPORT_ERROR"));
      }
    } finally {
      this.#running.delete(id);
    }
  }
}
