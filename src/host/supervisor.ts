import { type ChildProcess, type fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { jsonObject, ProtocolError, type JsonValue } from "../protocol/json.js";
import { createProcessTransport } from "../protocol/process.js";
import {
  RpcPeer,
  type RpcHandler,
  type WireTransport,
} from "../protocol/rpc.js";
import {
  observeStartup,
  startupFailure,
  type StartupObserver,
  type StartupEvent,
} from "../protocol/startup.js";
import { launchChild } from "./launcher.js";

export type SupervisorState =
  | "idle"
  | "starting"
  | "running"
  | "backoff"
  | "offline"
  | "closing"
  | "closed";
export interface SupervisorOptions {
  entry: URL;
  generation?: string;
  build: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminateTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  restartBaseMs?: number;
  launch?: typeof fork;
  handlers?: Record<string, RpcHandler>;
  onStartup?: StartupObserver;
  onReady?: (peer: RpcPeer) => void;
  onOffline?: (error: Error) => void;
}
interface OwnedChild {
  child: ChildProcess;
  transport: WireTransport;
  peer: RpcPeer;
  exited: boolean;
  exit: Promise<void>;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
  rejectStartup: (error: Error) => void;
  accepted: boolean;
  termination?: Promise<void>;
}

function limit(
  value: number | undefined,
  fallback: number,
  minimum = 1,
): number {
  const result = value ?? fallback;
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > 2_147_483_647
  ) {
    throw new ProtocolError("INVALID_LIMIT", "Invalid supervisor limit");
  }
  return result;
}
function failure(code: string, message: string): Error {
  return new ProtocolError(code, message);
}
async function within(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One owned, non-detached worker; no local fallback and no implicit RPC retries. */
export class ChildSupervisor {
  private readonly options: SupervisorOptions;
  private generation: string;
  private readonly startupMs: number;
  private readonly shutdownMs: number;
  private readonly terminateMs: number;
  private readonly restarts: number;
  private readonly windowMs: number;
  private readonly baseMs: number;
  private current: OwnedChild | undefined;
  private status: SupervisorState = "idle";
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimes: number[] = [];
  private offlineReported = false;

  constructor(options: SupervisorOptions) {
    this.options = { ...options, entry: new URL(options.entry.href) };
    this.generation = options.generation ?? randomUUID();
    if (!this.generation || !options.build)
      throw failure("INVALID_IDENTITY", "Worker identity is required");
    this.startupMs = limit(options.startupTimeoutMs, 5_000);
    this.shutdownMs = limit(options.shutdownTimeoutMs, 5_000);
    this.terminateMs = limit(options.terminateTimeoutMs, 2_000);
    this.restarts = limit(options.maxRestarts, 5, 0);
    this.windowMs = limit(options.restartWindowMs, 10 * 60_000);
    this.baseMs = limit(options.restartBaseMs, 1_000);
  }
  get state(): SupervisorState {
    return this.status;
  }
  get currentGeneration(): string {
    return this.generation;
  }
  get pid(): number | undefined {
    return this.current?.exited ? undefined : this.current?.child.pid;
  }
  get peer(): RpcPeer | undefined {
    return this.status === "running" ? this.current?.peer : undefined;
  }

  start(): Promise<void> {
    if (this.status === "running") return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.status !== "idle")
      return Promise.reject(
        failure("NOT_STARTABLE", "Supervisor cannot be started"),
      );
    const startup = this.spawn();
    this.starting = this.state === "starting" ? startup : undefined;
    // Unload can reject before the activation owner attaches its await.
    void startup.catch(() => {});
    return startup;
  }

  /**
   * Recover an established worker after Host initialization fails. The exact peer
   * fences late failures from an older worker; repeated/stale calls are no-ops.
   * Acceptance revokes RPC immediately, but replacement waits for owned exit and
   * uses the same restart window, budget and backoff as an unexpected exit.
   */
  recover(expectedPeer: RpcPeer): boolean {
    const owned = this.current;
    if (
      this.status !== "running" ||
      !owned?.accepted ||
      owned.exited ||
      owned.peer !== expectedPeer
    )
      return false;
    this.status = "backoff";
    owned.peer.close();
    void this.terminate(owned).catch(() =>
      this.offline(failure("TERMINATION_FAILED", "Worker did not exit")),
    );
    return true;
  }

  private spawn(): Promise<void> {
    // Explicit generations are deterministic test/integration fences. Production
    // launches without one rotate on every process replacement.
    this.generation = this.options.generation ?? randomUUID();
    this.status = "starting";
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      observeStartup(this.options.onStartup, {
        stage: "launch",
        outcome: "begin",
      });
      try {
        child = launchChild({ ...this.options, generation: this.generation });
      } catch {
        const error = failure("LAUNCH_FAILED", "Worker launch failed");
        observeStartup(this.options.onStartup, {
          stage: "launch",
          outcome: "failed",
          ...startupFailure(error),
        });
        this.offline(error);
        reject(error);
        return;
      }
      observeStartup(this.options.onStartup, {
        stage: "launch",
        outcome: "ok",
        ...(Number.isSafeInteger(child.pid) && child.pid! > 0
          ? { pid: child.pid }
          : {}),
      });
      observeStartup(this.options.onStartup, {
        stage: "handshake",
        outcome: "begin",
      });
      const transport = createProcessTransport(child);
      let owned: OwnedChild;
      let helloSeen = false;
      const invalid = () =>
        this.startupFailed(
          owned,
          failure("INVALID_HELLO", "Worker handshake rejected"),
        );
      // Validate before RpcPeer: stale/version-invalid envelopes may otherwise be
      // ignored by a peer, leaving admission dependent on a startup timeout.
      const guarded: WireTransport = {
        send: async (message) => {
          await transport.send(message);
          if (
            !owned.accepted &&
            helloSeen &&
            jsonObject(message) &&
            message.type === "result"
          ) {
            owned.accepted = true;
            if (owned.startupTimer) clearTimeout(owned.startupTimer);
            owned.startupTimer = undefined;
            if (this.current !== owned || this.status !== "starting") return;
            this.status = "running";
            this.starting = undefined;
            observeStartup(this.options.onStartup, {
              stage: "handshake",
              outcome: "ok",
            });
            resolve();
            try {
              this.options.onReady?.(owned.peer);
            } catch {
              /* Observer, not ownership. */
            }
          }
        },
        onMessage: (listener) =>
          transport.onMessage((message) => {
            if (!owned.accepted) {
              if (helloSeen || !this.validHello(message, child.pid)) {
                invalid();
                return;
              }
              helloSeen = true;
            } else if (
              jsonObject(message) &&
              message.type === "request" &&
              message.payload !== undefined &&
              jsonObject(message.payload) &&
              message.payload.method === "runtime.hello"
            ) {
              // Re-handshaking cannot replace a running generation.
              transport.close();
              return;
            }
            listener(message);
          }),
        onClose: (listener) => transport.onClose(listener),
        close: () => transport.close(),
      };
      const peer = new RpcPeer({
        transport: guarded,
        generation: this.generation,
        handlers: {
          ...this.options.handlers,
          "runtime.hello": async () => ({ generation: this.generation }),
        },
      });
      let resolveExit!: () => void;
      const exit = new Promise<void>((done) => {
        resolveExit = done;
      });
      owned = {
        child,
        transport,
        peer,
        exit,
        exited: false,
        accepted: false,
        startupTimer: undefined,
        rejectStartup: reject,
      };
      this.current = owned;
      const exited = (code: number | null, signal: NodeJS.Signals | null) => {
        if (owned.exited) return;
        owned.exited = true;
        const safeSignal = [
          "SIGTERM",
          "SIGKILL",
          "SIGABRT",
          "SIGSEGV",
          "SIGINT",
          "SIGHUP",
        ].find((allowed) => allowed === signal) as StartupEvent["signal"];
        observeStartup(this.options.onStartup, {
          stage: "exit",
          outcome: "info",
          ...(Number.isSafeInteger(code) ? { exitCode: code! } : {}),
          ...(safeSignal ? { signal: safeSignal } : {}),
        });
        if (owned.startupTimer) clearTimeout(owned.startupTimer);
        owned.startupTimer = undefined;
        resolveExit();
        peer.close();
        if (this.current !== owned) return;
        this.current = undefined;
        if (
          this.status === "closing" ||
          this.status === "closed" ||
          this.status === "offline"
        )
          return;
        if (!owned.accepted) {
          const error = failure(
            "STARTUP_EXIT",
            "Worker exited before handshake",
          );
          observeStartup(this.options.onStartup, {
            stage: "handshake",
            outcome: "failed",
            ...startupFailure(error),
          });
          reject(error);
          this.offline(error);
        } else this.restart();
      };
      child.once("exit", exited);
      child.once("close", exited); // Spawn failure has no exit event.
      child.once("disconnect", () => {
        observeStartup(this.options.onStartup, {
          stage: "disconnect",
          outcome: "info",
        });
      });
      child.on("error", () => {
        observeStartup(this.options.onStartup, {
          stage: "runtime-error",
          outcome: "failed",
          code: owned.accepted ? "TRANSPORT_ERROR" : "LAUNCH_FAILED",
        });
        if (!owned.accepted)
          this.startupFailed(
            owned,
            failure("LAUNCH_FAILED", "Worker launch failed"),
          );
        else transport.close();
      });
      transport.onClose(() => {
        if (
          this.current !== owned ||
          owned.exited ||
          this.status === "closing" ||
          this.status === "offline"
        )
          return;
        if (!owned.accepted)
          this.startupFailed(
            owned,
            failure("STARTUP_DISCONNECT", "Worker IPC closed before handshake"),
          );
        else {
          // Lost IPC must not permit another poller until this PID is reaped.
          this.status = "backoff";
          void this.terminate(owned).catch(() =>
            this.offline(failure("TERMINATION_FAILED", "Worker did not exit")),
          );
        }
      });
      owned.startupTimer = setTimeout(() => {
        this.startupFailed(
          owned,
          failure("STARTUP_TIMEOUT", "Worker handshake timed out"),
        );
      }, this.startupMs);
    });
  }

  private validHello(message: JsonValue, pid: number | undefined): boolean {
    if (
      !jsonObject(message) ||
      message.version !== 1 ||
      message.generation !== this.generation ||
      message.type !== "request" ||
      typeof message.id !== "string" ||
      !message.id ||
      message.payload === undefined ||
      !jsonObject(message.payload)
    )
      return false;
    const request = message.payload;
    if (
      request.method !== "runtime.hello" ||
      request.params === undefined ||
      !jsonObject(request.params)
    )
      return false;
    const hello = request.params;
    return (
      hello.version === 1 &&
      hello.build === this.options.build &&
      hello.runtime === "node" &&
      Number.isSafeInteger(hello.pid) &&
      hello.pid === pid &&
      pid !== process.pid
    );
  }

  private startupFailed(owned: OwnedChild, error: Error): void {
    if (this.current !== owned || this.status !== "starting") return;
    if (owned.startupTimer) clearTimeout(owned.startupTimer);
    owned.startupTimer = undefined;
    observeStartup(this.options.onStartup, {
      stage: "handshake",
      outcome: "failed",
      ...startupFailure(error),
    });
    owned.rejectStartup(error);
    this.offline(error);
    // Set offline before closing the pipe; its synchronous close notification
    // must not schedule a replacement for an invalid or missing handshake.
    owned.peer.close();
    void this.terminate(owned).catch(() => {
      /* close retries owned termination. */
    });
  }

  private offline(error: Error): void {
    if (this.status === "closing" || this.status === "closed") return;
    this.status = "offline";
    this.starting = undefined;
    if (this.offlineReported) return;
    this.offlineReported = true;
    try {
      this.options.onOffline?.(error);
    } catch {
      /* Observer only. */
    }
  }

  private restart(): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter(
      (time) => now - time < this.windowMs,
    );
    if (this.restartTimes.length >= this.restarts) {
      observeStartup(this.options.onStartup, {
        stage: "restart",
        outcome: "failed",
        code: "RESTART_BUDGET",
      });
      this.offline(
        failure("RESTART_BUDGET", "Worker restart budget exhausted"),
      );
      return;
    }
    const delay = Math.min(
      30_000,
      this.baseMs * 2 ** Math.min(this.restartTimes.length, 30),
    );
    this.restartTimes.push(now);
    this.status = "backoff";
    observeStartup(this.options.onStartup, {
      stage: "restart",
      outcome: "info",
      delayMs: delay,
    });
    // A startup observer can synchronously unload the owner. Close wins even
    // when it races the restart diagnostic, before the timer is registered.
    if (this.status !== "backoff" || this.current) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.status !== "backoff" || this.current) return;
      this.starting = this.spawn();
      void this.starting.catch(() => {
        /* spawn reports offline exactly once. */
      });
    }, delay);
  }

  private terminate(owned: OwnedChild): Promise<void> {
    if (owned.exited) return Promise.resolve();
    if (owned.termination) return owned.termination;
    owned.termination = (async () => {
      // Never signal a numeric PID or a process group; only the owned handle.
      owned.child.kill("SIGTERM");
      if (await within(owned.exit, this.terminateMs)) return;
      owned.child.kill("SIGKILL");
      if (!(await within(owned.exit, this.terminateMs))) {
        throw failure(
          "TERMINATION_TIMEOUT",
          "Owned worker did not exit after termination",
        );
      }
    })();
    return owned.termination;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.status === "closed") return Promise.resolve();
    const owned = this.current;
    this.status = "closing";
    observeStartup(this.options.onStartup, {
      stage: "shutdown",
      outcome: "begin",
    });
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (owned?.startupTimer) clearTimeout(owned.startupTimer);
    if (owned && !owned.accepted)
      owned.rejectStartup(
        failure("CLOSED", "Supervisor closed during startup"),
      );
    this.closing = (async () => {
      try {
        if (owned && !owned.exited) {
          if (owned.accepted && owned.child.connected) {
            // Ack is not exit/drain. Both share the same bounded grace period.
            void owned.peer
              .request("runtime.shutdown", null, { timeoutMs: this.shutdownMs })
              .catch(() => {});
            await within(owned.exit, this.shutdownMs);
          }
          if (!owned.exited) await this.terminate(owned);
        }
        observeStartup(this.options.onStartup, {
          stage: "shutdown",
          outcome: "ok",
        });
      } finally {
        owned?.peer.close();
        if (owned?.exited) this.current = undefined;
        this.starting = undefined;
        this.status = "closed";
      }
    })();
    return this.closing;
  }
}
