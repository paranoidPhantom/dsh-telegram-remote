import type {
  ConsoleBridge,
  SessionListEntry,
  TelegramParams,
} from "../src/bot/contracts.js";
// Recorded call views expose fields checked by each assertion; fixture APIs accept
// the production port parameters and record the unchanged request objects.
export type Button = import("../src/bot/contracts.js").InlineButton;
export type ApiParams = TelegramParams;
export interface ApiCall {
  method: string;
  params: ApiParams;
}
export type BridgeCall = [string, ...unknown[]];
export interface Selection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export type Session = SessionListEntry;
export interface SelectionResult {
  ok: boolean;
  model?: string;
  reason?: string;
}
export type Bridge = Partial<ConsoleBridge>;
export interface State {
  model?: unknown;
  preference?: unknown;
  messageId?: number;
  final?: boolean;
  finalMessageIds?: number[];
  latestControlMessageId?: number;
  draftId?: number;
}
export interface MessageUpdate {
  message: {
    message_id: number;
    from: { id: number };
    chat: { id: number; type: string };
    message_thread_id?: number;
    text?: string;
    forum_topic_created?: { name: string };
  };
}
export function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Expected fixture value to exist");
  return value;
}
