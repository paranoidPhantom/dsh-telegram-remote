import type { Registration } from "./activation-contracts.js";
import type { QuestionRegistry } from "./questions.js";
import {
  questionItemsSchema,
  type QuestionAnswer,
} from "../protocol/questions.js";
import type { RpcPeer } from "../protocol/rpc.js";

/** Structural contract verified against upstream user-questions/types.ts; installed runtime unverified. */
export interface HostQuestionRequest {
  agent?: { id: string };
  questions: unknown[];
  signal?: AbortSignal;
  wait?: { callId: string; timed?: boolean };
}
export interface QuestionForwardingContext {
  on(
    name: "user-questions/request",
    listener: (
      request: HostQuestionRequest,
      next: () => Promise<QuestionAnswer>,
    ) => Promise<QuestionAnswer>,
    options: { prepend: true },
  ): Registration;
}
export function registerQuestionForwarding(
  ctx: QuestionForwardingContext,
  dependencies: {
    questions: QuestionRegistry;
    signal: AbortSignal;
    surface: {
      getTopic(
        id: string,
      ): Promise<{ chatId: number; threadId: number } | undefined>;
    };
    readonly ownerId: number;
    readonly ownerEpoch: number;
    readonly generation: string;
    readonly peer: Pick<RpcPeer, "request"> | undefined;
  },
): Registration {
  return ctx.on(
    "user-questions/request",
    async (request, next) => {
      // Specialized approval/plan intents retain their existing reviewed surfaces.
      // Timed waits need attachWait/continued-question support; delegate rather than
      // claiming a request whose deadline or late-answer semantics we cannot honor.
      if (
        !request.agent ||
        !Array.isArray(request.questions) ||
        request.wait?.timed ||
        request.questions.some(
          (question) =>
            question && typeof question === "object" && "intent" in question,
        )
      )
        return next();
      const parsed = questionItemsSchema.safeParse(request.questions);
      if (
        !parsed.success ||
        Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 128 * 1024
      )
        return next();
      const topic = await dependencies.surface.getTopic(request.agent.id);
      const peer = dependencies.peer;
      if (!topic || !peer || dependencies.signal.aborted) return next();
      const signal = request.signal
        ? AbortSignal.any([request.signal, dependencies.signal])
        : dependencies.signal;
      const registered = dependencies.questions.register(
        {
          sessionId: request.agent.id,
          ownerId: dependencies.ownerId,
          ownerEpoch: dependencies.ownerEpoch,
          generation: dependencies.generation,
          ...topic,
          signal,
        },
        parsed.data,
      );
      const presented = peer.request(
        "question.request",
        {
          id: registered.id,
          sessionId: request.agent.id,
          questions: parsed.data,
        },
        { signal, timeoutMs: 24 * 60 * 60_000 },
      );
      // Delivery completion is never answer authority. Only questions.answer through
      // the actor-fenced Host capability can resolve registered.result.
      void presented.then(
        () => dependencies.questions.cancel(registered.id),
        () => dependencies.questions.cancel(registered.id),
      );
      let answered = false;
      try {
        const answer = await registered.result;
        answered = true;
        return answer;
      } finally {
        // Successful submission is still unwinding in the child's actor scope;
        // cancelling here would race its ACK and erase the accepted UI state.
        if (!answered)
          void peer
            .request(
              "question.cancel",
              { id: registered.id },
              { timeoutMs: 2000 },
            )
            .catch(() => {});
      }
    },
    { prepend: true },
  );
}
