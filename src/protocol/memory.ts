import {
  decodeJson,
  encodeJson,
  ProtocolError,
  type JsonValue,
} from "./json.js";
import type { WireTransport } from "./rpc.js";

interface Delivery {
  text: string;
  bytes: number;
  resolve: () => void;
  reject: (reason: ProtocolError) => void;
}

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_MESSAGES = 64;

/** Serialized, asynchronous test/local transport with the same bounded admission as IPC. */
class MemoryTransport implements WireTransport {
  readonly #messages = new Set<(message: JsonValue) => void>();
  readonly #closes = new Set<() => void>();
  readonly #queue: Delivery[] = [];
  #other: MemoryTransport | undefined;
  #closed = false;
  #scheduled = false;
  #queuedBytes = 0;

  connect(other: MemoryTransport): void {
    this.#other = other;
  }

  send(message: JsonValue): Promise<void> {
    try {
      if (this.#closed || !this.#other || this.#other.#closed) {
        throw new ProtocolError("CLOSED", "Memory transport is closed");
      }
      // Serialize before returning, even when earlier sends have not completed.
      const text = encodeJson(message);
      const bytes = Buffer.byteLength(text, "utf8");
      if (
        this.#queue.length >= MAX_QUEUED_MESSAGES ||
        bytes > MAX_QUEUED_BYTES - this.#queuedBytes
      ) {
        throw new ProtocolError(
          "QUEUE_LIMIT",
          "Memory transport queue limit exceeded",
        );
      }
      const result = new Promise<void>((resolve, reject) => {
        this.#queue.push({ text, bytes, resolve, reject });
      });
      void result.catch(() => {});
      this.#queuedBytes += bytes;
      if (!this.#scheduled) {
        this.#scheduled = true;
        queueMicrotask(() => this.#flush());
      }
      return result;
    } catch (cause: unknown) {
      const result = Promise.reject<void>(
        cause instanceof ProtocolError
          ? cause
          : new ProtocolError("TRANSPORT_ERROR", "Memory transport failed"),
      );
      void result.catch(() => {});
      return result;
    }
  }

  onMessage(listener: (message: JsonValue) => void): () => void {
    if (!this.#closed) this.#messages.add(listener);
    return () => {
      this.#messages.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.#closed) {
      let active = true;
      queueMicrotask(() => {
        if (active) listener();
      });
      return () => {
        active = false;
      };
    }
    this.#closes.add(listener);
    return () => {
      this.#closes.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const reason = new ProtocolError("CLOSED", "Memory transport is closed");
    for (const delivery of this.#queue.splice(0)) delivery.reject(reason);
    this.#queuedBytes = 0;
    const listeners = [...this.#closes];
    this.#closes.clear();
    this.#messages.clear();
    this.#other?.close();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* One observer cannot prevent teardown. */
      }
    }
  }

  #flush(): void {
    this.#scheduled = false;
    if (this.#closed) return;
    // Only flush the admitted batch: listener-created sends stay asynchronous.
    const count = this.#queue.length;
    for (let index = 0; index < count; index++) {
      const delivery = this.#queue.shift();
      if (!delivery) return;
      this.#queuedBytes -= delivery.bytes;
      const other = this.#other;
      if (!other || other.#closed) {
        delivery.reject(
          new ProtocolError("CLOSED", "Memory transport is closed"),
        );
        this.close();
        return;
      }
      try {
        for (const listener of [...other.#messages]) {
          if (this.#closed || other.#closed) break;
          listener(decodeJson(delivery.text));
        }
        if (this.#closed)
          delivery.reject(
            new ProtocolError("CLOSED", "Memory transport is closed"),
          );
        else delivery.resolve();
      } catch {
        delivery.reject(
          new ProtocolError(
            "TRANSPORT_ERROR",
            "Memory transport delivery failed",
          ),
        );
        this.close();
        return;
      }
    }
  }
}

export function createMemoryTransportPair(): [WireTransport, WireTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.connect(right);
  right.connect(left);
  return [left, right];
}
