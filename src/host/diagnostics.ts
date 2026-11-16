import { z } from "zod";
import type { RpcPeer } from "../protocol/rpc.js";

const count = z.number().int().nonnegative().finite();
const duration = z.number().nonnegative().finite();
/** Parse an explicit allowlist so even a malformed child cannot add payloads to status. */
export const runtimeDiagnosticsSchema = z.object({
  childPid: count,
  build: z.string().max(256),
  generation: z.string().max(256),
  uptimeMs: count,
  rpcPending: count,
  ingress: z
    .object({
      active: count,
      normalActive: count,
      priorityActive: count,
      pending: count,
      halted: z.boolean(),
      // Backward compatible with child builds predating content-free errors.
      errorCount: count.optional(),
    })
    .nullable(),
  outbound: z.object({
    active: count,
    pending: count,
    lanes: count,
    lanePending: count,
    cooldownUntil: duration,
    rateLimitCount: count,
    rateLimitLastWaitMs: duration,
    rateLimitMaxWaitMs: duration,
  }),
  eventToSend: z.object({
    lastMs: duration.nullable(),
    maxMs: duration.nullable(),
  }),
});
export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;

/** One owned low-frequency request at a time; no retries, retained errors or timer leaks. */
export class RuntimeDiagnosticsPoller {
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private sample?: RuntimeDiagnostics;
  constructor(
    private readonly options: {
      peer: () => Pick<RpcPeer, "request"> | undefined;
      onSample: () => void;
      intervalMs?: number;
    },
  ) {}

  /** A stopped/offline/replaced child must never be represented by an old sample. */
  snapshot(generation: string | undefined): RuntimeDiagnostics | null {
    return generation && this.sample?.generation === generation
      ? structuredClone(this.sample)
      : null;
  }
  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    const interval = this.options.intervalMs ?? 10_000;
    if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 60_000)
      throw new Error("Invalid diagnostics interval");
    this.timer = setInterval(() => {
      void this.poll();
    }, interval);
    void this.poll();
  }
  async poll(): Promise<void> {
    if (this.active || this.controller.signal.aborted) return;
    const peer = this.options.peer();
    if (!peer) {
      this.sample = undefined;
      return;
    }
    this.active = true;
    try {
      const result = await peer.request(
        "runtime.diagnostics",
        {},
        {
          signal: this.controller.signal,
          timeoutMs: 2000,
        },
      );
      if (this.controller.signal.aborted || this.options.peer() !== peer)
        return;
      this.sample = runtimeDiagnosticsSchema.parse(result);
      this.options.onSample();
    } catch {
      this.sample = undefined;
      // Read-only monitoring is best effort and does not mark the runtime degraded.
    } finally {
      this.active = false;
    }
  }
  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
    this.sample = undefined;
  }
}
