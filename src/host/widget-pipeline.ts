import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ArtifactAgent,
  ArtifactContext,
  ArtifactDependencies,
  ArtifactFileSystem,
} from "../files/send-file.js";

interface WidgetScope<Handle> {
  fs: ArtifactFileSystem<Handle>;
  cwd: string;
  root: Handle;
  signal?: AbortSignal;
  prefix: string;
}
/** Activation-local capabilities. Virtual paths never authorize native child opens. */
export class WidgetResourceAccess<Handle> {
  private readonly scopes = new Map<string, WidgetScope<Handle>>();
  async add(input: {
    fs: ArtifactFileSystem<Handle>;
    cwd: string;
    source: string;
    signal?: AbortSignal;
  }) {
    input.signal?.throwIfAborted();
    if (this.scopes.size >= 64)
      throw Error("Widget capability capacity exceeded");
    const root = await input.fs.resolve(input.cwd, { signal: input.signal });
    const source = await input.fs.resolve(input.source, {
      cwd: input.cwd,
      signal: input.signal,
    });
    if (!input.fs.contains(root, source))
      throw Error("Widget must be inside its session workspace");
    const id = randomBytes(24).toString("base64url"),
      prefix = `/widget-resources/${id}`;
    const relative = path.relative(
      input.fs.processPath(root),
      input.fs.processPath(source),
    );
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Widget must be inside its session workspace");
    this.scopes.set(id, { ...input, root, prefix });
    return {
      id,
      rootDir: prefix,
      filePath: path.posix.join(prefix, relative.split(path.sep).join("/")),
    };
  }
  private scope(id: string) {
    const scope = this.scopes.get(id);
    if (!scope) throw Error("Widget capability unavailable");
    scope.signal?.throwIfAborted();
    return scope;
  }
  private async resolve(id: string, value: string, signal?: AbortSignal) {
    const scope = this.scope(id);
    signal?.throwIfAborted();
    const virtual = value.startsWith("file:") ? fileURLToPath(value) : value;
    const normalized = path.posix.normalize(virtual);
    if (!normalized.startsWith(scope.prefix + "/"))
      throw Error("Resource is outside widget capability workspace");
    const relative = normalized.slice(scope.prefix.length + 1);
    const target = await scope.fs.resolve(relative, {
      cwd: scope.cwd,
      signal: scope.signal,
    });
    if (!scope.fs.contains(scope.root, target))
      throw Error("Resource is outside widget workspace");
    return { scope, target };
  }
  async canonicalize(id: string, value: string): Promise<string> {
    const { scope, target } = await this.resolve(id, value);
    const relative = path.relative(
      scope.fs.processPath(scope.root),
      scope.fs.processPath(target),
    );
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Resource is outside widget workspace");
    return path.posix.join(scope.prefix, relative.split(path.sep).join("/"));
  }
  async read(
    id: string,
    value: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 10 * 1024 * 1024
    )
      throw Error("Invalid widget resource limit");
    const { scope, target } = await this.resolve(id, value, signal);
    const combined =
      scope.signal && signal
        ? AbortSignal.any([scope.signal, signal])
        : (scope.signal ?? signal);
    const stat = await scope.fs.stat(target, combined);
    if (!stat || stat.type !== "file" || stat.size > maxBytes)
      throw Error("Widget resource must be a bounded regular file");
    const bytes = Buffer.from(
      await scope.fs.readBytes(target, combined, maxBytes),
    );
    combined?.throwIfAborted();
    if (bytes.length > maxBytes) throw Error("Widget resource exceeds limit");
    return bytes;
  }
  release(id: string) {
    this.scopes.delete(id);
  }
  close() {
    this.scopes.clear();
  }
}

/** Invoked by the Host's successful-write listener; compilation and fallback stay in child. */
export function createWidgetPipeline<Handle>(
  options: ArtifactDependencies & {
    ctx: ArtifactContext<Handle>;
    widgetResources: WidgetResourceAccess<Handle>;
    signal?: AbortSignal;
  },
) {
  return async function publishWidget(
    agent: ArtifactAgent<Handle>,
    source: string,
  ): Promise<void> {
    const topic = await options.surface.getTopic(agent.id);
    if (!topic) return;
    const fs = agent.ctx.get("fs") ?? options.ctx.fs,
      cwd = options.ctx.workingDirectory.get(agent.session);
    const cap = await options.widgetResources.add({
      fs,
      cwd,
      source,
      signal: options.signal,
    });
    try {
      const raw = await options.widgetResources.read(
        cap.id,
        cap.filePath,
        512 * 1024,
        options.signal,
      );
      const descriptor = options.resources.add({
        generation: options.generation,
        ownerEpoch: options.ownerEpoch,
        name: path.basename(source),
        bytes: raw,
      });
      try {
        await options.dispatch.request(
          "widget.publish",
          {
            sessionId: agent.id,
            source: { ...descriptor },
            widgetId: cap.id,
            filePath: cap.filePath,
            rootDir: cap.rootDir,
            chatId: topic.chatId,
            threadId: topic.threadId,
          },
          { signal: options.signal },
        );
      } finally {
        options.resources.release(descriptor.id);
      }
    } finally {
      options.widgetResources.release(cap.id);
    }
  };
}
