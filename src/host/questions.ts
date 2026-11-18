import { randomBytes } from "node:crypto";
import { ProtocolError } from "../protocol/json.js";
import {
  validQuestionAnswer,
  type QuestionAnswer,
  type QuestionItem,
} from "../protocol/questions.js";

export interface QuestionBinding {
  sessionId: string;
  ownerId: number;
  ownerEpoch: number;
  generation: string;
  chatId: number;
  threadId: number;
  signal: AbortSignal;
}
interface Pending {
  binding: QuestionBinding;
  questions: QuestionItem[];
  resolve(answer: QuestionAnswer): void;
  reject(error: Error): void;
  dispose(): void;
}
/** Host-owned question capabilities. No resolver is held by the Telegram child. */
export class QuestionRegistry {
  private readonly pending = new Map<string, Pending>();
  register(binding: QuestionBinding, questions: QuestionItem[]) {
    if (this.pending.size >= 64)
      throw new ProtocolError("PENDING_LIMIT", "Too many pending questions");
    const id = randomBytes(24).toString("base64url");
    const result = new Promise<QuestionAnswer>((resolve, reject) => {
      const abort = () => this.cancel(id);
      this.pending.set(id, {
        binding,
        questions: structuredClone(questions),
        resolve,
        reject,
        dispose: () => binding.signal.removeEventListener("abort", abort),
      });
      binding.signal.addEventListener("abort", abort, { once: true });
      if (binding.signal.aborted) abort();
    });
    return { id, result };
  }
  session(id: string) {
    return this.pending.get(id)?.binding.sessionId;
  }
  answer(
    id: string,
    actor: Omit<QuestionBinding, "signal" | "sessionId">,
    value: unknown,
  ): void {
    const pending = this.pending.get(id);
    if (
      !pending ||
      pending.binding.signal.aborted ||
      actor.ownerId <= 0 ||
      actor.ownerId !== actor.chatId ||
      ["ownerId", "ownerEpoch", "generation", "chatId", "threadId"].some(
        (key) =>
          actor[key as keyof typeof actor] !==
          pending.binding[key as keyof typeof actor],
      )
    )
      throw new ProtocolError("AUTHORITY_DENIED", "Question authority denied");
    const answer = validQuestionAnswer(pending.questions, value);
    if (!answer)
      throw new ProtocolError("INVALID_PARAMS", "Invalid question answer");
    this.pending.delete(id);
    pending.dispose();
    pending.resolve(answer);
  }
  cancel(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.dispose();
    pending.reject(new ProtocolError("CANCELLED", "Question cancelled"));
  }
  cancelGeneration(generation: string): void {
    for (const [id, pending] of this.pending)
      if (pending.binding.generation === generation) this.cancel(id);
  }
  close(): void {
    for (const id of this.pending.keys()) this.cancel(id);
  }
}
