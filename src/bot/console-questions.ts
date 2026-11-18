import { randomBytes } from "node:crypto";
import { messageResult } from "./contracts.js";
import type {
  InlineMarkup,
  TelegramApiPort,
  TelegramMessage,
  TopicContext,
} from "./contracts.js";
import type { Translator } from "../i18n/bot-i18n.js";
import type { QuestionAnswer, QuestionItem } from "../protocol/questions.js";

export interface QuestionPort {
  api: TelegramApiPort;
  t: Translator;
  /** Parent forwards through the authenticated callback/reply actor scope. */
  submit(id: string, answer: QuestionAnswer): Promise<void>;
}
type Action = {
  request: Pending;
  index: number;
  kind: "option" | "done" | "skip" | "other";
  option?: number;
};
type Step = {
  question: QuestionItem;
  selected: Set<number>;
  custom?: string;
  messages: { id: number; text: string }[];
  tokens: string[];
  markup: InlineMarkup;
};
type Pending = {
  id: string;
  ctx: TopicContext;
  questions: QuestionItem[];
  answers: QuestionAnswer["answers"];
  index: number;
  step?: Step;
  active: boolean;
  signal: AbortSignal;
  abort: () => void;
  resolve: (answer: QuestionAnswer) => void;
  reject: (error: unknown) => void;
  tail: Promise<void>;
};
const sameContext = (a: TopicContext, b: TopicContext) =>
  a.chatId === b.chatId && a.threadId === b.threadId;
const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Split plain text before encoding; each HTML chunk is independently valid and
 * retains every code point (including astral characters and all supporting detail). */
function chunks(text: string): string[] {
  const result: string[] = [];
  let chunk = "";
  for (const character of text.toWellFormed()) {
    const encoded = escaped(character);
    if (chunk.length + encoded.length > 3500) {
      result.push(chunk);
      chunk = "";
    }
    chunk += encoded;
  }
  if (chunk) result.push(chunk);
  return result;
}
const aborted = () =>
  new DOMException("Question request cancelled", "AbortError");

/** Generic questions only. Parent authenticates owners before calling callback /
 * reply; this class additionally fences exact chat/topic/request/step identity.
 * No approvals, facade action table, timers, or implicit/default answers. */
export class ConsoleQuestions {
  private readonly requests = new Map<string, Pending>();
  private readonly actions = new Map<string, Action>();
  private readonly protectedMessages = new Set<string>();
  private closed = false;
  constructor(readonly port: QuestionPort) {}

  private key(messageId: number, ctx: TopicContext) {
    return `${ctx.chatId}:${ctx.threadId}:${messageId}`;
  }
  protects(messageId: number, ctx: TopicContext): boolean {
    return this.protectedMessages.has(this.key(messageId, ctx));
  }
  request(
    id: string,
    ctx: TopicContext,
    questions: QuestionItem[],
    signal: AbortSignal,
  ): Promise<QuestionAnswer> {
    if (this.closed || signal.aborted) return Promise.reject(aborted());
    if (!questions.length)
      return Promise.reject(new Error("At least one question is required"));
    if (this.requests.has(id))
      return Promise.reject(new Error("Question request already exists"));
    return new Promise<QuestionAnswer>((resolve, reject) => {
      const pending: Pending = {
        id,
        ctx: { ...ctx },
        questions: structuredClone(questions),
        answers: [],
        index: 0,
        active: true,
        signal,
        abort: () => this.cancel(id),
        resolve,
        reject,
        tail: Promise.resolve(),
      };
      this.requests.set(id, pending);
      signal.addEventListener("abort", pending.abort, { once: true });
      if (signal.aborted) this.cancel(id);
      else void this.serial(pending, () => this.next(pending));
    });
  }
  private serial(pending: Pending, task: () => Promise<void>): Promise<void> {
    const work = pending.tail.then(async () => {
      if (pending.active) await task();
    });
    pending.tail = work.catch((error) => this.fail(pending, error));
    return pending.tail;
  }
  private token(action: Action, step: Step) {
    const token = `q:${randomBytes(16).toString("hex")}`;
    this.actions.set(token, action);
    step.tokens.push(token);
    return token;
  }
  private invalidate(step: Step) {
    for (const token of step.tokens) this.actions.delete(token);
    step.tokens = [];
  }
  private params(ctx: TopicContext) {
    return {
      chat_id: ctx.chatId,
      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
    };
  }
  private markup(pending: Pending, step: Step): InlineMarkup {
    // Tokens are regenerated on selection edits, fencing queued duplicate taps.
    this.invalidate(step);
    const button = (text: string, kind: Action["kind"], option?: number) => ({
      text: Array.from(text).slice(0, 60).join(""),
      callback_data: this.token(
        { request: pending, index: pending.index, kind, option },
        step,
      ),
    });
    const rows = (step.question.options ?? []).map((option, index) => [
      button(
        `${step.selected.has(index) ? "✓ " : ""}${option.label}`,
        "option",
        index,
      ),
    ]);
    rows.push([button(this.port.t("questionOther"), "other")]);
    rows.push([
      button(this.port.t("questionDone"), "done"),
      button(this.port.t("questionSkip"), "skip"),
    ]);
    return { inline_keyboard: rows };
  }
  private async next(pending: Pending): Promise<void> {
    const question = pending.questions[pending.index];
    if (!question) {
      this.detach(pending);
      pending.resolve({ answers: pending.answers });
      return;
    }
    const step: Step = {
      question,
      selected: new Set(),
      messages: [],
      tokens: [],
      markup: { inline_keyboard: [] },
    };
    pending.step = step;
    const lines = [
      this.port.t("questionTitle"),
      `${pending.index + 1}/${pending.questions.length}`,
    ];
    if (question.header) lines.push(question.header);
    lines.push(question.question);
    if (question.detail) lines.push(question.detail);
    for (const [index, option] of (question.options ?? []).entries()) {
      lines.push(
        `${index + 1}. ${option.label}${option.description ? `\n${option.description}` : ""}`,
      );
    }
    lines.push(this.port.t("questionReplyHint"));
    const parts = chunks(lines.join("\n\n"));
    step.markup = this.markup(pending, step);
    for (const [index, text] of parts.entries()) {
      if (!pending.active) return;
      const sent = messageResult(
        await this.port.api.call("sendMessage", {
          ...this.params(pending.ctx),
          text,
          parse_mode: "HTML",
          ...(index === parts.length - 1 ? { reply_markup: step.markup } : {}),
        }),
      );
      step.messages.push({ id: sent.message_id, text });
      this.protectedMessages.add(this.key(sent.message_id, pending.ctx));
      // Cancellation may happen during an accepted send. Retire its controls too.
      if (!pending.active)
        await this.settle(pending, step, "questionCancelled");
    }
  }
  private detach(pending: Pending) {
    pending.active = false;
    pending.signal.removeEventListener("abort", pending.abort);
    if (this.requests.get(pending.id) === pending)
      this.requests.delete(pending.id);
    if (pending.step) this.invalidate(pending.step);
  }
  private fail(pending: Pending, error: unknown) {
    if (!pending.active) return;
    this.detach(pending);
    pending.reject(error);
    if (pending.step)
      void this.settle(pending, pending.step, "questionCancelled").catch(
        () => {},
      );
  }
  private async settle(
    pending: Pending,
    step: Step,
    status: "questionAnswered" | "questionCancelled",
  ) {
    this.invalidate(step);
    const last = step.messages.at(-1);
    for (const message of step.messages) {
      await this.port.api.call("editMessageReplyMarkup", {
        chat_id: pending.ctx.chatId,
        message_id: message.id,
        reply_markup: { inline_keyboard: [] },
      });
      this.protectedMessages.delete(this.key(message.id, pending.ctx));
    }
    // Keep all original question/detail/options text, append status only if safe;
    // otherwise send the status separately rather than truncating the question.
    if (last) {
      const selected = [...step.selected]
        .sort((a, b) => a - b)
        .map((index) => step.question.options![index]!.label);
      if (step.custom !== undefined) selected.push(step.custom);
      const suffix = escaped(
        `\n\n${this.port.t(status)}${status === "questionAnswered" && selected.length ? `\n${this.port.t("questionSelected", { selected: selected.join(", ") })}` : ""}`,
      );
      if (last.text.length + suffix.length <= 4096) {
        await this.port.api.call("editMessageText", {
          chat_id: pending.ctx.chatId,
          message_id: last.id,
          text: last.text + suffix,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        for (const text of chunks(this.port.t(status)))
          await this.port.api.call("sendMessage", {
            ...this.params(pending.ctx),
            text,
            parse_mode: "HTML",
          });
      }
    }
  }
  private async finish(pending: Pending, skip: boolean) {
    const step = pending.step!;
    const selected = skip
      ? []
      : [...step.selected]
          .sort((a, b) => a - b)
          .map((index) => step.question.options![index]!.label);
    const answer = {
      id: step.question.id,
      selected,
      ...(!skip && step.custom !== undefined ? { custom: step.custom } : {}),
    };
    if (pending.index === pending.questions.length - 1) {
      // Authority submission remains inside the parent's authenticated actor
      // scope. Rejection leaves this step and its buttons retryable.
      try {
        await this.port.submit(pending.id, {
          answers: [...pending.answers, answer],
        });
      } catch {
        return;
      }
      if (!pending.active) return;
    }
    pending.answers.push(answer);
    if (skip) {
      step.selected.clear();
      step.custom = undefined;
    }
    // Telegram cosmetics must not turn a Host-accepted answer into failure.
    await this.settle(pending, step, "questionAnswered").catch(() => {});
    if (!pending.active) return;
    pending.index++;
    await this.next(pending);
  }
  async callback(token: string, ctx: TopicContext): Promise<boolean> {
    if (!token.startsWith("q:")) return false;
    const action = this.actions.get(token);
    if (!action || !sameContext(action.request.ctx, ctx)) return true;
    const pending = action.request;
    await this.serial(pending, async () => {
      if (this.actions.get(token) !== action || pending.index !== action.index)
        return;
      const step = pending.step!;
      if (action.kind === "done" || action.kind === "skip")
        return this.finish(pending, action.kind === "skip");
      if (action.kind === "option") {
        const index = action.option!;
        if (step.selected.has(index)) step.selected.delete(index);
        else {
          if (!step.question.multiSelect) step.selected.clear();
          step.selected.add(index);
        }
      }
      // Other is an explicit reminder: custom answers still require a reply to
      // this bot question, never capture arbitrary messages in the topic.
      const last = step.messages.at(-1);
      if (last) {
        step.markup = this.markup(pending, step);
        await this.port.api.call("editMessageReplyMarkup", {
          chat_id: pending.ctx.chatId,
          message_id: last.id,
          reply_markup: step.markup,
        });
      }
    });
    return true;
  }
  async reply(message: TelegramMessage): Promise<boolean> {
    const replyId = message.reply_to_message?.message_id;
    if (replyId === undefined || !message.text?.trim()) return false;
    const ctx = {
      chatId: message.chat.id,
      threadId: message.message_thread_id || 0,
    };
    const pending = [...this.requests.values()].find(
      (candidate) =>
        candidate.active &&
        sameContext(candidate.ctx, ctx) &&
        candidate.step?.messages.some((entry) => entry.id === replyId),
    );
    if (!pending) return false;
    const step = pending.step;
    await this.serial(pending, async () => {
      if (pending.step !== step) return;
      const custom = message.text!.trim();
      if (custom.length > 8000) return;
      pending.step!.custom = custom;
      if (!pending.step!.question.multiSelect) pending.step!.selected.clear();
      await this.finish(pending, false);
    });
    return true;
  }
  cancel(id: string): void {
    const pending = this.requests.get(id);
    if (!pending) return;
    this.detach(pending);
    pending.reject(aborted());
    if (pending.step)
      void this.settle(pending, pending.step, "questionCancelled").catch(
        () => {},
      );
  }
  close(): void {
    this.closed = true;
    for (const id of this.requests.keys()) this.cancel(id);
  }
}
