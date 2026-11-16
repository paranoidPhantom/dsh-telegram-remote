import path from "node:path";
import type { TouchedFileSystem } from "./touched-files.js";
import type { ResourceRegistry } from "../host/resources.js";
import type { JsonValue } from "../protocol/json.js";

export interface ArtifactFileSystem<Handle> extends TouchedFileSystem<Handle> {
  processPath(target: Handle): string;
}
export interface ArtifactAgent<Handle> {
  id: string;
  session: { id: string };
  ctx: { get(name: "fs"): ArtifactFileSystem<Handle> | undefined | null };
}
export interface ArtifactContext<Handle> {
  fs: ArtifactFileSystem<Handle>;
  workingDirectory: { get(session: { id: string }): string };
}
/** Only a bounded child operation, never the complete peer or Host context. */
export interface ArtifactDispatch {
  request(
    method: string,
    payload: Record<string, JsonValue>,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue>;
}
export interface SendFileTool<Handle = string> {
  name: string;
  description: string;
  parameters: JsonValue;
  output: {
    schema: JsonValue;
    render(
      args: unknown,
      value: { path: string; messageId: number },
    ): { type: "text"; text: string }[];
  };
  execute(
    args: { path: string; caption?: string },
    exec: { agent?: ArtifactAgent<Handle>; signal?: AbortSignal },
  ): Promise<{ path: string; messageId: number }>;
}
export interface ArtifactDependencies {
  resources: ResourceRegistry;
  generation: string;
  ownerEpoch: number;
  dispatch: ArtifactDispatch;
  surface: {
    getTopic(
      id: string,
    ): Promise<{ chatId: number; threadId: number } | undefined | null>;
  };
}
export function registerSendFile<Handle, Registration>(
  ctx: ArtifactContext<Handle> & {
    tools: { register(tool: SendFileTool<Handle>): Registration };
  },
  deps: ArtifactDependencies,
): Registration {
  return ctx.tools.register({
    name: "send_file",
    description:
      "Send a finished result file to the user in this session’s Telegram topic. Returns its path and Telegram message ID.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path inside the session workspace; relative paths use its working directory.",
        },
        caption: {
          type: "string",
          description: "Optional short explanation of the result.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { path: { type: "string" }, messageId: { type: "number" } },
        required: ["path", "messageId"],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: "text",
          text: `Sent ${value.path} to Telegram (message ${value.messageId}).`,
        },
      ],
    },
    async execute(args, exec) {
      if (!exec.agent) throw Error("A session is required.");
      const topic = await deps.surface.getTopic(exec.agent.id);
      if (!topic) throw Error("This session has no connected Telegram topic.");
      if (
        typeof args.path !== "string" ||
        !args.path ||
        args.path.includes("\0")
      )
        throw Error("A valid file path is required.");
      const fs = exec.agent.ctx.get("fs") ?? ctx.fs,
        cwd = ctx.workingDirectory.get(exec.agent.session);
      exec.signal?.throwIfAborted();
      const root = await fs.resolve(cwd, { signal: exec.signal }),
        target = await fs.resolve(args.path, { cwd, signal: exec.signal });
      if (!fs.contains(root, target))
        throw Error("File must be inside the session workspace.");
      const info = await fs.stat(target, exec.signal);
      if (!info || info.type !== "file")
        throw Error("Result must be a regular file.");
      if (info.size > 10 * 1024 * 1024)
        throw Error("Result exceeds the 10 MiB limit.");
      const bytes = Buffer.from(
        await fs.readBytes(target, exec.signal, 10 * 1024 * 1024),
      );
      exec.signal?.throwIfAborted();
      if (bytes.length > 10 * 1024 * 1024)
        throw Error("Result exceeds the 10 MiB limit.");
      const relative = path.relative(
        fs.processPath(root),
        fs.processPath(target),
      );
      const descriptor = deps.resources.add({
        generation: deps.generation,
        ownerEpoch: deps.ownerEpoch,
        name: path.basename(relative),
        bytes,
      });
      try {
        const result = await deps.dispatch.request(
          "files.send",
          {
            descriptor: { ...descriptor },
            chatId: topic.chatId,
            threadId: topic.threadId,
            caption: [args.caption, relative]
              .filter(Boolean)
              .join("\n")
              .slice(0, 1024),
          },
          { signal: exec.signal },
        );
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          typeof result.message_id !== "number" ||
          !Number.isSafeInteger(result.message_id)
        )
          throw Error("Invalid file delivery receipt.");
        return { path: relative, messageId: result.message_id };
      } finally {
        deps.resources.release(descriptor.id);
      }
    },
  });
}
