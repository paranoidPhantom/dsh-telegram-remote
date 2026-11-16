import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { ChildSupervisor } from "../../../src/host/supervisor.js";

// FD 4 is a lifetime witness pipe held by this process and its single worker.
// The outer test observes EOF after SIGKILL without polling/signalling a PID.
const launch: typeof fork = (
  entry: string | URL,
  argsOrOptions?: readonly string[] | ForkOptions,
  options?: ForkOptions,
): ChildProcess => {
  if (!Array.isArray(argsOrOptions)) throw new Error("Expected launcher args");
  return fork(entry, argsOrOptions, {
    ...options,
    stdio: ["ignore", "ignore", "ignore", "ipc", 4],
  });
};
const supervisor = new ChildSupervisor({
  entry: new URL("../../../src/child/index.js", import.meta.url),
  build: "process-parent-death-test",
  maxRestarts: 0,
  launch,
  startupTimeoutMs: 3_000,
  shutdownTimeoutMs: 200,
  terminateTimeoutMs: 200,
});
process.once("disconnect", () => {
  void supervisor.close().finally(() => process.exit(0));
});
try {
  await supervisor.start();
  if (!process.send) throw new Error("Missing outer IPC");
  process.send({
    type: "ready",
    parentPid: process.pid,
    workerPid: supervisor.pid,
    state: supervisor.state,
  });
} catch {
  await supervisor.close();
  process.exit(1);
}
