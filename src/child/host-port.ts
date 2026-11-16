import { z } from "zod";
import type {
  ConsoleBridge,
  ConsoleFile,
  ConsoleStore,
} from "../bot/contracts.js";
import { decodeJson, encodeJson, type JsonValue } from "../protocol/json.js";
import type { RpcPeer } from "../protocol/rpc.js";

export interface ActorOperationScope {
  ownerId: number;
  chatId: number;
  threadId: number;
  privateChat: boolean;
  operationId: string;
}
export interface HostPortOptions {
  peer: Pick<RpcPeer, "request">;
  generation: string;
  ownerEpoch: number;
  scope?: () => ActorOperationScope | undefined;
  signal?: AbortSignal;
}
const selection = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});
const label = z
  .union([
    z.string(),
    z.object({
      name: z.string().optional(),
      model: z.string().optional(),
      id: z.string().optional(),
    }),
  ])
  .nullable();
const metadata = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  model: label.optional(),
  activeModel: label.optional(),
  context: z
    .union([
      z.string(),
      z.number(),
      z.object({
        percent: z.number().optional(),
        percentage: z.number().optional(),
        pressureTokens: z.number().optional(),
        contextWindow: z.number().optional(),
      }),
    ])
    .nullable()
    .optional(),
  running: z.boolean().optional(),
  selection: selection.optional(),
  cwd: z.string().optional(),
  turns: z.number().optional(),
  lastActivity: z.number().optional(),
});
const receipt = z.object({
  ok: z.boolean().optional(),
  accepted: z.boolean().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  appliesNextTurn: z.boolean().optional(),
  running: z.boolean().optional(),
  deferred: z.boolean().optional(),
});
const resource = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024),
});
const chunk = z.object({
  data: z.string().max(87384),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  eof: z.boolean(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError("Invalid Host response");
  return result.data;
}
function namespace(key: string): string {
  if (key.startsWith("console:topic:")) return "topic";
  if (key.startsWith("console:run:")) return "run";
  if (key.startsWith("console:controls:")) return "controls";
  if (key.startsWith("widget:")) return "widget";
  if (key === "poll-offset") return "poll";
  throw new TypeError("Forbidden store key");
}
/** Child capability proxy. No Host services, session handles or filesystem access. */
export function createHostPort(options: HostPortOptions) {
  const { peer, generation, ownerEpoch, signal } = options;
  const request = (method: string, payload: unknown, cancellable = true) =>
    peer.request(
      method,
      decodeJson(encodeJson(payload)),
      cancellable && signal ? { signal } : {},
    );
  function context(mutation = false): Record<string, JsonValue> {
    const scope = options.scope?.();
    if (mutation && (!scope || !scope.operationId))
      throw new TypeError("Admitted operation scope required");
    return {
      generation,
      ownerEpoch,
      ...(scope
        ? {
            actor: {
              ownerId: scope.ownerId,
              chatId: scope.chatId,
              threadId: scope.threadId,
              privateChat: scope.privateChat,
            },
            ...(mutation ? { operationId: scope.operationId } : {}),
          }
        : {}),
    };
  }
  const call = (
    method: string,
    params: Record<string, JsonValue> = {},
    mutation = false,
  ) => {
    const scoped = context(mutation);
    if (mutation) {
      const base = scoped.operationId;
      if (typeof base !== "string")
        throw new TypeError("Admitted operation scope required");
      if (method === "prompt" && typeof params.requestId === "string")
        scoped.operationId = params.requestId;
      else if (method === "create") scoped.operationId = `${base}:create`;
      else if (method === "selectModel")
        scoped.operationId = `${base}:select:${String(params.id)}`;
      else if (method === "steerQueued")
        scoped.operationId = `${base}:steer:${JSON.stringify([params.id, params.requestId])}`;
      else scoped.operationId = `${base}:${method}:${String(params.id)}`;
    }
    return request(`bridge.${method}`, { ...scoped, ...params });
  };
  async function download(
    descriptor: z.infer<typeof resource>,
  ): Promise<ConsoleFile> {
    const content = new Uint8Array(descriptor.size);
    const scope = context();
    try {
      let offset = 0;
      while (offset < descriptor.size) {
        signal?.throwIfAborted();
        const length = Math.min(65536, descriptor.size - offset);
        const part = parse(
          chunk,
          await request("resources.read", {
            ...scope,
            generation,
            id: descriptor.id,
            offset,
            length,
          }),
        );
        const bytes = Buffer.from(part.data, "base64");
        if (
          bytes.toString("base64") !== part.data ||
          part.offset !== offset ||
          part.total !== descriptor.size ||
          bytes.length === 0 ||
          bytes.length > length ||
          part.eof !== (offset + bytes.length === descriptor.size)
        )
          throw new TypeError("Invalid resource chunk");
        content.set(bytes, offset);
        offset += bytes.length;
      }
      signal?.throwIfAborted();
      return { name: descriptor.name, content };
    } finally {
      await request(
        "resources.release",
        { ...scope, generation, id: descriptor.id },
        false,
      );
    }
  }
  const bridge: ConsoleBridge = {
    async list() {
      return parse(
        z.array(metadata.extend({ id: z.string() })),
        await call("list"),
      );
    },
    async metadata(id) {
      return parse(metadata.nullable(), await call("metadata", { id }));
    },
    async models() {
      return parse(
        z.array(
          z.object({
            provider: z.string(),
            id: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
            reasoning: z
              .object({
                efforts: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    description: z.string().optional(),
                  }),
                ),
                defaultEffort: z.string().optional(),
              })
              .optional(),
          }),
        ),
        await call("models"),
      );
    },
    async selectModel(id, value) {
      return parse(
        receipt.nullable(),
        await call(
          "selectModel",
          { id, selection: decodeJson(encodeJson(value)) },
          true,
        ),
      );
    },
    async workspaces() {
      return parse(
        z.array(
          z.object({
            id: z.string().min(1),
            title: z.string(),
            path: z.string(),
          }),
        ),
        await call("workspaces"),
      );
    },
    async create(workspaceId) {
      return parse(
        z.string().min(1),
        await call(
          "create",
          {
            confirmed: true,
            ...(workspaceId === undefined ? {} : { workspaceId }),
          },
          true,
        ),
      );
    },
    async newSessionSelection(source) {
      return parse(
        selection.nullable(),
        await call("newSessionSelection", source ? { source } : {}),
      );
    },
    async prompt(id, text, requestId) {
      return call("prompt", { id, text, requestId }, true);
    },
    async stop(id) {
      return call("stop", { id }, true);
    },
    async details(id) {
      return parse(z.string(), await call("details", { id }));
    },
    async files(id) {
      const descriptors = parse(
        z.array(resource).max(64),
        await call("files", { id }),
      );
      const files: ConsoleFile[] = [];
      let next = 0;
      const scope = context();
      try {
        while (next < descriptors.length) {
          const descriptor = descriptors[next++];
          if (descriptor) files.push(await download(descriptor));
        }
        return files;
      } finally {
        const releases = descriptors
          .slice(next)
          .map((descriptor) =>
            request(
              "resources.release",
              { ...scope, generation, id: descriptor.id },
              false,
            ),
          );
        const results = await Promise.allSettled(releases);
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
      }
    },
    async fileForTurn(id, turn, path) {
      return download(
        parse(resource, await call("fileForTurn", { id, turn, path })),
      );
    },
    async steerQueued(id, requestId) {
      return parse(
        z.object({ accepted: z.boolean(), reason: z.string().optional() }),
        await call("steerQueued", { id, requestId }, true),
      );
    },
  };
  const store: ConsoleStore = {
    async get(key) {
      return request("storage.namespace", {
        ...context(),
        generation,
        action: "get",
        namespace: namespace(key),
        key,
      });
    },
    async set(key, value) {
      if (key === "poll-offset") throw new TypeError("Host owns poll offset");
      return request("storage.namespace", {
        ...context(),
        generation,
        action: "set",
        namespace: namespace(key),
        key,
        value: decodeJson(encodeJson(value)),
      });
    },
    async entries() {
      const result: Array<[string, unknown]> = [];
      for (const name of ["topic", "run", "controls", "widget", "poll"]) {
        const rows = parse(
          z.array(z.tuple([z.string(), z.unknown()])),
          await request("storage.namespace", {
            ...context(),
            generation,
            action: "entries",
            namespace: name,
          }),
        );
        for (const [key, value] of rows) {
          if (namespace(key) !== name)
            throw new TypeError("Invalid store key namespace");
          result.push([key, value]);
        }
      }
      return result;
    },
  };
  async function readCredentials(): Promise<{ token: string }> {
    return parse(
      z.object({ token: z.string().min(1) }),
      await request("credentials.read", { generation, ownerEpoch }),
    );
  }
  const credentials = {
    async readRecord(key: string): Promise<{ kind: "api-key"; key: string }> {
      if (key !== "telegram-console/bot")
        throw new TypeError("Forbidden credential record");
      return { kind: "api-key", key: (await readCredentials()).token };
    },
  };
  const downloadResource = (descriptor: unknown): Promise<ConsoleFile> =>
    download(parse(resource, descriptor));
  return { bridge, store, credentials, readCredentials, downloadResource };
}
