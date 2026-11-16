import { appendFileSync } from "node:fs";

// This intentionally speaks the wire format directly: the supervisor suite must
// still exercise real children before the production RpcPeer implementation exists.
type Mode =
  | "cooperative"
  | "stubborn"
  | "wrong-build"
  | "wrong-generation"
  | "wrong-pid"
  | "wrong-runtime"
  | "wrong-version"
  | "no-hello";
interface Configuration {
  mode: Mode;
  generation: string;
  build: string;
  trace: string;
}
interface Envelope {
  version: number;
  generation: string;
  id: string;
  type: string;
  payload: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(value: unknown): value is Envelope {
  return (
    record(value) &&
    typeof value.version === "number" &&
    typeof value.generation === "string" &&
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    "payload" in value
  );
}

const prefix = "--supervisor-test=";
const argument = process.argv.find((value) => value.startsWith(prefix));
if (!argument) throw new Error("Missing supervisor fixture configuration");
const parsed: unknown = JSON.parse(argument.slice(prefix.length));
if (
  !record(parsed) ||
  typeof parsed.mode !== "string" ||
  typeof parsed.generation !== "string" ||
  typeof parsed.build !== "string" ||
  typeof parsed.trace !== "string"
)
  throw new Error("Invalid fixture configuration");
const modes: readonly string[] = [
  "cooperative",
  "stubborn",
  "wrong-build",
  "wrong-generation",
  "wrong-pid",
  "wrong-runtime",
  "wrong-version",
  "no-hello",
];
if (!modes.includes(parsed.mode)) throw new Error("Unknown fixture mode");
const config = parsed as unknown as Configuration;

function trace(event: string): void {
  appendFileSync(
    config.trace,
    `${JSON.stringify({ event, pid: process.pid })}\n`,
  );
}
function send(message: Envelope, flushed?: () => void): void {
  if (!process.connected || !process.send) return;
  process.send(message, (error) => {
    if (error) process.exit(0);
    else flushed?.();
  });
}
function result(
  request: Envelope,
  payload: unknown,
  flushed?: () => void,
): void {
  send(
    {
      version: 1,
      generation: config.generation,
      id: request.id,
      type: "result",
      payload,
    },
    flushed,
  );
}
function exit(): void {
  if (process.connected) process.disconnect?.();
  process.exit(0);
}

// Never create an orphan, including when the supervisor itself is killed.
process.once("disconnect", () => {
  trace("disconnect");
  process.exit(0);
});
process.on("SIGTERM", () => {
  trace("sigterm");
  if (config.mode !== "stubborn") exit();
});
process.on("message", (value: unknown) => {
  if (!envelope(value)) return;
  if (value.id === "fixture-hello" && value.type === "result") {
    if (
      !record(value.payload) ||
      value.payload.generation !== config.generation
    ) {
      trace("bad-hello-result");
      process.exit(2);
    }
    trace("hello-accepted");
    return;
  }
  if (value.type !== "request" || !record(value.payload)) return;
  const method = value.payload.method;
  if (method === "runtime.shutdown") {
    trace("shutdown");
    if (config.mode === "stubborn") return;
    // The send callback flushes the response before disconnecting/exiting.
    result(value, null, exit);
  } else if (method === "fixture.inspect") {
    result(value, {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      entry: import.meta.url,
      execArgv: process.execArgv,
      tokenInherited: "TELEGRAM_BOT_TOKEN" in process.env,
      credentialInherited: "DSH_CREDENTIAL_SECRET" in process.env,
    });
  } else if (method === "fixture.crash") {
    trace("crash");
    process.exit(23);
  } else if (method === "fixture.disconnect") {
    result(value, null, () => process.disconnect?.());
  }
});
trace("boot");
if (config.mode !== "no-hello") {
  send({
    version: config.mode === "wrong-version" ? 2 : 1,
    generation:
      config.mode === "wrong-generation"
        ? `${config.generation}-stale`
        : config.generation,
    id: "fixture-hello",
    type: "request",
    payload: {
      method: "runtime.hello",
      params: {
        version: 1,
        build:
          config.mode === "wrong-build"
            ? `${config.build}-stale`
            : config.build,
        runtime: config.mode === "wrong-runtime" ? "browser" : "node",
        pid: config.mode === "wrong-pid" ? process.ppid : process.pid,
      },
    },
  });
}
