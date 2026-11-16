import {
  encodeJson,
  jsonObject,
  ProtocolError,
  type JsonValue,
} from "../protocol/json.js";

export interface JsonStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
}
export interface Operation {
  id: string;
  ownerEpoch: number;
  kind: string;
  replay: "idempotent" | "never";
}

/** This journal does not turn a remote side effect into an exactly-once operation.
 * A running create on recovery is uncertain, not permission to create again. */
export class OperationJournal {
  private readonly running = new Map<
    string,
    { fingerprint: string; result: Promise<JsonValue> }
  >();
  constructor(private readonly options: { store: JsonStore }) {}

  execute(
    operation: Operation,
    task: () => Promise<JsonValue>,
  ): Promise<JsonValue> {
    const fingerprint = encodeJson({
      ownerEpoch: operation.ownerEpoch,
      kind: operation.kind,
      replay: operation.replay,
    });
    const existing = this.running.get(operation.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(
          new ProtocolError(
            "OPERATION_CONFLICT",
            "Operation identity conflict",
          ),
        );
      return existing.result;
    }
    const result = this.perform(operation, fingerprint, task).finally(() => {
      if (this.running.get(operation.id)?.result === result)
        this.running.delete(operation.id);
    });
    this.running.set(operation.id, { fingerprint, result });
    return result;
  }

  private async perform(
    operation: Operation,
    fingerprint: string,
    task: () => Promise<JsonValue>,
  ): Promise<JsonValue> {
    if (
      !operation.id ||
      operation.id.length > 512 ||
      !Number.isSafeInteger(operation.ownerEpoch)
    ) {
      throw new ProtocolError(
        "INVALID_OPERATION",
        "Invalid operation identity",
      );
    }
    const key = `console:operation:${operation.id}`;
    const stored = await this.options.store.get(key);
    if (stored !== undefined) {
      if (!jsonObject(stored) || stored.fingerprint !== fingerprint) {
        throw new ProtocolError(
          "OPERATION_CONFLICT",
          "Operation kind or owner epoch conflict",
        );
      }
      if (stored.state === "complete" && Object.hasOwn(stored, "result"))
        return stored.result ?? null;
      if (operation.replay === "never")
        throw new ProtocolError(
          "OPERATION_UNCERTAIN",
          "Operation outcome is uncertain; automatic replay suppressed",
        );
    }
    await this.options.store.set(key, { fingerprint, state: "running" });
    const value = await task();
    // Validate before durable serialization. No unchecked Host object or Buffer
    // can become an apparently replayable operation result.
    encodeJson(value);
    await this.options.store.set(key, {
      fingerprint,
      state: "complete",
      result: value,
    });
    return value;
  }
}
