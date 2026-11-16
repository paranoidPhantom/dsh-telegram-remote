import { formatToolCall, formatToolResult } from "../rendering/tool-format.js";
import {
  namedCallSummary,
  jobResultSummary,
} from "../rendering/tool-summary.js";
import {
  mutationIntents,
  successfulMutations,
  aggregateTouched,
} from "../files/touched-files.js";
import {
  isRunEvent,
  runStateSchema,
  todoEntrySchema,
  type ContentBlock,
  type RunEventInput,
  type RunState,
} from "./types.js";

export type { RunEvent, RunEventInput, RunState } from "./types.js";

export const textOf = (
  content: readonly ContentBlock[] | null | undefined,
): string =>
  (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
const preview = (text: unknown, max = 320): string => {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
/** Only explicit provider-neutral reasoning text is admitted, never replay state,
 * signatures, encrypted content, provider payloads or internal agent objects. */
export function reasoningPreview(parts: Iterable<string>): string {
  let text = "";
  for (const part of parts) {
    text = (text + part).replace(/\s+/g, " ").trimStart();
    if (text.length > 240) break;
  }
  text = text.trim();
  if (text.length <= 240) return text;
  let end = 239;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}
function withReasoning(
  state: RunState,
  id: string,
  parts: Iterable<string>,
): RunState {
  const text = reasoningPreview(parts);
  if (
    !text ||
    state.activityLog.filter((entry) => entry.kind === "reasoning").length >=
      64 ||
    state.activityLog.some(
      (entry) => entry.kind === "reasoning" && entry.id === id,
    )
  )
    return state;
  return {
    ...state,
    activityLog: [...state.activityLog, { kind: "reasoning", id, text }],
  };
}
export function toolSummary(raw: unknown): string {
  let args: unknown = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw) as unknown;
    } catch {
      return preview(raw);
    }
  }
  if (!args || typeof args !== "object") return "";
  // Arrays have no named argument fields in ordinary JSON, matching the legacy
  // object check without promoting untrusted argument values to a typed payload.
  const fields = args as Record<string, unknown>;
  const detail =
    fields.description ??
    fields.command ??
    fields.file_path ??
    fields.path ??
    fields.query ??
    fields.url ??
    fields.pattern ??
    fields.objective ??
    fields.question;
  return typeof detail === "string" ? preview(detail) : "";
}
export function initialRun(): RunState {
  return {
    todos: [],
    todoVersion: 0,
    turn: 0,
    status: "idle",
    step: "",
    tools: 0,
    toolLog: [],
    activityLog: [],
    touchedFiles: [],
    workspaceSeqs: [],
    outputs: [],
    partialAnswer: "",
    answer: "",
    started: 0,
    ended: 0,
    model: "",
    final: false,
  };
}
export function foldRun(state: RunState, event: RunEventInput): RunState {
  if (!isRunEvent(event)) return state;
  switch (event.type) {
    case "turn/start":
      return {
        ...initialRun(),
        todos: state.todos,
        todoVersion: state.todoVersion,
        turn: event.data.turn,
        status: "thinking",
        started: event.time,
      };
    case "todo/write": {
      const parsed = todoEntrySchema.array().safeParse(event.data?.todos);
      if (!parsed.success) return state;
      const version = event.seq ?? state.todoVersion + 1;
      if (version <= state.todoVersion) return state;
      return { ...state, todos: parsed.data, todoVersion: version };
    }
    case "request/header":
      return { ...state, model: event.data.header.config.model };
    case "step/start":
      return { ...state, status: "thinking", step: `Step ${event.data.step}` };
    case "tool/call": {
      const d = event.data;
      if (state.toolLog.some((entry) => entry.callId === d.callId))
        return state;
      const mutations = mutationIntents(d.name, d.arguments);
      return {
        ...state,
        status: "running",
        step: d.name,
        tools: state.tools + 1,
        activityLog: [...state.activityLog, { kind: "tool", callId: d.callId }],
        toolLog: [
          ...state.toolLog,
          {
            callId: d.callId,
            name: d.name,
            status: "running",
            summary:
              namedCallSummary(d.name, d.arguments) ?? toolSummary(d.arguments),
            mutations,
            callHtml: formatToolCall(
              d.name,
              mutations.length
                ? { paths: mutations.map((item) => item.path) }
                : d.arguments,
            ),
            startedAt: event.time,
          },
        ],
      };
    }
    case "tool/result": {
      const d = event.data;
      const callId = d.message.toolCallId ?? d.message.source?.callId;
      const index = state.toolLog.findIndex((entry) => entry.callId === callId);
      const call = state.toolLog[index];
      if (!call) return state;
      const toolLog = state.toolLog.slice();
      const failed = Boolean(d.error || d.message.isError);
      const completed = {
        ...call,
        status: failed ? ("failed" as const) : ("completed" as const),
        endedAt: event.time,
        summary:
          jobResultSummary(
            call.name,
            textOf(d.message.content),
            call.summary,
          ) ?? call.summary,
        result: preview(textOf(d.message.content), 640),
        resultHtml: formatToolResult(call.name, textOf(d.message.content)),
      };
      toolLog[index] = completed;
      return {
        ...state,
        toolLog,
        touchedFiles: aggregateTouched(
          state.touchedFiles,
          successfulMutations(completed, event),
        ),
      };
    }
    case "workspace/changes":
      return event.data.turn === state.turn
        ? { ...state, workspaceSeqs: [...state.workspaceSeqs, event.seq] }
        : state;
    case "assistant/message": {
      const d = event.data;
      const text = textOf(d.message.content);
      const id = String(event.seq ?? d.message.id ?? `${d.turn}:${d.step}`);
      state = withReasoning(
        state,
        `message:${id}`,
        (d.message.content ?? [])
          .filter(
            (block) =>
              block.type === "reasoning" && typeof block.text === "string",
          )
          .map((block) => block.text!),
      );
      return {
        ...state,
        answer: text,
        partialAnswer: "",
        outputs:
          text && !state.outputs.some((output) => output.id === id)
            ? [
                ...state.outputs,
                {
                  id,
                  text,
                  toolCount: state.toolLog.length,
                  logCount: state.activityLog.length,
                },
              ]
            : state.outputs,
      };
    }
    case "assistant/attempt": {
      const parts = (event.data.stream ?? []).flatMap((record) =>
        record.type === "reasoning-chunks"
          ? (record.texts ?? [])
          : record.type === "chunk" &&
              record.chunk?.type === "reasoning-delta" &&
              typeof record.chunk.text === "string"
            ? [record.chunk.text]
            : [],
      );
      state = withReasoning(
        state,
        `attempt:${event.seq ?? state.activityLog.length}`,
        parts,
      );
      const text = (event.data.stream ?? [])
        .map((record) =>
          record.type === "text-chunks"
            ? (record.texts ?? []).join("")
            : record.type === "chunk" && record.chunk?.type === "text-delta"
              ? record.chunk.text
              : "",
        )
        .join("");
      return text ? { ...state, partialAnswer: text } : state;
    }
    case "turn/end":
      return {
        ...state,
        final: true,
        ended: event.time,
        status:
          event.data.reason.kind === "completed"
            ? "done"
            : event.data.reason.kind === "aborted"
              ? "stopped"
              : "failed",
        toolLog: state.toolLog.map((entry) =>
          entry.status === "running"
            ? { ...entry, status: "cancelled", endedAt: event.time }
            : entry,
        ),
      };
  }
}
export const runProjection = {
  key: "telegramConsoleRun",
  stateVersion: 9,
  stateSchema: runStateSchema,
  init: initialRun,
  apply: foldRun,
};
