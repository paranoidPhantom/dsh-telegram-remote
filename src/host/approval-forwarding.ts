import type { HostApproval, Registration } from "./activation-contracts.js";
import type { ApprovalOutcome, ApprovalRegistry } from "./approvals.js";
import type { JsonValue } from "../protocol/json.js";
import type { RpcPeer } from "../protocol/rpc.js";
import { wireValue } from "../protocol/values.js";
import { isRunEvent } from "../projection/types.js";

interface ApprovalForwardingContext<Handle> {
  on(
    name: "approval/request",
    listener: (
      request: HostApproval<Handle>,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>,
    options: { prepend: true },
  ): Registration;
}

interface ApprovalForwardingDependencies {
  approvals: Pick<ApprovalRegistry, "register" | "cancel">;
  signal: AbortSignal;
  surface: {
    getTopic(
      sessionId: string,
    ): Promise<{ chatId: number; threadId: number } | undefined>;
  };
  /** Read live authority only after topic lookup, not when registering the listener. */
  readonly ownerId: number;
  readonly ownerEpoch: number;
  readonly peer: Pick<RpcPeer, "request"> | undefined;
}

/** The caller owns this registration through its activation effect. */
export function registerApprovalForwarding<Handle>(
  ctx: ApprovalForwardingContext<Handle>,
  dependencies: ApprovalForwardingDependencies,
): Registration {
  const { approvals, signal, surface } = dependencies;
  return ctx.on(
    "approval/request",
    async (req, next) => {
      const topic = await surface.getTopic(req.agent.id);
      if (!topic || !dependencies.peer) return next();
      const peer = dependencies.peer,
        epoch = dependencies.ownerEpoch;
      const registered = approvals.register({
        sessionId: req.agent.id,
        callId: req.callId,
        onReason: req.onReason ? (reason) => req.onReason?.(reason) : undefined,
        ownerId: dependencies.ownerId,
        ownerEpoch: epoch,
        chatId: topic.chatId,
        threadId: topic.threadId,
        expiresAt: Date.now() + 15 * 60_000,
        signal: req.signal ? AbortSignal.any([req.signal, signal]) : signal,
      });
      const call = req.agent.session
        .snapshotEvents()
        .findLast(
          (event) =>
            isRunEvent(event) &&
            event.type === "tool/call" &&
            event.data.callId === req.callId,
        );
      let callArgs: JsonValue = null;
      if (call && isRunEvent(call) && call.type === "tool/call") {
        try {
          callArgs = wireValue(call.data.arguments);
        } catch {
          /* Non-DTO argument objects never cross the boundary. */
        }
      }
      const presented = peer.request(
        "approval.request",
        {
          id: registered.id,
          sessionId: req.agent.id,
          callId: req.callId,
          expiresAt: Date.now() + 15 * 60_000,
          request: {
            title: req.toolName,
            hasOnReason: typeof req.onReason === "function",
            callArgs,
            description:
              req.displayReason?.en ??
              req.reason ??
              "DSH requests permission for this action.",
          },
        },
        { signal, timeoutMs: 15 * 60_000 },
      );
      void presented.then(
        () => approvals.cancel(registered.id),
        () => approvals.cancel(registered.id),
      );
      try {
        return await registered.result;
      } finally {
        void peer
          .request(
            "approval.cancel",
            { id: registered.id },
            { timeoutMs: 2000 },
          )
          .catch(() => {});
      }
    },
    { prepend: true },
  );
}
