import assert from "node:assert/strict";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { ChildSupervisor } from "../../src/host/supervisor.js";
import { launchChild } from "../../src/host/launcher.js";
import { createProcessTransport } from "../../src/protocol/process.js";
import { RpcPeer } from "../../src/protocol/rpc.js";
import { type JsonValue } from "../../src/protocol/json.js";

const DEADLINE = 5_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          DEADLINE,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function track(child: ChildProcess) {
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => {
    child.once("exit", (code, signal) => done({ code, signal }));
    child.once("error", () =>
      done({ code: child.exitCode, signal: child.signalCode }),
    );
  });
  return { child, exit };
}
async function supervised(
  t: TestContext,
  entry: URL,
  progress?: (value: JsonValue) => void,
) {
  const owned: ReturnType<typeof track>[] = [];
  const launch: typeof fork = (
    path: string | URL,
    argsOrOptions?: readonly string[] | ForkOptions,
    options?: ForkOptions,
  ): ChildProcess => {
    assert.ok(Array.isArray(argsOrOptions));
    const child = fork(path, argsOrOptions, options);
    owned.push(track(child));
    return child;
  };
  const supervisor = new ChildSupervisor({
    entry,
    build: "process-isolation-test",
    maxRestarts: 0,
    startupTimeoutMs: 3_000,
    shutdownTimeoutMs: 200,
    terminateTimeoutMs: 200,
    launch,
    handlers: {
      "fixture.progress": async (value) => {
        progress?.(value);
        return null;
      },
    },
  });
  t.after(async () => {
    try {
      await bounded(supervisor.close(), "supervisor cleanup");
    } finally {
      for (const { child } of owned) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      await bounded(
        Promise.all(owned.map(({ exit }) => exit)),
        "reap owned children",
      );
    }
  });
  await bounded(supervisor.start(), "real Node handshake");
  assert.equal(supervisor.state, "running");
  assert.equal(owned.length, 1);
  const worker = owned[0];
  assert.ok(worker?.child.pid);
  assert.equal(supervisor.pid, worker.child.pid);
  assert.notEqual(supervisor.pid, process.pid);
  return { supervisor, worker };
}

test(
  "real Node child timer surrogate advances while Host synchronously blocks its event loop",
  { timeout: 15_000 },
  async (t) => {
    // Electron's executable is supported only in its explicit Node mode. This
    // remains Node-entry evidence, not Desktop plugin activation/UI evidence.
    const progress = deferred<JsonValue>();
    let busy = false;
    let deliveries = 0;
    const { supervisor, worker } = await supervised(
      t,
      new URL("./fixtures/process-progress-worker.js", import.meta.url),
      (value) => {
        assert.equal(
          busy,
          false,
          "Host receives buffered progress only after its busy loop",
        );
        deliveries++;
        progress.resolve(value);
      },
    );
    const peer = supervisor.peer;
    assert.ok(peer);
    // Queue the request without yielding: the worker starts its timers while this
    // Host is blocked, rather than allowing all progress before the busy gate.
    const start = peer.request("fixture.begin", null);
    const began = performance.timeOrigin + performance.now();
    busy = true;
    while (performance.timeOrigin + performance.now() - began < 100) {
      // Deliberately synchronous CPU work, never a sleep/poll-for-process loop.
    }
    const ended = performance.timeOrigin + performance.now();
    busy = false;
    assert.equal(
      deliveries,
      0,
      "Host IPC callbacks could not execute during CPU work",
    );
    await bounded(start, "surrogate begin acknowledgement");
    const report = object(
      await bounded(progress.promise, "buffered child timer progress"),
    );
    assert.equal(report.pid, worker.child.pid);
    assert.equal(report.ppid, process.pid);
    assert.equal(report.runtime, "node");
    assert.equal(report.electron, process.versions.electron ?? null);
    assert.equal(
      report.electronRunAsNode,
      process.versions.electron ? "1" : null,
    );
    assert.equal(report.browserWindow, false);
    assert.ok(Array.isArray(report.ticks));
    const ticks = report.ticks;
    assert.equal(ticks.length, 5);
    assert.ok(
      ticks.every(
        (tick: unknown) =>
          typeof tick === "number" && tick >= began && tick < ended,
      ),
      "all five independent child timer callbacks occurred inside the Host busy window",
    );
    assert.equal(deliveries, 1);
    // This proves process/event-loop isolation for a timer surrogate only. It does
    // not initialize ChildRuntime or exercise Telegram polling/admission/delivery.
  },
);

test(
  "real uninitialized ChildRuntime entry exits on parent IPC disconnect",
  { timeout: 15_000 },
  async (t) => {
    // Direct real launch avoids ChildSupervisor's simultaneous SIGTERM on lost
    // IPC, so code 0 here specifically exercises the child entry's own lifecycle.
    const worker = track(
      launchChild({
        entry: new URL("../../src/child/index.js", import.meta.url),
        generation: "disconnect-lifecycle",
        build: "process-isolation-test",
      }),
    );
    const hello = deferred<void>();
    const transport = createProcessTransport(worker.child);
    const peer = new RpcPeer({
      transport: {
        ...transport,
        send: async (message) => {
          await transport.send(message);
          if (object(message).type === "result") hello.resolve();
        },
      },
      generation: "disconnect-lifecycle",
      handlers: {
        "runtime.hello": async (value) => {
          const report = object(value);
          assert.equal(report.pid, worker.child.pid);
          assert.notEqual(report.pid, process.pid);
          assert.equal(report.runtime, "node");
          assert.equal(report.version, 1);
          assert.equal(report.build, "process-isolation-test");
          return { generation: "disconnect-lifecycle" };
        },
      },
    });
    t.after(async () => {
      try {
        if (worker.child.exitCode === null && worker.child.signalCode === null)
          worker.child.kill("SIGKILL");
        await bounded(worker.exit, "reap direct child");
      } finally {
        peer.close();
      }
    });
    await bounded(hello.promise, "real child hello before disconnect");
    // No initialize request/token: lifecycle evidence, not a running Telegram bot.
    worker.child.disconnect();
    const result = await bounded(
      worker.exit,
      "real child exit after IPC disconnect",
    );
    assert.equal(result.code, 0);
    assert.equal(
      result.signal,
      null,
      "runtime disconnect path exits without supervisor termination",
    );
  },
);

test(
  "real uninitialized child releases its lifetime pipe after intermediate parent SIGKILL",
  { timeout: 20_000 },
  async (t) => {
    // Runs the actual Node entry (including Electron's explicit Node mode when
    // that is the current executable), never Desktop activation or Telegram.
    const parent = fork(
      new URL("./fixtures/process-parent.js", import.meta.url),
      [],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
      },
    );
    const owned = track(parent);
    const ready = deferred<unknown>();
    const onMessage = (value: unknown) => ready.resolve(value);
    parent.once("message", onMessage);
    const witness = parent.stdio[4];
    assert.ok(witness instanceof Readable);
    let ended = false;
    const eof = new Promise<void>((done, reject) => {
      witness.once("end", () => {
        ended = true;
        done();
      });
      witness.once("error", reject);
    });
    // Consume the pipe so EOF is delivered. Neither process writes fixture bytes.
    witness.resume();
    let workerPid: number | undefined;
    t.after(async () => {
      parent.removeListener("message", onMessage);
      try {
        if (parent.exitCode === null && parent.signalCode === null)
          parent.kill("SIGKILL");
        await bounded(owned.exit, "reap intermediate parent");
        if (!ended && workerPid !== undefined) {
          // Only the PID reported by our one actual supervised launch is eligible.
          // An open inherited witness still identifies its live lifetime; never
          // probe/kill an arbitrary discovered PID or process group.
          try {
            process.kill(workerPid, "SIGKILL");
          } catch (error: unknown) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            ))
              throw error;
          }
        }
        await bounded(eof, "release inherited worker lifetime pipe");
      } finally {
        witness.destroy();
      }
    });
    const report = object(
      await bounded(
        ready.promise,
        "actual child handshake in intermediate parent",
      ),
    );
    assert.equal(report.type, "ready");
    assert.equal(report.state, "running");
    assert.equal(report.parentPid, parent.pid);
    assert.ok(
      typeof report.workerPid === "number" &&
        Number.isSafeInteger(report.workerPid) &&
        report.workerPid > 0,
    );
    workerPid = report.workerPid;
    assert.notEqual(workerPid, parent.pid);
    assert.notEqual(workerPid, process.pid);
    assert.equal(ended, false, "worker lifetime pipe is open after handshake");
    assert.equal(parent.kill("SIGKILL"), true);
    assert.deepEqual(await bounded(owned.exit, "intermediate parent SIGKILL"), {
      code: null,
      signal: "SIGKILL",
    });
    // Both parent and real child hold this FD; parent exit alone cannot produce
    // EOF. The real child entry must exit on its now-disconnected private IPC.
    await bounded(eof, "real worker exit after parent death (no orphan)");
    assert.equal(ended, true);
  },
);
