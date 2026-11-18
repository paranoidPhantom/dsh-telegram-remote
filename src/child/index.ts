import { pathToFileURL } from "node:url";
import { createProcessTransport } from "../protocol/process.js";
import { RpcPeer } from "../protocol/rpc.js";
import { ChildRuntime } from "./runtime.js";

export function parseChildArguments(argv: readonly string[]): {
  generation: string;
  build: string;
} {
  function argument(name: string): string {
    const matches = argv
      .map((value, index) => ({ value, index }))
      .filter(
        (item) => item.value === name || item.value.startsWith(`${name}=`),
      );
    const match = matches[0];
    if (matches.length !== 1 || !match)
      throw new Error(`Missing or invalid ${name}`);
    const value =
      match.value === name
        ? argv[match.index + 1]
        : match.value.slice(name.length + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`Missing or invalid ${name}`);
    return value;
  }
  return {
    generation: argument("--telegram-generation"),
    build: argument("--telegram-build"),
  };
}

export async function startChild(): Promise<void> {
  const { generation, build } = parseChildArguments(process.argv.slice(2));
  const transport = createProcessTransport(process);
  let runtime: ChildRuntime | undefined;
  const handlers: ConstructorParameters<typeof RpcPeer>[0]["handlers"] = {};
  const methods = [
    "runtime.initialize",
    "runtime.diagnostics",
    "runtime.shutdown",
    "settings.update",
    "run.push",
    "run.chunk",
    "run.chunk.commit",
    "session.refresh",
    "approval.request",
    "approval.cancel",
    "files.send",
    "widget.publish",
  ];
  for (const method of methods)
    handlers[method] = async (payload, signal) => {
      const handler = runtime?.handlers[method];
      if (!handler) throw new Error("Child runtime unavailable");
      const result = await handler(payload, signal);
      if (method === "runtime.shutdown")
        setImmediate(() => {
          if (process.connected) process.disconnect?.();
          exit();
        });
      return result;
    };
  const peer = new RpcPeer({
    transport,
    generation,
    handlers,
    onHandlerError: (method, error) =>
      runtime?.reportHandlerError(method, error),
  });
  runtime = new ChildRuntime({ peer, generation, build });
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    const force = setTimeout(() => process.exit(1), 1500);
    void runtime.shutdown().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  transport.onClose(exit);
  try {
    await peer.request("runtime.hello", {
      version: 1,
      build,
      runtime: "node",
      pid: process.pid,
    });
  } catch (error: unknown) {
    await runtime.shutdown();
    peer.close();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startChild().catch(() => {
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  });
}
