import type { InboxEntry, InboxOutcome } from "../host/inbox.js";
import { ProtocolError, type JsonValue } from "../protocol/json.js";

/** All persistence and cursor advancement belong to the Host. Admission must
 * atomically/durably record an operation before acknowledging its update. */
export interface UpdateIngressOptions {
  api: {
    call(
      method: "getUpdates",
      parameters: JsonValue,
      signal: AbortSignal,
    ): Promise<JsonValue>;
  };
  admit(update: JsonValue): Promise<"admitted" | "duplicate" | "ignored">;
  getOffset(): Promise<number>;
  /** Return unresolved entries in admission order, including active entries.
   * This snapshot is bounded by the Host Inbox capacity, not a child queue. */
  pending(): Promise<InboxEntry[]>;
  settle(entry: InboxEntry, outcome: InboxOutcome): Promise<void>;
  handle(operation: JsonValue, signal: AbortSignal): Promise<void>;
  /** Routing only, NEVER an authorization decision. Priority handlers must
   * still authorize at console/Host authority. Ingress never pre-acks callbacks. */
  classify(operation: JsonValue): { key: string; priority: boolean };
  signal: AbortSignal;
  onError(error: unknown): void;
  maxActive?: number;
  retryMs?: number;
}

/** One polling loop and one replay dispatcher. Priority has one reserved slot,
 * bypassing normal concurrency and topic gates; priority work is itself serial.
 * No handlers are awaited by polling and no unbounded in-memory work queue exists.
 * run() stops promptly on abort; handlers receive the signal and remain owned by
 * the caller until drain(). An abort never marks an unfinished handler complete. */
export class UpdateIngress {
  private readonly options: UpdateIngressOptions;
  private readonly maxActive: number;
  private readonly retryMs: number;
  private readonly active = new Map<number, Promise<void>>();
  private readonly keys = new Set<string>();
  private normal = 0;
  private priority = false;
  private halted = false;
  private started = false;
  private unresolved = 0;
  private errorCount = 0;

  /** Last observed Host backlog; not a second queue or an admission guarantee. */
  diagnostics() {
    return {
      active: this.active.size,
      normalActive: this.normal,
      priorityActive: this.priority ? 1 : 0,
      pending: Math.max(0, this.unresolved - this.active.size),
      halted: this.halted,
      errorCount: this.errorCount,
    };
  }
  private readonly polling = new AbortController();

  constructor(options: UpdateIngressOptions) {
    this.options = options;
    this.maxActive = options.maxActive ?? 4;
    this.retryMs = options.retryMs ?? 50;
    if (
      !Number.isSafeInteger(this.maxActive) ||
      this.maxActive < 1 ||
      this.maxActive > 256 ||
      !Number.isSafeInteger(this.retryMs) ||
      this.retryMs < 1 ||
      this.retryMs > 60_000
    ) {
      throw new ProtocolError("INGRESS_OPTIONS", "Invalid ingress limits");
    }
  }

  async run(): Promise<void> {
    if (this.started)
      throw new ProtocolError("INGRESS_STARTED", "Ingress may only run once");
    this.started = true;
    const abort = () => this.polling.abort();
    this.options.signal.addEventListener("abort", abort, { once: true });
    if (this.options.signal.aborted) abort();
    try {
      await Promise.all([this.poll(), this.dispatch()]);
    } finally {
      this.options.signal.removeEventListener("abort", abort);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.active.values());
  }

  private report(error: unknown): void {
    this.errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.errorCount + 1);
    // A diagnostics callback must not create unhandled rejections or turn a
    // settled operation into another execution attempt.
    try {
      this.options.onError(error);
    } catch {
      /* diagnostics are best effort */
    }
  }

  private async poll(): Promise<void> {
    const { signal } = this.options;
    while (!signal.aborted && !this.halted) {
      try {
        const offset = await this.options.getOffset();
        if (signal.aborted || this.halted) break;
        const updates = await this.options.api.call(
          "getUpdates",
          { offset, limit: 100, timeout: 25 },
          this.polling.signal,
        );
        if (!Array.isArray(updates) || updates.length > 100)
          throw new ProtocolError(
            "INGRESS_UPDATES",
            "Invalid Telegram update batch",
          );
        for (const update of updates) {
          if (signal.aborted || this.halted) break;
          // On any failure stop this batch. In particular never acknowledge a
          // later update over a capacity-rejected earlier update.
          await this.options.admit(update);
        }
        if (updates.length === 0) await this.pause();
      } catch (error: unknown) {
        if (signal.aborted) break;
        this.report(error);
        await this.pause();
      }
    }
  }

  private async dispatch(): Promise<void> {
    while (!this.options.signal.aborted && !this.halted) {
      try {
        const entries = await this.options.pending();
        this.unresolved = entries.length;
        // No retained backlog: every refill reads durable unresolved state.
        // Active entries keep their normal topic gate until settlement commits.
        for (const entry of entries) {
          if (this.options.signal.aborted || this.halted) break;
          if (this.active.has(entry.updateId)) continue;
          let route: ReturnType<UpdateIngressOptions["classify"]> | undefined;
          let classificationError: unknown;
          try {
            route = this.options.classify(entry.operation);
          } catch (error: unknown) {
            // A poison entry must not prevent scanning later inbox entries.
            classificationError = error;
          }
          if (
            route?.priority
              ? this.priority
              : this.normal >= this.maxActive ||
                (route !== undefined && this.keys.has(route.key))
          )
            continue;
          if (route?.priority) this.priority = true;
          else {
            // Failed classification still owns a bounded normal slot until its
            // failed settlement commits, but has no trustworthy topic key.
            this.normal++;
            if (route) this.keys.add(route.key);
          }
          if (!route) this.report(classificationError);
          const task = this.execute(entry, route !== undefined).finally(() => {
            this.active.delete(entry.updateId);
            if (route?.priority) this.priority = false;
            else {
              this.normal--;
              if (route) this.keys.delete(route.key);
            }
          });
          this.active.set(entry.updateId, task);
        }
      } catch (error: unknown) {
        this.report(error);
      }
      await this.pause();
    }
  }

  private async execute(entry: InboxEntry, classified: boolean): Promise<void> {
    let outcome: InboxOutcome = classified ? "completed" : "failed";
    if (classified) {
      try {
        await this.options.handle(entry.operation, this.options.signal);
      } catch (error: unknown) {
        outcome = "failed";
        this.report(error);
      }
      // Cancellation is ambiguous only when a handler may have executed.
      if (this.options.signal.aborted) outcome = "uncertain";
    }
    try {
      await this.options.settle(entry, outcome);
    } catch (error: unknown) {
      // Persistence is ambiguous: fail closed, never repeatedly execute it.
      this.halted = true;
      this.polling.abort();
      this.report(error);
    }
  }

  private pause(): Promise<void> {
    const { signal } = this.options;
    if (signal.aborted || this.halted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.retryMs);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
