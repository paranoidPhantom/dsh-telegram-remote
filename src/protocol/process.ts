import {
  decodeJson,
  encodeJson,
  ProtocolError,
  type JsonValue,
} from "./json.js";
import type { WireTransport } from "./rpc.js";

/** The shared, deliberately narrow surface of ChildProcess and process. */
export interface ProcessEndpoint {
  connected: boolean;
  send?: (
    message: Exclude<JsonValue, null>,
    callback: (error: Error | null) => void,
  ) => boolean;
  disconnect?: () => void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "disconnect" | "exit" | "error", listener: () => void): unknown;
  removeListener(
    event: "message",
    listener: (message: unknown) => void,
  ): unknown;
  removeListener(
    event: "disconnect" | "exit" | "error",
    listener: () => void,
  ): unknown;
}

export interface ProcessTransportOptions {
  maxQueuedBytes?: number;
  maxQueuedMessages?: number;
}
interface PendingSend {
  message: JsonValue;
  bytes: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * Bounded JSON IPC. A false send return means backpressure, not rejection: only
 * the callback releases the in-flight slot, and a message is never resent.
 */
export function createProcessTransport(
  endpoint: ProcessEndpoint,
  options: ProcessTransportOptions = {},
): WireTransport {
  const byteLimit = options.maxQueuedBytes ?? 4 * 1024 * 1024;
  const messageLimit = options.maxQueuedMessages ?? 64;
  if (
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 1 ||
    !Number.isSafeInteger(messageLimit) ||
    messageLimit < 1
  ) {
    throw new ProtocolError("INVALID_LIMIT", "Invalid IPC queue limit");
  }
  let closed = false;
  let queuedBytes = 0;
  let active: PendingSend | undefined;
  const queue: PendingSend[] = [];
  const messages = new Set<(message: JsonValue) => void>();
  const closes = new Set<() => void>();
  const closedError = () =>
    new ProtocolError("TRANSPORT_CLOSED", "IPC transport is closed");

  function finish(disconnect: boolean): void {
    if (closed) return;
    closed = true;
    endpoint.removeListener("message", receive);
    endpoint.removeListener("disconnect", lost);
    endpoint.removeListener("exit", lost);
    endpoint.removeListener("error", lost);
    active?.reject(closedError());
    active = undefined;
    for (const item of queue.splice(0)) item.reject(closedError());
    queuedBytes = 0;
    for (const listener of [...closes]) {
      try {
        listener();
      } catch {
        /* One observer cannot prevent pipe cleanup. */
      }
    }
    messages.clear();
    closes.clear();
    if (disconnect && endpoint.connected) {
      try {
        endpoint.disconnect?.();
      } catch {
        /* Already disconnected. */
      }
    }
  }
  function lost(): void {
    finish(false);
  }
  function receive(value: unknown): void {
    if (closed) return;
    let snapshot: JsonValue;
    try {
      snapshot = decodeJson(encodeJson(value));
    } catch {
      finish(true);
      return;
    }
    for (const listener of [...messages]) listener(snapshot);
  }
  function pump(): void {
    if (closed || active) return;
    const item = queue.shift();
    if (!item) return;
    active = item;
    if (!endpoint.connected || !endpoint.send || item.message === null) {
      finish(false);
      return;
    }
    try {
      endpoint.send(item.message, (error) => {
        if (closed || active !== item) return;
        active = undefined;
        queuedBytes -= item.bytes;
        if (error) {
          item.reject(new ProtocolError("TRANSPORT_SEND", "IPC send failed"));
          finish(true);
          return;
        }
        item.resolve();
        pump();
      });
    } catch {
      // The native API can throw before invoking the callback on a lost pipe.
      finish(true);
    }
  }

  endpoint.on("message", receive);
  endpoint.on("disconnect", lost);
  endpoint.on("exit", lost);
  endpoint.on("error", lost);
  if (!endpoint.connected) finish(false);
  return {
    send(message) {
      if (closed) return Promise.reject(closedError());
      // Node's native JSON IPC rejects top-level null although null remains
      // valid within RPC envelopes. Do not corrupt/close a healthy pipe for it.
      if (message === null) {
        return Promise.reject(
          new ProtocolError(
            "INVALID_IPC_MESSAGE",
            "IPC requires a non-null top-level value",
          ),
        );
      }
      let text: string;
      try {
        text = encodeJson(message);
      } catch (error) {
        return Promise.reject(error);
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (
        queuedBytes + bytes > byteLimit ||
        queue.length + (active ? 1 : 0) >= messageLimit
      ) {
        return Promise.reject(
          new ProtocolError("BACKPRESSURE", "IPC queue budget exceeded"),
        );
      }
      // Snapshot at admission, not when a previous native send completes.
      const snapshot = decodeJson(text);
      return new Promise<void>((resolve, reject) => {
        queuedBytes += bytes;
        queue.push({ message: snapshot, bytes, resolve, reject });
        pump();
      });
    },
    onMessage(listener) {
      if (!closed) messages.add(listener);
      return () => {
        messages.delete(listener);
      };
    },
    onClose(listener) {
      if (closed) queueMicrotask(listener);
      else closes.add(listener);
      return () => {
        closes.delete(listener);
      };
    },
    close() {
      finish(true);
    },
  };
}
