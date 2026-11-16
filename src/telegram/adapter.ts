import {
  Api,
  InputFile,
  type TransportOptions,
  type SendChatActionParams,
  type GetUpdatesParams,
  type Update,
} from "node-telegram-bot-api";
import { mediaKind } from "../files/media-kind.js";
import https from "node:https";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { setTimeout as delay } from "node:timers/promises";

export type TelegramMethod = keyof Api;
export type ParameterlessMethod =
  "getMe" | "getWebhookInfo" | "logOut" | "close";
export type TelegramResult<M extends TelegramMethod> = Awaited<
  ReturnType<Api[M]>
>;
export type TelegramParams<M extends TelegramMethod> =
  M extends ParameterlessMethod ? never : NonNullable<Parameters<Api[M]>[0]>;
export type TelegramCallArgs<M extends TelegramMethod> =
  M extends ParameterlessMethod
    ? [params?: Record<string, never>]
    : undefined extends Parameters<Api[M]>[0]
      ? [params?: TelegramParams<M>]
      : [params: TelegramParams<M>];

/** Only invocation is required from an injected carrier, not the concrete SDK.
 * Unknown results intentionally permit small mocks; production results follow
 * the SDK's method-specific result contract at the public call boundary.
 */
export type TelegramApiPort = {
  [M in TelegramMethod]?: (...args: Parameters<Api[M]>) => Promise<unknown>;
};
export type CreateTelegramApi = (
  token: string,
  options: TransportOptions,
) => TelegramApiPort;

/** Kept local until the Host credential port is integrated. */
export interface TelegramCredentials {
  readRecord(
    key: string,
  ): Promise<{ kind: string; key?: string } | undefined | null>;
}

export interface TelegramAdapterOptions {
  credentials: TelegramCredentials;
  credentialKey: string;
  signal?: AbortSignal;
  createApi?: CreateTelegramApi;
  /** Numeric-only instrumentation; invoked at send wire-start after scheduler waits. */
  onSendStart?: () => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export interface TelegramFileOptions {
  chatId: string | number;
  threadId?: number;
  name: string;
  content: Buffer;
  caption?: string;
}

interface Lane {
  tail: Promise<void>;
  next: number;
  draftUntil: number;
  pending: number;
}

type ApiParams = Record<string, unknown>;
type Release = () => void;

export class TelegramRequestError extends Error {
  code?: unknown;
  retryAfterMs?: number;
}

function errorFields(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)
    : {};
}

// Also abort queue waits, not just the HTTP request or cooldown timer.
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    // Use paired handlers rather than leaving an unobserved rejected finally.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

// Node fetch stalls on this host's Telegram route; preserve the library's
// serialization and cancellation using a native IPv4 HTTPS carrier.
export const telegramFetch: typeof fetch = async (url, init) => {
  const target = new URL(url instanceof Request ? url.url : url);
  if (target.origin !== "https://api.telegram.org") {
    throw Error("Unexpected Telegram API origin");
  }
  const request = new Request(url, init);
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      target,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        family: 4,
        signal: request.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            res.destroy(Error("Telegram response exceeds limit"));
          } else {
            chunks.push(chunk);
          }
        });
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) headers.append(name, entry);
            } else if (value !== undefined) {
              headers.set(name, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (request.body) {
      // DOM and Node declare the same Web stream with incompatible BYOB types.
      Readable.fromWeb(
        request.body as unknown as NodeReadableStream<Uint8Array>,
      )
        .on("error", (error: Error) => req.destroy(error))
        .pipe(req);
    } else {
      req.end();
    }
  });
};

/** Only the dynamic console carrier surface is admitted through callWire.
 * Runtime callers validate method-specific parameter fields before this boundary.
 * This list deliberately excludes SDK helpers and Object prototype properties.
 */
const WIRE_METHODS: ReadonlySet<string> = new Set([
  "getUpdates",
  "getMe",
  "getWebhookInfo",
  "setMyCommands",
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
  "pinChatMessage",
  "editForumTopic",
  "reopenForumTopic",
  "createForumTopic",
  "deleteForumTopic",
  "answerCallbackQuery",
  "sendMessageDraft",
  "sendChatAction",
  "deleteMessage",
  "sendWidget",
]);

function isParameterless(method: string): method is ParameterlessMethod {
  return ["getMe", "getWebhookInfo", "logOut", "close"].includes(method);
}

/** Dynamic invocation stays here; all callers retain SDK-specific signatures. */
async function invokeApi(
  api: TelegramApiPort,
  method: string,
  params: ApiParams,
  signal?: AbortSignal,
): Promise<unknown> {
  const candidate: unknown = Reflect.get(api, method);
  if (typeof candidate !== "function") {
    throw Error(`Unsupported Telegram method: ${method}`);
  }
  return Reflect.apply(
    candidate,
    api,
    isParameterless(method) ? [signal] : [params, signal],
  );
}

export class TelegramAdapter {
  readonly credentials: TelegramCredentials;
  readonly credentialKey: string;
  readonly signal?: AbortSignal;
  readonly createApi: CreateTelegramApi;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  private readonly onSendStart?: () => void;
  rateLimitCount = 0;
  rateLimitLastWaitMs = 0;
  rateLimitMaxWaitMs = 0;
  cooldownUntil = 0;
  readonly lanes = new Map<string, Lane>();
  outboundActive = 0;
  readonly outboundWaiters: Release[] = [];
  private readonly typingTimes = new Map<string, number>();

  constructor({
    credentials,
    credentialKey,
    signal,
    createApi = (token, options) => new Api(token, options),
    onSendStart,
    now = Date.now,
    sleep = (ms, signal) => delay(ms, undefined, { signal }),
  }: TelegramAdapterOptions) {
    this.credentials = credentials;
    this.credentialKey = credentialKey;
    this.signal = signal;
    this.createApi = createApi;
    this.onSendStart = onSendStart;
    this.now = now;
    this.sleep = sleep;
  }

  async waitUntil(deadline: () => number): Promise<void> {
    for (;;) {
      this.signal?.throwIfAborted();
      const ms = deadline() - this.now();
      if (ms <= 0) return;
      await abortable(this.sleep(ms, this.signal), this.signal);
    }
  }

  call<M extends TelegramMethod>(
    method: M,
    ...args: TelegramCallArgs<M>
  ): Promise<TelegramResult<M>>;
  call(method: string, params: ApiParams = {}): Promise<unknown> {
    return this.callInternal(method, params);
  }

  /** Validated dynamic wire dispatch; parameter schemas belong to the caller. */
  async callWire(method: string, params: ApiParams = {}): Promise<unknown> {
    if (!WIRE_METHODS.has(method)) {
      throw Error(`Unsupported Telegram wire method: ${method}`);
    }
    return this.callInternal(method, params);
  }

  private async callInternal(
    method: string,
    params: ApiParams,
  ): Promise<unknown> {
    this.signal?.throwIfAborted();
    // Polling and callback acknowledgements bypass outbound lanes/cooldown.
    const bypass = method === "getUpdates" || method === "answerCallbackQuery";
    if (bypass) return this.requestInternal(method, params);
    const topicKey = JSON.stringify([
      "topic",
      String(params.chat_id),
      String(params.message_thread_id ?? 0),
    ]);
    const draft = method === "sendMessageDraft";
    const action = method === "sendChatAction";
    const edit = method.startsWith("edit");
    const mutation =
      params.chat_id != null &&
      /^(send|edit|delete|forward|copy|pin|unpin)/.test(method);
    const key = edit
      ? JSON.stringify([
          "edit",
          String(params.chat_id ?? ""),
          String(params.message_id ?? params.inline_message_id ?? ""),
        ])
      : draft || action
        ? topicKey
        : mutation
          ? JSON.stringify(["chat", String(params.chat_id)])
          : null;
    if (key === null) return this.requestInternal(method, params);
    for (const [id, lane] of this.lanes) {
      if (!lane.pending && Math.max(lane.next, lane.draftUntil) <= this.now()) {
        this.lanes.delete(id);
      }
    }
    let existing = this.lanes.get(key);
    if (!existing) {
      existing = {
        tail: Promise.resolve(),
        next: 0,
        draftUntil: 0,
        pending: 0,
      };
      this.lanes.set(key, existing);
    }
    const lane = existing;
    lane.pending++;
    const previous = lane.tail;
    let release: Release = () => {};
    lane.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await abortable(previous, this.signal);
      if (
        action &&
        params.action === "typing" &&
        lane.draftUntil > this.now()
      ) {
        return true;
      }
      await this.waitUntil(() => Math.max(this.cooldownUntil, lane.next));
      const result = await this.requestInternal(method, params, () => {
        lane.next = this.now() + (draft || action || edit ? 300 : 1100);
      });
      if (draft) lane.draftUntil = this.now() + 5000;
      return result;
    } finally {
      // Keep predecessor ordering even if a queued caller aborts.
      const done = () => {
        lane.pending--;
        release();
      };
      previous.then(done, done);
    }
  }

  async acquireOutbound(): Promise<Release> {
    this.signal?.throwIfAborted();
    return new Promise<Release>((resolve, reject) => {
      const grant = () => {
        this.signal?.removeEventListener("abort", abort);
        this.outboundActive++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.outboundActive--;
          this.outboundWaiters.shift()?.();
        });
      };
      const abort = () => {
        const index = this.outboundWaiters.indexOf(grant);
        if (index >= 0) this.outboundWaiters.splice(index, 1);
        reject(
          this.signal?.reason ?? new DOMException("Aborted", "AbortError"),
        );
      };
      if (this.outboundActive < 4) grant();
      else {
        this.outboundWaiters.push(grant);
        this.signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }

  request<M extends TelegramMethod>(
    method: M,
    ...args: [...TelegramCallArgs<M>, onStart?: () => void]
  ): Promise<TelegramResult<M>>;
  request(
    method: string,
    params: ApiParams = {},
    onStart?: () => void,
  ): Promise<unknown> {
    return this.requestInternal(method, params, onStart);
  }

  private async requestInternal(
    method: string,
    params: ApiParams,
    onStart?: () => void,
  ): Promise<unknown> {
    this.signal?.throwIfAborted();
    const bypass = method === "getUpdates" || method === "answerCallbackQuery";
    const release = bypass ? () => {} : await this.acquireOutbound();
    try {
      if (!bypass) await this.waitUntil(() => this.cooldownUntil);
      this.signal?.throwIfAborted();
      // Resolve credentials only after every scheduling wait: queued work must
      // observe rotation/revocation instead of carrying a stale token to the wire.
      const record = await this.credentials.readRecord(this.credentialKey);
      this.signal?.throwIfAborted();
      if (record?.kind !== "api-key" || !record.key) {
        throw Error("Telegram bot credential is not configured");
      }
      // Never retry non-idempotent sends after ambiguous transport failure.
      const api = this.createApi(record.key, {
        fetch: telegramFetch,
        maxRetries: 0,
        timeoutMs: 40000,
      });
      if (typeof Reflect.get(api, method) !== "function") {
        throw Error(`Unsupported Telegram method: ${method}`);
      }
      onStart?.();
      if (method.startsWith("send") && method !== "sendChatAction") {
        try {
          this.onSendStart?.();
        } catch {
          // Diagnostics must never change transport behavior.
        }
      }
      return await this.invokeRedacted(api, method, params, record.key);
    } finally {
      release();
    }
  }

  private async invokeRedacted(
    api: TelegramApiPort,
    method: string,
    params: ApiParams,
    token: string,
  ): Promise<unknown> {
    try {
      return await invokeApi(api, method, params, this.signal);
    } catch (error) {
      this.signal?.throwIfAborted();
      const fields = errorFields(error);
      const message = String(
        fields.description ?? fields.message ?? "Telegram request failed",
      ).replaceAll(token, "[redacted]");
      const safe = new TelegramRequestError(`${method}: ${message}`);
      safe.code = fields.errorCode ?? fields.code;
      if (
        Number(safe.code) === 429 ||
        /\b429\b|too many requests|retry[ _-]?after/i.test(message)
      ) {
        const seconds = Number(
          fields.retryAfter ??
            errorFields(fields.parameters).retry_after ??
            message.match(/retry[ _-]?after\s*[:=]?\s*(\d+(?:\.\d+)?)/i)?.[1],
        );
        safe.retryAfterMs =
          Number.isFinite(seconds) && seconds > 0
            ? Math.ceil(seconds * 1000)
            : 1000;
        this.rateLimitCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.rateLimitCount + 1,
        );
        this.rateLimitLastWaitMs = safe.retryAfterMs;
        this.rateLimitMaxWaitMs = Math.max(
          this.rateLimitMaxWaitMs,
          safe.retryAfterMs,
        );
        this.cooldownUntil = Math.max(
          this.cooldownUntil,
          this.now() + safe.retryAfterMs,
        );
        safe.code = 429;
      }
      throw safe;
    }
  }

  async typing(params: Omit<SendChatActionParams, "action">): Promise<void> {
    const key = `typing:${params.chat_id}:${params.message_thread_id || 0}`;
    if ((this.typingTimes.get(key) || 0) > this.now()) return;
    this.typingTimes.set(key, this.now() + 4000);
    await this.request("sendChatAction", { ...params, action: "typing" });
  }

  async file(
    options: TelegramFileOptions,
  ): Promise<TelegramResult<"sendDocument">> {
    const { chatId, threadId, name, content, caption } = options;
    const kind = mediaKind(name, content);
    if (kind === "document") return this.document(options);
    const params = {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      caption: caption?.slice(0, 1024),
      protect_content: true,
    };
    const file = new InputFile(content, { filename: name });
    try {
      // Separate literal methods preserve SDK parameter/result correlation.
      switch (kind) {
        case "photo":
          return await this.call("sendPhoto", { ...params, photo: file });
        case "animation":
          return await this.call("sendAnimation", {
            ...params,
            animation: file,
          });
        case "video":
          return await this.call("sendVideo", {
            ...params,
            video: file,
            supports_streaming: true,
          });
        case "audio":
          return await this.call("sendAudio", { ...params, audio: file });
      }
    } catch (error) {
      // Retry only definitive media-format rejection, never ambiguous sends.
      if (
        !/PHOTO_INVALID|IMAGE_PROCESS_FAILED|VIDEO_CONTENT_TYPE_INVALID|AUDIO_CONTENT_TYPE_INVALID|wrong type of the web page content|failed to process/i.test(
          String(errorFields(error).message ?? ""),
        )
      ) {
        throw error;
      }
      return this.document(options);
    }
  }

  async document({
    chatId,
    threadId,
    name,
    content,
    caption,
  }: TelegramFileOptions): Promise<TelegramResult<"sendDocument">> {
    return this.call("sendDocument", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      document: new InputFile(content, { filename: name }),
      caption: caption?.slice(0, 1024),
      protect_content: true,
    });
  }
}

export interface PollUpdatesOptions {
  api: {
    call(method: "getUpdates", params: GetUpdatesParams): Promise<Update[]>;
  };
  store: {
    get(key: "poll-offset"): Promise<number | undefined | null>;
    set(key: "poll-offset", offset: number): Promise<unknown>;
  };
  console: { handleUpdate(update: Update): Promise<unknown> };
  signal: AbortSignal;
  onError(error: unknown): void;
}

export async function pollUpdates({
  api,
  store,
  console: surface,
  signal,
  onError,
}: PollUpdatesOptions): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const offset = (await store.get("poll-offset")) ?? 0;
      const updates = await api.call("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: [
          "message",
          "callback_query",
          "stopped_message_generation",
        ],
      });
      for (const update of updates) {
        if (signal.aborted) return;
        try {
          await surface.handleUpdate(update);
        } catch (error) {
          onError(error);
        }
        // Stable update IDs are DSH prompt idempotency keys.
        await store.set("poll-offset", update.update_id + 1);
      }
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      onError(error);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          done,
          Math.min(60000, 1000 * 2 ** Math.min(failures++, 6)),
        );
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
