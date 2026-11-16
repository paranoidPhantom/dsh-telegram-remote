import { z } from "zod";

// Persisted v8 retains the semantic checklist across turn boundaries.
export const todoEntrySchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export const touchedEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "removed", "edited"]),
  sourceSeq: z.number().optional(),
  sourceIndex: z.number().optional(),
  cwd: z.string().optional(),
});
export const toolEntrySchema = z.object({
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  summary: z.string(),
  mutations: z.array(touchedEntrySchema).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  result: z.string().optional(),
  callHtml: z.string().optional(),
  resultHtml: z.string().optional(),
});
export const runStateSchema = z.object({
  todos: z.array(todoEntrySchema),
  todoVersion: z.number().int().nonnegative(),
  turn: z.number(),
  status: z.string(),
  step: z.string(),
  tools: z.number(),
  toolLog: z.array(toolEntrySchema),
  activityLog: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("tool"), callId: z.string() }),
      z.object({
        kind: z.literal("reasoning"),
        id: z.string(),
        text: z.string().max(240),
      }),
    ]),
  ),
  touchedFiles: z.array(touchedEntrySchema),
  workspaceSeqs: z.array(z.number()),
  outputs: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      toolCount: z.number().int().nonnegative(),
      logCount: z.number().int().nonnegative(),
    }),
  ),
  partialAnswer: z.string(),
  answer: z.string(),
  started: z.number(),
  ended: z.number(),
  model: z.string(),
  final: z.boolean(),
});
export type RunState = z.infer<typeof runStateSchema>;
export type TouchedFile = z.infer<typeof touchedEntrySchema>;
export type ToolEntry = z.infer<typeof toolEntrySchema>;

// Only fields consumed by this fold are described here. These are semantic Host
// events, not Telegram delivery state or a replacement Host event registry.
export interface ContentBlock {
  type: string;
  text?: string;
}
export interface EventEnvelope<Type extends string, Data> {
  type: Type;
  data: Data;
  seq?: number;
  time?: number;
}
type TimedEvent<Type extends string, Data> = EventEnvelope<Type, Data> & {
  time: number;
};
export interface ToolResultData {
  error?: unknown;
  meta?: unknown;
  message: {
    toolCallId?: string;
    source?: { callId?: string };
    isError?: boolean;
    content?: readonly ContentBlock[];
  };
}
export type ToolResultEvent = TimedEvent<"tool/result", ToolResultData>;
export interface AttemptRecord {
  type: string;
  texts?: readonly string[];
  index?: number;
  chunk?: { type: string; text?: string; index?: number; block?: ContentBlock };
}
export type RunEvent =
  | TimedEvent<"turn/start", { turn: number }>
  | EventEnvelope<"request/header", { header: { config: { model: string } } }>
  | EventEnvelope<"step/start", { step: number }>
  | TimedEvent<
      "tool/call",
      { callId: string; name: string; arguments: unknown }
    >
  | EventEnvelope<"todo/write", { todos: z.infer<typeof todoEntrySchema>[] }>
  | ToolResultEvent
  | (EventEnvelope<"workspace/changes", { turn: number }> & { seq: number })
  | EventEnvelope<
      "assistant/message",
      {
        turn?: number;
        step?: number;
        message: { id?: string; content?: readonly ContentBlock[] };
      }
    >
  | EventEnvelope<"assistant/attempt", { stream?: readonly AttemptRecord[] }>
  | TimedEvent<"turn/end", { reason: { kind: string } }>;

// Unknown event data stays unknown: irrelevant Host events preserve state
// identity. Known tags must carry the semantic contract above; Host ingress is
// responsible for validating those payloads, rather than this pure fold.
export type UnknownRunEvent = EventEnvelope<string, unknown>;
export type RunEventInput = RunEvent | UnknownRunEvent;
export function isRunEvent(event: RunEventInput): event is RunEvent {
  switch (event.type) {
    case "turn/start":
    case "request/header":
    case "step/start":
    case "tool/call":
    case "todo/write":
    case "tool/result":
    case "workspace/changes":
    case "assistant/message":
    case "assistant/attempt":
    case "turn/end":
      return true;
    default:
      return false;
  }
}
