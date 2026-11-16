import { relativePathText } from "./path-display.js";
import { createTranslator, type Translator } from "../i18n/bot-i18n.js";
const english = createTranslator(() => "en");

/** Structural inputs keep pure rendering independent of console/projection ownership. */
export interface LabelInput {
  name?: string;
  model?: string;
  id?: string;
}
export interface ContextInput {
  percent?: number;
  percentage?: number;
  pressureTokens?: number;
  contextWindow?: number;
}
export interface SessionMetadata {
  title?: string;
  model?: string | LabelInput | null;
  activeModel?: string | LabelInput | null;
  context?: string | number | ContextInput | null;
  running?: boolean;
}
export interface ToolLogEntry {
  name?: string;
  summary?: string;
  status?: string;
  resultHtml?: string;
}

/** Pure Telegram text formatting and protocol error classification. */
export const TTL = 15 * 60_000;
export const PAGE = 8;
/** Callers supply JSON render data. Keep JSON.stringify semantics unchanged;
 * unsupported runtime values (e.g. functions) are outside this text contract. */
export const str = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value == null
      ? "—"
      : (JSON.stringify(value) as string);
export const cut = (value: unknown, max = 3900): string => {
  const text = str(value);
  const end =
    text.length > max && /[\uD800-\uDBFF]/.test(text.charAt(max - 1))
      ? max - 1
      : max;
  return text.slice(0, end);
};
export const html = (value: unknown): string =>
  str(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const label = (value?: string | LabelInput | null): string =>
  typeof value === "string"
    ? value
    : value?.name || value?.model || value?.id || "";
export const chunks = (value: unknown, max = 4096): string[] => {
  const result: string[] = [];
  let text = str(value);
  while (text.length) {
    let end = Math.min(max, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)))
      end--;
    result.push(text.slice(0, end));
    text = text.slice(end);
  }
  return result.length ? result : [""];
};
export const percent = (
  value?: string | number | ContextInput | null,
): string => {
  if (typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)) return value;
  const context = typeof value === "object" ? value : undefined;
  const n =
    typeof value === "number"
      ? value
      : (context?.percent ??
        context?.percentage ??
        (Number.isFinite(context?.pressureTokens) &&
        (context?.contextWindow ?? 0) > 0
          ? ((context?.pressureTokens ?? NaN) /
              (context?.contextWindow ?? NaN)) *
            100
          : undefined));
  return typeof n === "number" && Number.isFinite(n)
    ? `${Math.round(n * 10) / 10}%`
    : "";
};

function property(value: unknown, key: string): unknown {
  return value != null &&
    (typeof value === "object" || typeof value === "function") &&
    key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function message(error: unknown, fallback: "string" | "empty"): string {
  return String(
    property(error, "message") || (fallback === "string" ? String(error) : ""),
  );
}
export const unsupportedDraft = (error: unknown): boolean =>
  /(?:method.*(?:not found|unsupported)|unknown method|not supported|sendMessageDraft.*not|404)/i.test(
    message(error, "empty"),
  );
export const missingTopic = (error: unknown): boolean =>
  /(?:message thread|topic).*(?:not found|deleted)|TOPIC_DELETED/i.test(
    message(error, "string"),
  );
export const missingMessage = (error: unknown): boolean =>
  /message to edit not found|message_id_invalid/i.test(
    message(error, "string"),
  );
export const notModified = (error: unknown): boolean =>
  /not modified/i.test(message(error, "string"));
export const gone = (error: unknown): boolean =>
  property(error, "status") === 404 ||
  property(error, "statusCode") === 404 ||
  /session.*(?:not found|deleted)|unknown session/i.test(
    message(error, "empty"),
  );

export function compactSession(
  id: string,
  metadata?: SessionMetadata | null,
  active = false,
  t: Translator = english,
): string {
  if (!metadata) return "⚠ Session gone in DSH. Use /new or /sessions.";
  const model = label(metadata.model),
    current = label(metadata.activeModel),
    context = percent(metadata.context);
  return [
    metadata.title || id,
    model && `${t("model")}: ${model}`,
    current && current !== model && `${t("activeModel")}: ${current}`,
    metadata.running || active ? `▶ ${t("working")}` : t("idle"),
    context && `${t("context")}: ${context}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Escape before measuring: every returned HTML message stays under Telegram's
 * limit even when tool output consists entirely of reserved HTML characters. */
export function toolLogPages(
  entries: readonly ToolLogEntry[] = [],
  final = false,
  cwd?: string,
  t: Translator = english,
): string[] {
  if (!entries.length) return [];
  const icons: Readonly<Record<string, string>> = {
    running: "▶",
    completed: "✓",
    failed: "✗",
    cancelled: "⏹",
  };
  const preview = (value: unknown, limit: number): string => {
    const text = str(value);
    return html(
      text.length > limit ? `${cut(text, limit)}… [truncated]` : text,
    );
  };
  const rows = entries.map((tool, index) => {
    const status = tool.status || "running";
    const summary = tool.summary
      ? ` — <code>${preview(relativePathText(tool.summary, cwd), 120)}</code>`
      : "";
    const name =
      String(tool.name || "")
        .split(/[.:/]/)
        .pop()
        ?.toLowerCase() ?? "";
    const isChange = /^(write|edit|apply_patch|write_file|edit_file)$/.test(
      name,
    );
    // Read/search/command payloads are deliberately absent from the chat log.
    const detail =
      isChange &&
      tool.resultHtml &&
      /Changes|diff|Replace|With/.test(tool.resultHtml)
        ? `\n${tool.resultHtml}`
        : "";
    return `${index + 1}. ${icons[status] || "•"} ${preview(tool.name || "Tool", 70)} · ${html(t(status))}${summary}${detail}`;
  });
  const pages: string[] = [];
  let page = "";
  for (const row of rows) {
    if (page && page.length + row.length + 1 > 3700) {
      pages.push(page);
      page = "";
    }
    page += `${page ? "\n" : ""}${row}`;
  }
  if (page) pages.push(page);
  return pages.map(
    (body, index) =>
      `<blockquote expandable>${html(t("tools"))} · ${html(t(final ? "finished" : "working"))}${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ""}\n${body}</blockquote>`,
  );
}
