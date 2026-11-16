import { randomBytes } from "node:crypto";

export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface ApprovalBinding {
  sessionId: string;
  callId: string;
  ownerId: number;
  ownerEpoch: number;
  chatId: number;
  threadId: number;
  expiresAt: number;
  signal?: AbortSignal;
}

export interface ApprovalDecision {
  id: string;
  sessionId: string;
  callId: string;
  ownerId: number;
  ownerEpoch: number;
  chatId: number;
  threadId: number;
  privateChat: boolean;
  outcome: "allowed-once" | "rejected";
}

export interface ApprovalReason extends Omit<ApprovalDecision, "outcome"> {
  reason: string;
}

export type ApprovalReasonCallback = (reason: string) => unknown;

export interface ApprovalHandle {
  id: string;
  result: Promise<ApprovalOutcome>;
}

interface PendingApproval {
  binding: ApprovalBinding;
  resolve: (outcome: ApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  onReason?: ApprovalReasonCallback;
}

interface RejectedReason {
  binding: ApprovalBinding;
  onReason: ApprovalReasonCallback;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

const MAX_TIMER_DELAY = 2_147_483_647;

/** Host-only authority: presentation and IPC carry IDs, never these resolvers. */
export class ApprovalRegistry {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly rejectedReasons = new Map<string, RejectedReason>();
  private readonly maxRecentReasons = 256;
  private readonly revokedEpochs = new Set<number>();
  private readonly now: () => number;
  private closed = false;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  register(
    input: ApprovalBinding & { onReason?: ApprovalReasonCallback },
  ): ApprovalHandle {
    const id = randomBytes(24).toString("base64url");
    if (this.closed || this.revokedEpochs.has(input.ownerEpoch)) {
      return { id, result: Promise.resolve("cancelled") };
    }
    if (input.signal?.aborted) {
      return { id, result: Promise.resolve("cancelled") };
    }
    const now = this.now();
    if (
      !validBinding(input) ||
      !Number.isFinite(now) ||
      input.expiresAt <= now
    ) {
      return { id, result: Promise.resolve("unavailable") };
    }
    const { onReason, ...binding } = input;
    let resolve: (outcome: ApprovalOutcome) => void = () => {};
    const result = new Promise<ApprovalOutcome>((settle) => {
      resolve = settle;
    });
    const pending: PendingApproval = { binding, resolve, onReason };
    this.approvals.set(id, pending);
    if (binding.signal) {
      pending.abort = () => this.settle(id, "cancelled");
      binding.signal.addEventListener("abort", pending.abort, { once: true });
      // Also cover a signal that became aborted during registration.
      if (binding.signal.aborted) this.settle(id, "cancelled");
    }
    if (this.approvals.has(id)) this.armExpiry(id, pending);
    return { id, result };
  }

  decide(decision: ApprovalDecision): boolean {
    const pending = this.approvals.get(decision.id);
    if (!pending) return false;
    const now = this.now();
    if (!Number.isFinite(now) || now >= pending.binding.expiresAt) {
      this.settle(decision.id, "unavailable");
      return false;
    }
    const binding = pending.binding;
    if (
      decision.privateChat !== true ||
      (decision.outcome !== "allowed-once" &&
        decision.outcome !== "rejected") ||
      decision.sessionId !== binding.sessionId ||
      decision.callId !== binding.callId ||
      decision.ownerId !== binding.ownerId ||
      decision.ownerEpoch !== binding.ownerEpoch ||
      decision.chatId !== binding.chatId ||
      decision.threadId !== binding.threadId
    ) {
      return false;
    }
    this.settle(decision.id, decision.outcome);
    return true;
  }

  /** A reason is a single follow-up to an already rejected decision, never a grant. */
  async reason(input: ApprovalReason): Promise<boolean> {
    const recent = this.rejectedReasons.get(input.id);
    if (!recent) return false;
    const now = this.now();
    if (!Number.isFinite(now) || now >= recent.binding.expiresAt) {
      this.clearReason(input.id);
      return false;
    }
    const binding = recent.binding;
    if (
      input.privateChat !== true ||
      input.sessionId !== binding.sessionId ||
      input.callId !== binding.callId ||
      input.ownerId !== binding.ownerId ||
      input.ownerEpoch !== binding.ownerEpoch ||
      input.chatId !== binding.chatId ||
      input.threadId !== binding.threadId ||
      typeof input.reason !== "string" ||
      input.reason.length > 1000
    )
      return false;
    // Consume before invoking user code, including asynchronous or throwing callbacks.
    this.clearReason(input.id);
    try {
      await recent.onReason(input.reason);
      return true;
    } catch {
      // Never expose arbitrary callback errors (which may contain reason text).
      return false;
    }
  }

  cancel(id: string): void {
    this.settle(id, "cancelled");
  }

  /** Cancel a disconnected child's current decisions without disabling future
   * approvals for the unchanged owner. Owner rotation uses revokeEpoch. */
  cancelEpoch(epoch: number): void {
    for (const [id, recent] of this.rejectedReasons) {
      if (recent.binding.ownerEpoch === epoch) this.clearReason(id);
    }
    for (const [id, pending] of this.approvals) {
      if (pending.binding.ownerEpoch === epoch) this.settle(id, "cancelled");
    }
  }

  revokeEpoch(epoch: number): void {
    this.revokedEpochs.add(epoch);
    this.cancelEpoch(epoch);
  }

  close(): void {
    this.closed = true;
    for (const id of this.rejectedReasons.keys()) this.clearReason(id);
    for (const id of this.approvals.keys()) this.settle(id, "cancelled");
  }

  private armExpiry(id: string, pending: PendingApproval): void {
    const now = this.now();
    const remaining = pending.binding.expiresAt - now;
    if (!Number.isFinite(now) || remaining <= 0) {
      this.settle(id, "unavailable");
      return;
    }
    pending.timer = setTimeout(
      () => {
        if (this.approvals.get(id) === pending) this.armExpiry(id, pending);
      },
      Math.min(remaining, MAX_TIMER_DELAY),
    );
    pending.timer.unref();
  }

  private settle(id: string, outcome: ApprovalOutcome): void {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.abort && pending.binding.signal) {
      pending.binding.signal.removeEventListener("abort", pending.abort);
    }
    if (outcome === "rejected" && pending.onReason) {
      while (this.rejectedReasons.size >= this.maxRecentReasons) {
        const oldest = this.rejectedReasons.keys().next().value;
        if (oldest === undefined) break;
        this.clearReason(oldest);
      }
      const recent: RejectedReason = {
        binding: pending.binding,
        onReason: pending.onReason,
      };
      this.rejectedReasons.set(id, recent);
      if (recent.binding.signal) {
        recent.abort = () => this.clearReason(id);
        recent.binding.signal.addEventListener("abort", recent.abort, {
          once: true,
        });
        if (recent.binding.signal.aborted) this.clearReason(id);
      }
      if (this.rejectedReasons.has(id)) this.armReasonExpiry(id, recent);
    }
    pending.resolve(outcome);
  }

  private armReasonExpiry(id: string, recent: RejectedReason): void {
    const now = this.now();
    const remaining = recent.binding.expiresAt - now;
    if (!Number.isFinite(now) || remaining <= 0) {
      this.clearReason(id);
      return;
    }
    recent.timer = setTimeout(
      () => {
        if (this.rejectedReasons.get(id) === recent)
          this.armReasonExpiry(id, recent);
      },
      Math.min(remaining, MAX_TIMER_DELAY),
    );
    recent.timer.unref();
  }

  private clearReason(id: string): void {
    const recent = this.rejectedReasons.get(id);
    if (!recent) return;
    this.rejectedReasons.delete(id);
    if (recent.timer !== undefined) clearTimeout(recent.timer);
    if (recent.abort && recent.binding.signal)
      recent.binding.signal.removeEventListener("abort", recent.abort);
  }
}

function validBinding(binding: ApprovalBinding): boolean {
  return (
    typeof binding.sessionId === "string" &&
    binding.sessionId.length > 0 &&
    typeof binding.callId === "string" &&
    binding.callId.length > 0 &&
    Number.isSafeInteger(binding.ownerId) &&
    binding.ownerId > 0 &&
    Number.isSafeInteger(binding.ownerEpoch) &&
    binding.ownerEpoch >= 0 &&
    Number.isSafeInteger(binding.chatId) &&
    binding.chatId > 0 &&
    Number.isSafeInteger(binding.threadId) &&
    binding.threadId >= 0 &&
    Number.isFinite(binding.expiresAt)
  );
}
