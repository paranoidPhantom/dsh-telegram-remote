import assert from "node:assert/strict";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ChildSupervisor } from "../../src/host/supervisor.js";
import {
  type StartupEvent,
  type StartupObserver,
} from "../../src/protocol/startup.js";

const ENTRY = new URL("./fixtures/supervisor-worker.js", import.meta.url);
const BUILD = "supervisor-contract-test-build";
const GENERATION = "supervisor-contract-generation";
const DEADLINE = 2_500;
const TEST_TIMEOUT = 10_000;
type Mode =
  | "cooperative"
  | "stubborn"
  | "wrong-build"
  | "wrong-generation"
  | "wrong-pid"
  | "wrong-runtime"
  | "wrong-version"
  | "no-hello";

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}
async function bounded<T>(
  promise: Promise<T>,
  label: string,
  timeout = DEADLINE,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
interface OwnedChild {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
interface Options {
  mode?: Mode;
  maxRestarts?: number;
  restartBaseMs?: number;
  alternateCwd?: boolean;
  onStartup?: StartupObserver;
}

async function setup(t: TestContext, options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "supervisor contract space "));
  const trace = join(directory, "worker-events.jsonl");
  const owned: OwnedChild[] = [];
  const launchTimes: number[] = [];
  const offline = deferred<Error>();
  const ready = deferred<void>();
  const readyWaiters: { count: number; resolve: () => void }[] = [];
  const readyEvents: unknown[] = [];
  const offlineEvents: Error[] = [];
  const startupEvents: StartupEvent[] = [];
  let supervisor: ChildSupervisor | undefined;
  let cleaningUp = false;

  // Register before construction/start. Even assertion failures and startup
  // timeouts must kill/reap every real fork made by this test.
  t.after(async () => {
    cleaningUp = true;
    try {
      if (supervisor)
        await bounded(supervisor.close(), "cleanup close", 1_000).catch(
          () => {},
        );
    } finally {
      for (const { child } of owned) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
      await bounded(
        Promise.all(owned.map(({ exit }) => exit)),
        "reap fixture children",
      );
      // This is the exact fresh directory created above, not an inferred path.
      assert.equal(
        resolve(directory).startsWith(
          resolve(tmpdir()) + "/supervisor contract space ",
        ),
        true,
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  const launch: typeof fork = (
    modulePath: string | URL,
    argsOrOptions?: readonly string[] | ForkOptions,
    forkOptions?: ForkOptions,
  ): ChildProcess => {
    assert.equal(cleaningUp, false, "no launch after test cleanup begins");
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const supplied = Array.isArray(argsOrOptions)
      ? forkOptions
      : (argsOrOptions as ForkOptions | undefined);
    const entryPath =
      modulePath instanceof URL ? fileURLToPath(modulePath) : modulePath;
    assert.equal(
      entryPath,
      fileURLToPath(ENTRY),
      "launch must resolve the absolute entry, not cwd",
    );
    assert.deepEqual(
      supplied?.execArgv,
      [],
      "do not leak test/loader/inspector flags",
    );
    assert.equal(supplied?.serialization, "json");
    assert.equal(
      supplied?.detached,
      false,
      "the worker is owned, not a detached daemon",
    );
    assert.equal(supplied?.env?.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(supplied?.env?.DSH_CREDENTIAL_SECRET, undefined);
    for (const previous of owned) {
      assert.ok(
        previous.child.exitCode !== null || previous.child.signalCode !== null,
        "replacement must never launch before the previous owned worker exits",
      );
    }
    launchTimes.push(performance.now());
    const child = fork(
      modulePath,
      [
        ...args,
        `--supervisor-test=${JSON.stringify({
          mode: options.mode ?? "cooperative",
          generation: GENERATION,
          build: BUILD,
          trace,
        })}`,
      ],
      {
        ...supplied,
        ...(options.alternateCwd ? { cwd: directory } : {}),
      },
    );
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    owned.push({ child, exit });
    return child;
  };
  supervisor = new ChildSupervisor({
    entry: ENTRY,
    generation: GENERATION,
    build: BUILD,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 120,
    terminateTimeoutMs: 120,
    maxRestarts: options.maxRestarts ?? 0,
    restartWindowMs: 60_000,
    restartBaseMs: options.restartBaseMs ?? 40,
    launch,
    onStartup: (event) => {
      startupEvents.push(event);
      options.onStartup?.(event);
    },
    onReady: (peer: unknown) => {
      readyEvents.push(peer);
      ready.resolve();
      for (const waiter of readyWaiters) {
        if (readyEvents.length >= waiter.count) waiter.resolve();
      }
    },
    onOffline: (error: Error) => {
      offlineEvents.push(error);
      offline.resolve(error);
    },
  });
  const instance = supervisor;
  const events = async (): Promise<string[]> => {
    const text = await readFile(trace, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value: unknown = JSON.parse(line);
        const event = object(value).event;
        assert.equal(typeof event, "string");
        return event as string;
      });
  };
  const start = async () => {
    await bounded(instance.start(), "valid child hello");
    await bounded(ready.promise, "onReady after hello");
    assert.equal(instance.state, "running");
    assert.ok(instance.peer);
    assert.ok(instance.pid);
  };
  const waitForReady = (count: number): Promise<void> => {
    if (readyEvents.length >= count) return Promise.resolve();
    return new Promise<void>((resolveReady) => {
      readyWaiters.push({ count, resolve: resolveReady });
    });
  };
  return {
    supervisor: instance,
    owned,
    launchTimes,
    offline,
    offlineEvents,
    startupEvents,
    readyEvents,
    events,
    directory,
    start,
    waitForReady,
  };
}

test(
  "supervisor handshakes with a distinct real Node PID using build/generation and an absolute file URL",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { alternateCwd: true });
    assert.equal(h.supervisor.state, "idle");
    assert.equal(h.supervisor.peer, undefined);
    assert.equal(h.supervisor.pid, undefined);
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousCredential = process.env.DSH_CREDENTIAL_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "fixture-only-not-a-telegram-token";
    process.env.DSH_CREDENTIAL_SECRET = "fixture-only-not-a-credential";
    try {
      await h.start();
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
      if (previousCredential === undefined)
        delete process.env.DSH_CREDENTIAL_SECRET;
      else process.env.DSH_CREDENTIAL_SECRET = previousCredential;
    }
    assert.equal(h.owned.length, 1);
    const child = h.owned[0];
    assert.ok(child);
    assert.notEqual(h.supervisor.pid, process.pid);
    assert.equal(h.supervisor.pid, child.child.pid);
    const info = object(
      await bounded(
        h.supervisor.peer!.request("fixture.inspect", null),
        "fixture inspect",
      ),
    );
    assert.equal(info.pid, child.child.pid);
    assert.equal(info.ppid, process.pid);
    assert.equal(
      info.cwd,
      await realpath(h.directory),
      "file URL survives an unrelated cwd containing spaces",
    );
    assert.equal(info.entry, ENTRY.href);
    assert.deepEqual(info.execArgv, []);
    assert.equal(info.tokenInherited, false);
    assert.equal(info.credentialInherited, false);
    assert.equal(h.readyEvents.length, 1);
    assert.equal(h.readyEvents[0], h.supervisor.peer);
    assert.deepEqual(h.offlineEvents, []);
  },
);

test(
  "graceful close awaits worker exit and repeated/concurrent close is idempotent",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await h.start();
    const child = h.owned[0];
    assert.ok(child);
    await bounded(
      Promise.all([h.supervisor.close(), h.supervisor.close()]),
      "concurrent close",
    );
    await bounded(h.supervisor.close(), "repeated close");
    assert.deepEqual(await bounded(child.exit, "graceful child exit"), {
      code: 0,
      signal: null,
    });
    assert.equal(
      child.child.exitCode,
      0,
      "close must wait for exit, not only shutdown acknowledgement",
    );
    assert.deepEqual(await h.events(), ["boot", "hello-accepted", "shutdown"]);
    assert.equal(h.supervisor.state, "closed");
    assert.equal(h.supervisor.peer, undefined);
    assert.equal(h.supervisor.pid, undefined);
    assert.equal(h.owned.length, 1);
    assert.deepEqual(h.offlineEvents, []);
    assert.deepEqual(h.startupEvents.slice(0, 4), [
      { stage: "launch", outcome: "begin" },
      { stage: "launch", outcome: "ok", pid: child.child.pid },
      { stage: "handshake", outcome: "begin" },
      { stage: "handshake", outcome: "ok" },
    ]);
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "shutdown"),
      [
        { stage: "shutdown", outcome: "begin" },
        { stage: "shutdown", outcome: "ok" },
      ],
    );
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "exit"),
      [{ stage: "exit", outcome: "info", exitCode: 0 }],
    );
  },
);

test(
  "uncooperative shutdown escalates through SIGTERM to SIGKILL and reaps the owned worker",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { mode: "stubborn" });
    await h.start();
    const child = h.owned[0];
    assert.ok(child);
    // A request/response gate proves the child installed its signal handlers.
    await bounded(
      h.supervisor.peer!.request("fixture.inspect", null),
      "stubborn worker ready",
    );
    await bounded(h.supervisor.close(), "TERM/KILL close");
    assert.deepEqual(await bounded(child.exit, "killed child exit"), {
      code: null,
      signal: "SIGKILL",
    });
    assert.deepEqual(await h.events(), [
      "boot",
      "hello-accepted",
      "shutdown",
      "sigterm",
    ]);
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "exit"),
      [{ stage: "exit", outcome: "info", signal: "SIGKILL" }],
    );
    assert.equal(child.child.signalCode, "SIGKILL");
    assert.equal(h.supervisor.state, "closed");
    assert.equal(h.supervisor.pid, undefined);
    assert.equal(h.owned.length, 1);
  },
);

for (const mode of [
  "wrong-build",
  "wrong-generation",
  "wrong-pid",
  "wrong-runtime",
  "wrong-version",
  "no-hello",
] as const) {
  test(
    `invalid ${mode} handshake becomes offline without admission, restart, or in-process fallback`,
    { timeout: TEST_TIMEOUT },
    async (t) => {
      const h = await setup(t, { mode, maxRestarts: 2 });
      await assert.rejects(bounded(h.supervisor.start(), `${mode} start`));
      const error = await bounded(h.offline.promise, `${mode} offline`);
      assert.ok(error instanceof Error);
      assert.equal(h.supervisor.state, "offline");
      assert.equal(h.supervisor.peer, undefined);
      assert.deepEqual(h.readyEvents, []);
      assert.equal(
        h.owned.length,
        1,
        "invalid hello must not enter the crash restart loop",
      );
      await bounded(h.supervisor.close(), `${mode} close`);
      await bounded(
        Promise.all(h.owned.map(({ exit }) => exit)),
        `${mode} reap`,
      );
      assert.equal(h.owned.length, 1);
      assert.equal(h.supervisor.pid, undefined);
      assert.deepEqual(
        h.startupEvents.filter((event) => event.stage === "handshake"),
        [
          { stage: "handshake", outcome: "begin" },
          {
            stage: "handshake",
            outcome: "failed",
            code: mode === "no-hello" ? "STARTUP_TIMEOUT" : "INVALID_HELLO",
          },
        ],
      );
    },
  );
}

test(
  "disconnect of the private IPC channel makes the worker exit without an orphan",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await h.start();
    const child = h.owned[0];
    assert.ok(child);
    await bounded(
      h.supervisor.peer!.request("fixture.inspect", null),
      "worker disconnect handler ready",
    );
    // Disconnect the real channel, rather than invoking a synthetic exit event.
    child.child.disconnect();
    assert.deepEqual(await bounded(child.exit, "exit after IPC disconnect"), {
      code: 0,
      signal: null,
    });
    await bounded(h.offline.promise, "disconnect exhausts zero-restart budget");
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "disconnect"),
      [{ stage: "disconnect", outcome: "info" }],
    );
    assert.equal(h.supervisor.state, "offline");
    assert.equal(h.supervisor.peer, undefined);
    assert.equal(h.owned.length, 1);
  },
);

test(
  "unexpected exits consume a finite restart budget and stop offline after two replacements",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { maxRestarts: 2 });
    await h.start();
    const pids = new Set<number>();
    for (let index = 0; index < 3; index++) {
      const owned = h.owned[index];
      assert.ok(owned, `launch ${index + 1}`);
      assert.ok(owned.child.pid);
      pids.add(owned.child.pid);
      const peer = h.supervisor.peer;
      assert.ok(peer);
      await bounded(
        peer.request("fixture.inspect", null),
        "replacement hello gate",
      );
      // onReady gates every replacement; no arbitrary startup sleeps.
      const replacementReady = h.waitForReady(index + 2);
      const crashRequestedAt = performance.now();
      const crash = peer.request("fixture.crash", null).then(
        () => assert.fail("crashed child must not complete the request"),
        () => {},
      );
      await bounded(crash, "crash rejects pending RPC");
      assert.deepEqual(await bounded(owned.exit, "crashed child exit"), {
        code: 23,
        signal: null,
      });
      if (index < 2) {
        await bounded(replacementReady, "replacement becomes ready");
        assert.equal(h.supervisor.state, "running");
        const launchTime = h.launchTimes[index + 1];
        assert.ok(launchTime !== undefined);
        // Allow timer granularity, but reject immediate respawn/busy crash loops.
        assert.ok(
          launchTime - crashRequestedAt >= 40 * 2 ** index - 5,
          "exponential backoff before restart",
        );
      }
    }
    await bounded(h.offline.promise, "restart budget exhausted");
    assert.equal(pids.size, 3);
    assert.equal(h.owned.length, 3, "maxRestarts excludes the original launch");
    assert.equal(h.readyEvents.length, 3);
    assert.equal(h.offlineEvents.length, 1);
    assert.equal(h.supervisor.state, "offline");
    assert.equal(h.supervisor.peer, undefined);
    assert.equal(h.supervisor.pid, undefined);
    await bounded(
      h.supervisor.close(),
      "offline close cancels further restarts",
    );
    assert.equal(h.owned.length, 3);
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "restart"),
      [
        { stage: "restart", outcome: "info", delayMs: 40 },
        { stage: "restart", outcome: "info", delayMs: 80 },
        { stage: "restart", outcome: "failed", code: "RESTART_BUDGET" },
      ],
    );
    assert.equal(
      h.startupEvents.filter(
        (event) => event.stage === "exit" && event.exitCode === 23,
      ).length,
      3,
    );
  },
);

test(
  "explicit recovery fences stale peers and shares crash restart budget and backoff",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { maxRestarts: 2 });
    await h.start();
    const first = h.supervisor.peer!;
    await bounded(first.request("fixture.inspect", null), "first worker gate");
    const recoveryAt = performance.now();
    assert.equal(h.supervisor.recover(first), true);
    assert.equal(h.supervisor.state, "backoff");
    assert.equal(h.supervisor.peer, undefined);
    assert.equal(h.supervisor.recover(first), false, "duplicate is a no-op");
    await assert.rejects(first.request("fixture.inspect", null), {
      code: "CLOSED",
    });
    await bounded(h.owned[0]!.exit, "recovery reaps original");
    await bounded(h.waitForReady(2), "recovery replacement");
    assert.ok(h.launchTimes[1]! - recoveryAt >= 35);
    const second = h.supervisor.peer!;
    assert.notEqual(second, first);
    assert.equal(
      h.supervisor.recover(first),
      false,
      "stale peer cannot kill replacement",
    );
    assert.equal(h.supervisor.peer, second);

    // Mix an actual crash with explicit recovery: neither path resets budget.
    const crashAt = performance.now();
    await assert.rejects(second.request("fixture.crash", null));
    await bounded(h.waitForReady(3), "crash replacement after recovery");
    assert.ok(h.launchTimes[2]! - crashAt >= 75);
    const third = h.supervisor.peer!;
    assert.equal(h.supervisor.recover(third), true);
    await bounded(h.offline.promise, "recovery exhausts shared budget");
    assert.equal(h.supervisor.state, "offline");
    assert.equal(h.supervisor.recover(third), false);
    assert.equal(h.owned.length, 3);
    assert.equal(h.offlineEvents.length, 1);
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "restart"),
      [
        { stage: "restart", outcome: "info", delayMs: 40 },
        { stage: "restart", outcome: "info", delayMs: 80 },
        { stage: "restart", outcome: "failed", code: "RESTART_BUDGET" },
      ],
    );
  },
);

test(
  "close racing accepted recovery wins without launching a replacement",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { maxRestarts: 2 });
    await h.start();
    const peer = h.supervisor.peer!;
    await bounded(
      peer.request("fixture.inspect", null),
      "close race worker gate",
    );
    assert.equal(h.supervisor.recover(peer), true);
    const closing = h.supervisor.close();
    assert.equal(h.supervisor.recover(peer), false);
    await bounded(closing, "close during recovery termination");
    assert.equal(h.supervisor.state, "closed");
    assert.equal(h.supervisor.pid, undefined);
    assert.equal(h.owned.length, 1);
    assert.equal(h.supervisor.recover(peer), false);
    assert.deepEqual(h.offlineEvents, []);
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "restart"),
      [],
    );
  },
);

test(
  "close during recovery backoff cancels replacement",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, { maxRestarts: 2, restartBaseMs: 200 });
    await h.start();
    assert.equal(h.supervisor.recover(h.supervisor.peer!), true);
    await bounded(h.owned[0]!.exit, "exit before recovery backoff close");
    assert.equal(h.supervisor.state, "backoff");
    await bounded(h.supervisor.close(), "close scheduled recovery");
    assert.equal(h.supervisor.state, "closed");
    assert.equal(h.owned.length, 1);
    assert.equal(h.readyEvents.length, 1);
    assert.deepEqual(h.offlineEvents, []);
  },
);

test(
  "close from a recovery restart observer wins before a timer is registered",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    let supervisor: ChildSupervisor | undefined;
    const closed = deferred<void>();
    const h = await setup(t, {
      maxRestarts: 2,
      onStartup: (event) => {
        if (event.stage === "restart" && event.outcome === "info")
          void supervisor!.close().then(() => closed.resolve());
      },
    });
    supervisor = h.supervisor;
    await h.start();
    assert.equal(supervisor.recover(supervisor.peer!), true);
    await bounded(closed.promise, "reentrant close during recovery restart");
    assert.equal(supervisor.state, "closed");
    assert.equal(h.owned.length, 1);
    assert.deepEqual(h.offlineEvents, []);
  },
);

test("supervisor diagnostics never expose launch errors or let observers throw", async (t) => {
  const events: StartupEvent[] = [];
  const supervisor = new ChildSupervisor({
    entry: ENTRY,
    build: BUILD,
    launch: (() => {
      throw new Error("fixture-private-launch-data");
    }) as typeof fork,
    onStartup: (event) => {
      events.push(event);
      throw new Error("fixture-private-observer-data");
    },
  });
  t.after(() => supervisor.close());
  await assert.rejects(supervisor.start(), { code: "LAUNCH_FAILED" });
  await supervisor.close();
  assert.deepEqual(events, [
    { stage: "launch", outcome: "begin" },
    { stage: "launch", outcome: "failed", code: "LAUNCH_FAILED" },
    { stage: "shutdown", outcome: "begin" },
    { stage: "shutdown", outcome: "ok" },
  ]);
});

test(
  "throwing startup observers preserve real child handshake and shutdown",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t, {
      onStartup: () => {
        throw new Error("fixture-observer-error");
      },
    });
    await h.start();
    await bounded(h.supervisor.close(), "throwing observer close");
    assert.equal(h.supervisor.state, "closed");
  },
);

test(
  "process error diagnostics omit raw error fields",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await h.start();
    const child = h.owned[0]!.child;
    child.emit(
      "error",
      Object.assign(new Error("fixture-private-process-error"), {
        code: "fixture-private-code",
      }),
    );
    await bounded(h.offline.promise, "process error terminates owned child");
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "runtime-error"),
      [{ stage: "runtime-error", outcome: "failed", code: "TRANSPORT_ERROR" }],
    );
    assert.equal(
      JSON.stringify(h.startupEvents).includes("fixture-private"),
      false,
    );
  },
);

test(
  "exit diagnostics omit non-allowlisted signals",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await h.start();
    h.owned[0]!.child.kill("SIGUSR2");
    await bounded(h.offline.promise, "unknown signal exit");
    assert.deepEqual(
      h.startupEvents.filter((event) => event.stage === "exit"),
      [{ stage: "exit", outcome: "info" }],
    );
  },
);
