import {
  decodeJson,
  encodeJson,
  jsonObject,
  ProtocolError,
  type JsonValue,
} from "../protocol/json.js";

export interface InboxStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}

export interface InboxEntry {
  updateId: number;
  ownerEpoch: number;
  operation: JsonValue;
}

export type InboxOutcome = "completed" | "failed" | "uncertain";

interface StoredEntry extends InboxEntry {
  outcome?: InboxOutcome;
}

const INBOX_KEY = "console:inbox";
// Preserve the deployed poller's cursor; this is admission, not execution ACK.
const OFFSET_KEY = "poll-offset";
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** A single Host owns this store. Serialize admission, settlement and reads so
 * neither capacity checks nor cursor writes race within that ownership. */
export class Inbox {
  private readonly store: InboxStore;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: {
    store: InboxStore;
    maxEntries?: number;
    maxBytes?: number;
  }) {
    this.store = options.store;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1
    ) {
      throw new ProtocolError("INBOX_LIMIT", "Invalid inbox capacity");
    }
  }

  admit(input: InboxEntry): Promise<"admitted" | "duplicate"> {
    // Snapshot before entering the queue: a caller must not mutate a queued
    // operation while another admission is awaiting durable storage.
    let entry: InboxEntry;
    try {
      validateIdentity(input.updateId, input.ownerEpoch);
      entry = {
        updateId: input.updateId,
        ownerEpoch: input.ownerEpoch,
        operation: decodeJson(
          encodeJson(input.operation, this.maxBytes),
          this.maxBytes,
        ),
      };
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    return this.serialize(async () => {
      const entries = await this.readEntries();
      const offset = await this.readOffset();
      const existing = entries.find((item) => item.updateId === entry.updateId);
      if (existing) {
        if (
          existing.ownerEpoch !== entry.ownerEpoch ||
          canonical(existing.operation) !== canonical(entry.operation)
        ) {
          throw new ProtocolError(
            "INBOX_CONFLICT",
            "Inbox update identity conflict",
          );
        }
        // A prior entry write may have succeeded while its cursor write failed.
        // It is safe to acknowledge now because the entry is already durable.
        await this.advanceOffset(offset, entry.updateId);
        return "duplicate";
      }
      if (
        entries.filter((item) => item.outcome === undefined).length >=
        this.maxEntries
      ) {
        throw new ProtocolError(
          "INBOX_CAPACITY",
          "Inbox entry capacity exceeded",
        );
      }
      const next = this.compact([...entries, entry]);
      // The first write durably captures the operation. A failed second write
      // leaves a recoverable entry, never an acknowledged but missing operation.
      await this.writeEntries(next);
      await this.advanceOffset(offset, entry.updateId);
      return "admitted";
    });
  }

  pending(): Promise<InboxEntry[]> {
    return this.serialize(async () =>
      (await this.readEntries())
        .filter((entry) => entry.outcome === undefined)
        .map(({ updateId, ownerEpoch, operation }) => ({
          updateId,
          ownerEpoch,
          operation,
        })),
    );
  }

  settle(
    updateId: number,
    ownerEpoch: number,
    outcome: InboxOutcome,
  ): Promise<void> {
    return this.serialize(async () => {
      validateIdentity(updateId, ownerEpoch);
      if (!isOutcome(outcome)) {
        throw new ProtocolError("INVALID_INBOX_ENTRY", "Invalid inbox outcome");
      }
      const entries = await this.readEntries();
      const entry = entries.find((item) => item.updateId === updateId);
      if (!entry)
        throw new ProtocolError("INBOX_UNKNOWN", "Unknown inbox update");
      if (entry.ownerEpoch !== ownerEpoch) {
        throw new ProtocolError("INBOX_CONFLICT", "Inbox owner epoch conflict");
      }
      // Settlement is terminal; a duplicate completion cannot change failed or
      // uncertain records into successful ones (or authorize another execution).
      if (entry.outcome !== undefined) return;
      const next = entries.map((item) =>
        item === entry ? { ...item, outcome } : item,
      );
      await this.writeEntries(this.compact(next));
    });
  }

  offset(): Promise<number> {
    return this.serialize(() => this.readOffset());
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // Rejections belong to the individual caller, not the next queued task.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async readOffset(): Promise<number> {
    const stored = await this.store.get(OFFSET_KEY);
    if (stored === undefined) return 0;
    if (
      typeof stored !== "number" ||
      !Number.isSafeInteger(stored) ||
      stored < 0
    ) {
      throw new ProtocolError(
        "INBOX_CORRUPT",
        "Invalid persisted inbox cursor",
      );
    }
    return stored;
  }

  private async advanceOffset(offset: number, updateId: number): Promise<void> {
    const next = Math.max(offset, updateId + 1);
    if (next !== offset) await this.store.set(OFFSET_KEY, next);
  }

  private async readEntries(): Promise<StoredEntry[]> {
    const stored = await this.store.get(INBOX_KEY);
    if (stored === undefined) return [];
    // Reread and clone after every write: an adapter may reject before OR after
    // persisting, and may retain aliases. Never trust stale in-memory state.
    const value = decodeJson(
      encodeJson(stored, Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
    if (
      !jsonObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.entries)
    ) {
      throw new ProtocolError(
        "INBOX_CORRUPT",
        "Invalid persisted inbox record",
      );
    }
    const entries: StoredEntry[] = [];
    const ids = new Set<number>();
    for (const item of value.entries) {
      if (
        !jsonObject(item) ||
        typeof item.updateId !== "number" ||
        typeof item.ownerEpoch !== "number" ||
        !Object.hasOwn(item, "operation") ||
        item.operation === undefined ||
        (item.outcome !== undefined && !isOutcome(item.outcome))
      ) {
        throw new ProtocolError(
          "INBOX_CORRUPT",
          "Invalid persisted inbox entry",
        );
      }
      validateIdentity(item.updateId, item.ownerEpoch);
      if (ids.has(item.updateId)) {
        throw new ProtocolError(
          "INBOX_CORRUPT",
          "Duplicate persisted inbox identity",
        );
      }
      ids.add(item.updateId);
      const entry: StoredEntry = {
        updateId: item.updateId,
        ownerEpoch: item.ownerEpoch,
        operation: item.operation,
      };
      if (isOutcome(item.outcome)) entry.outcome = item.outcome;
      entries.push(entry);
    }
    return entries;
  }

  private compact(entries: StoredEntry[]): StoredEntry[] {
    // Keep a separate bounded settled window, so completion frees unresolved
    // capacity without immediately forgetting redelivery identity. Under byte
    // pressure evict oldest settled entries only, never unfinished operations.
    const settled = entries.filter((entry) => entry.outcome !== undefined);
    const evicted = new Set(
      settled.slice(0, Math.max(0, settled.length - this.maxEntries)),
    );
    let next = entries.filter((entry) => !evicted.has(entry));
    while (this.snapshotBytes(next) > this.maxBytes) {
      const oldest = next.find((entry) => entry.outcome !== undefined);
      if (!oldest) {
        throw new ProtocolError(
          "INBOX_CAPACITY",
          "Inbox byte capacity exceeded",
        );
      }
      next = next.filter((entry) => entry !== oldest);
    }
    return next;
  }

  private snapshotBytes(entries: StoredEntry[]): number {
    return Buffer.byteLength(
      encodeJson(this.snapshot(entries), Number.MAX_SAFE_INTEGER),
      "utf8",
    );
  }

  private snapshot(entries: StoredEntry[]): JsonValue {
    return {
      version: 1,
      entries: entries.map((entry) => {
        const value: { [key: string]: JsonValue } = {
          updateId: entry.updateId,
          ownerEpoch: entry.ownerEpoch,
          operation: entry.operation,
        };
        if (entry.outcome !== undefined) value.outcome = entry.outcome;
        return value;
      }),
    };
  }

  private async writeEntries(entries: StoredEntry[]): Promise<void> {
    const snapshot = this.snapshot(entries);
    const text = encodeJson(snapshot, this.maxBytes);
    await this.store.set(INBOX_KEY, decodeJson(text, this.maxBytes));
  }
}

function validateIdentity(updateId: number, ownerEpoch: number): void {
  if (
    !Number.isSafeInteger(updateId) ||
    updateId < 0 ||
    updateId >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 0
  ) {
    throw new ProtocolError("INVALID_INBOX_ENTRY", "Invalid inbox identity");
  }
}

function isOutcome(value: unknown): value is InboxOutcome {
  return value === "completed" || value === "failed" || value === "uncertain";
}

// Object key insertion order does not change an operation's JSON identity.
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (jsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const item = value[key];
        if (item === undefined)
          throw new ProtocolError(
            "INVALID_JSON_VALUE",
            "Missing JSON property",
          );
        return `${JSON.stringify(key)}:${canonical(item)}`;
      })
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
