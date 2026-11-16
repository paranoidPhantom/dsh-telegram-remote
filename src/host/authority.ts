import type { ConsoleBridge, ModelSelection } from "../bot/contracts.js";
import { encodeJson, ProtocolError, type JsonValue } from "../protocol/json.js";
import { object, string, integer, wireValue } from "../protocol/values.js";
import type { RpcHandler } from "../protocol/rpc.js";
import { OperationJournal, type JsonStore } from "./operations.js";
import type { ApprovalRegistry } from "./approvals.js";
import type { ResourceDescriptor, ResourceRegistry } from "./resources.js";

export interface HostAuthorityOptions {
  bridge: ConsoleBridge;
  store: JsonStore & {
    entries?(): Promise<Iterable<readonly [string, JsonValue]>>;
  };
  credentials: {
    readRecord(
      key: string,
    ): Promise<{ kind: string; key?: string } | null | undefined>;
  };
  credentialKey: string;
  ownerId: number;
  ownerEpoch: number;
  generation: string;
  approvals: ApprovalRegistry;
  resources: ResourceRegistry;
}
interface Actor {
  ownerId: number;
  chatId: number;
  threadId: number;
  privateChat: true;
}
type Params = Record<string, JsonValue>;
function deny(): never {
  throw new ProtocolError("AUTHORITY_DENIED", "Host authority denied");
}

/** The sole child-to-Host capability boundary. Transport generation is additionally
 * enforced by RpcPeer; closing this service fences retained handler references. */
export class HostAuthority {
  private closed = false;
  private readonly created = new Set<string>();
  private ownerId: number;
  private ownerEpoch: number;
  private generation: string;
  private readonly journal: OperationJournal;
  constructor(private readonly options: HostAuthorityOptions) {
    this.ownerId = options.ownerId;
    this.ownerEpoch = options.ownerEpoch;
    this.generation = options.generation;
    this.journal = new OperationJournal({ store: options.store });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.created.clear();
    this.options.approvals.cancelEpoch(this.ownerEpoch);
    this.options.resources.revokeGeneration(this.generation);
  }
  setOwner(input: {
    ownerId: number;
    ownerEpoch: number;
    generation?: string;
  }): void {
    if (input.ownerEpoch !== this.ownerEpoch)
      this.options.approvals.revokeEpoch(this.ownerEpoch);
    this.close();
    this.ownerId = input.ownerId;
    this.ownerEpoch = input.ownerEpoch;
    this.generation = input.generation ?? this.generation;
    this.closed = false;
  }
  private fence(p: Params): void {
    if (this.closed || this.ownerId <= 0 || p.ownerEpoch !== this.ownerEpoch)
      deny();
  }
  private actor(p: Params): Actor {
    this.fence(p);
    const a = object(p.actor ?? null);
    const ownerId = integer(a.ownerId, "ownerId"),
      chatId = integer(a.chatId, "chatId"),
      threadId = integer(a.threadId, "threadId");
    if (
      ownerId !== this.ownerId ||
      chatId !== this.ownerId ||
      a.privateChat !== true ||
      threadId < 0
    )
      deny();
    return { ownerId, chatId, threadId, privateChat: true };
  }
  private async bound(p: Params, actor: Actor, id: string): Promise<void> {
    const stored = await this.options.store.get(`console:topic:${id}`);
    this.fence(p);
    const mapping = object(stored ?? null);
    if (
      mapping.chatId !== actor.chatId ||
      mapping.threadId !== actor.threadId ||
      mapping.closed === true ||
      mapping.deleted === true ||
      mapping.topicClosed === true
    )
      deny();
  }
  handlers(): Record<string, RpcHandler> {
    const handlers: Record<string, RpcHandler> = {};
    const add = (name: string, run: (p: Params) => Promise<JsonValue>) => {
      handlers[name] = async (payload, signal) => {
        if (signal.aborted) deny();
        const p = object(payload);
        this.fence(p);
        return run(p);
      };
    };
    const bridge = this.options.bridge;
    for (const name of ["list", "models"] as const)
      add(`bridge.${name}`, async (p) => {
        this.actor(p);
        return wireValue(await bridge[name]());
      });
    add("bridge.newSessionSelection", async (p) => {
      const actor = this.actor(p);
      const source =
        p.source === undefined ? undefined : string(p.source, "source");
      if (source) await this.bound(p, actor, source);
      return wireValue(await bridge.newSessionSelection(source));
    });
    add("bridge.create", async (p) => {
      this.actor(p);
      if (p.confirmed !== true) deny();
      const id = await this.journal.execute(
        {
          id: string(p.operationId, "operationId"),
          ownerEpoch: this.ownerEpoch,
          kind: "create",
          replay: "never",
        },
        async () => {
          this.fence(p);
          return bridge.create();
        },
      );
      this.fence(p);
      this.created.add(string(id, "created session"));
      return id;
    });
    for (const name of [
      "metadata",
      "details",
      "files",
      "fileForTurn",
      "selectModel",
      "prompt",
      "steerQueued",
      "stop",
    ] as const)
      add(`bridge.${name}`, async (p) => {
        const actor = this.actor(p),
          id = string(p.id, "id");
        if (name === "metadata") return wireValue(await bridge.metadata(id));
        if (name !== "selectModel" || !this.created.has(id))
          await this.bound(p, actor, id);
        if (name === "details") return bridge.details(id);
        const resource = (file: {
          name: string;
          content: Uint8Array;
        }): JsonValue => {
          this.fence(p);
          return wireValue(
            this.options.resources.add({
              generation: this.generation,
              ownerEpoch: this.ownerEpoch,
              name: file.name,
              bytes: Buffer.from(file.content),
            }),
          );
        };
        if (name === "files") {
          const allocated: ResourceDescriptor[] = [];
          try {
            for (const file of await bridge.files(id)) {
              this.fence(p);
              allocated.push(
                this.options.resources.add({
                  generation: this.generation,
                  ownerEpoch: this.ownerEpoch,
                  name: file.name,
                  bytes: Buffer.from(file.content),
                }),
              );
            }
            return wireValue(allocated);
          } catch (error) {
            for (const descriptor of allocated)
              this.options.resources.release(descriptor.id);
            throw error;
          }
        }
        if (name === "fileForTurn") {
          const turn = p.turn;
          if (
            typeof turn !== "string" &&
            (typeof turn !== "number" || !Number.isSafeInteger(turn))
          )
            deny();
          return resource(
            await bridge.fileForTurn(id, turn, string(p.path, "path")),
          );
        }
        let selection: ModelSelection | undefined;
        if (name === "selectModel") {
          const s = object(p.selection ?? null);
          selection = {
            provider: string(s.provider, "provider"),
            model: string(s.model, "model"),
          };
          if (s.reasoningEffort !== undefined)
            selection.reasoningEffort = string(
              s.reasoningEffort,
              "reasoningEffort",
            );
        }
        const text = name === "prompt" ? string(p.text, "text") : "";
        const requestId =
          name === "prompt" || name === "steerQueued"
            ? string(p.requestId, "requestId")
            : "";
        const operationId = string(
          p.operationId ?? (name === "prompt" ? requestId : undefined),
          "operationId",
        );
        return this.journal.execute(
          {
            id: operationId,
            ownerEpoch: this.ownerEpoch,
            kind: encodeJson({
              name,
              id,
              text,
              requestId,
              selection: selection ? wireValue(selection) : null,
            }),
            replay: name === "prompt" ? "idempotent" : "never",
          },
          async () => {
            if (name !== "selectModel" || !this.created.has(id))
              await this.bound(p, actor, id);
            else this.fence(p);
            if (name === "selectModel" && selection)
              return wireValue(await bridge.selectModel(id, selection));
            if (name === "prompt")
              return wireValue(await bridge.prompt(id, text, requestId));
            if (name === "steerQueued")
              return wireValue(await bridge.steerQueued(id, requestId));
            return wireValue(await bridge.stop(id));
          },
        );
      });
    add("credentials.read", async (p) => {
      if (p.generation !== this.generation) deny();
      let record: { kind: string; key?: string } | null | undefined;
      try {
        record = await this.options.credentials.readRecord(
          this.options.credentialKey,
        );
      } catch {
        throw new ProtocolError(
          "CREDENTIAL_UNAVAILABLE",
          "Credential unavailable",
        );
      }
      this.fence(p);
      if (p.generation !== this.generation) deny();
      if (record?.kind !== "api-key" || !record.key)
        throw new ProtocolError(
          "CREDENTIAL_UNAVAILABLE",
          "Credential unavailable",
        );
      return { token: record.key };
    });
    add("resources.read", async (p) => {
      if (p.generation !== this.generation) deny();
      return wireValue(
        this.options.resources.read({
          id: string(p.id, "id"),
          generation: this.generation,
          ownerEpoch: this.ownerEpoch,
          offset: integer(p.offset, "offset"),
          length: integer(p.length, "length"),
        }),
      );
    });
    add("resources.release", async (p) => {
      if (p.generation !== this.generation) deny();
      const id = string(p.id, "id");
      this.options.resources.read({
        id,
        generation: this.generation,
        ownerEpoch: this.ownerEpoch,
        offset: 0,
        length: 1,
      });
      this.options.resources.release(id);
      return null;
    });
    add("approvals.decide", async (p) => {
      const actor = this.actor(p),
        sessionId = string(p.sessionId, "sessionId");
      await this.bound(p, actor, sessionId);
      const outcome = p.outcome;
      if (outcome !== "allowed-once" && outcome !== "rejected") deny();
      return this.options.approvals.decide({
        ...actor,
        ownerEpoch: this.ownerEpoch,
        id: string(p.id, "id"),
        sessionId,
        callId: string(p.callId, "callId"),
        outcome,
      });
    });
    add("approvals.reason", async (p) => {
      const actor = this.actor(p),
        sessionId = string(p.sessionId, "sessionId");
      await this.bound(p, actor, sessionId);
      return this.options.approvals.reason({
        ...actor,
        ownerEpoch: this.ownerEpoch,
        id: string(p.id, "id"),
        sessionId,
        callId: string(p.callId, "callId"),
        reason: string(p.reason, "reason"),
      });
    });
    add("storage.namespace", (p) => this.storage(p));
    return handlers;
  }
  private async storage(p: Params): Promise<JsonValue> {
    this.fence(p);
    if (p.generation !== this.generation) deny();
    if (p.actor !== undefined) this.actor(p);
    const ns = string(p.namespace, "namespace"),
      action = string(p.action, "action");
    const prefixes: Record<string, string> = {
      topic: "console:topic:",
      run: "console:run:",
      controls: "console:controls:",
      widget: "widget:",
      poll: "poll-offset",
    };
    const prefix = prefixes[ns];
    if (!prefix) deny();
    if (action === "entries") {
      if (!this.options.store.entries) return [];
      const result: JsonValue[] = [];
      for (const [key, value] of await this.options.store.entries()) {
        if (key.startsWith(prefix) && ns !== "poll") {
          if (!this.storageOwned(ns, key, value)) continue;
          result.push([key, value]);
        }
      }
      this.fence(p);
      return result;
    }
    const key = string(p.key, "key");
    if (
      ns === "poll"
        ? key !== prefix
        : !key.startsWith(prefix) || key.length === prefix.length
    )
      deny();
    if (action === "get") {
      const result = await this.options.store.get(key);
      this.fence(p);
      if (result !== undefined && !this.storageOwned(ns, key, result)) deny();
      return result ?? null;
    }
    if (
      action !== "set" ||
      p.value === undefined ||
      ns === "poll" ||
      !this.storageOwned(ns, key, p.value)
    )
      deny();
    this.fence(p);
    await this.options.store.set(key, p.value);
    return null;
  }
  private storageOwned(ns: string, key: string, value: JsonValue): boolean {
    if (ns === "poll") return key === "poll-offset";
    if (ns === "topic" || ns === "run") {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
      return (
        value.chatId === this.ownerId &&
        typeof value.threadId === "number" &&
        Number.isSafeInteger(value.threadId) &&
        value.threadId >= 0
      );
    }
    if (ns === "controls") {
      const parts = key.split(":");
      const chat = Number(parts[2]),
        thread = Number(parts[3]);
      return (
        parts.length === 4 &&
        chat === this.ownerId &&
        Number.isSafeInteger(thread) &&
        thread >= 0
      );
    }
    if (ns === "widget") {
      try {
        const tuple: unknown = JSON.parse(key.slice("widget:".length));
        if (!Array.isArray(tuple) || tuple.length !== 3) return false;
        const chat: unknown = tuple[0],
          thread: unknown = tuple[1],
          name: unknown = tuple[2];
        return (
          chat === String(this.ownerId) &&
          (thread === null ||
            (typeof thread === "string" && /^\d+$/.test(thread))) &&
          typeof name === "string"
        );
      } catch {
        return false;
      }
    }
    return false;
  }
}
