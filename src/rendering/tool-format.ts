import type { Translator } from "../i18n/bot-i18n.js";

type DataRecord = Record<string, unknown>;
type BlockKind = "plain" | "title" | "code" | "pre";
interface Block {
  text: string;
  kind: BlockKind;
}
interface OperationReason {
  permission: string;
  tool: string;
  args: DataRecord;
  warning: string;
}

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Pure, dependency-free Telegram HTML formatting. Tool data is always text, never HTML.
const LIMITS = { result: 1800, call: 1000, approval: 3800 };
const TITLES: Readonly<Record<string, string>> = {
  read: "Read file",
  read_image: "Read image",
  write: "Write file",
  edit: "Edit file",
  glob: "Find files",
  grep: "Search files",
  bash: "Run command",
  web_fetch: "Fetch page",
  web_search: "Search web",
  subagent: "Delegate task",
  subagent_fork: "Delegate task",
};
const LABELS: Readonly<Record<string, string>> = {
  file_path: "Path",
  path: "Path",
  paths: "Paths",
  command: "Command",
  description: "Description",
  reason: "Reason",
  justification: "Reason",
  stdout: "Output",
  stderr: "Errors",
  exit_code: "Exit code",
  exitCode: "Exit code",
  content: "Content",
  old_string: "Replace",
  new_string: "With",
  diff: "Changes",
  output: "Output",
  matches: "Matches",
  results: "Results",
  url: "URL",
  query: "Query",
  queries: "Queries",
  pattern: "Pattern",
  agent_id: "Agent",
  prompt: "Task",
  workdir: "Working directory",
  status: "Status",
  message: "Message",
  error: "Error",
  consequence: "Consequences",
  consequences: "Consequences",
  permission: "Permission",
  sandbox_permissions: "Requested access",
  title: "Title",
  text: "Text",
  name: "Name",
  type: "Type",
  total: "Total",
  count: "Count",
  offset: "First line",
  limit: "Line limit",
  replace_all: "Replace all",
  success: "Success",
  line: "Line",
  line_number: "Line",
  lineNumber: "Line",
  file: "File",
  timeoutMs: "Timeout (ms)",
  run_in_background: "Background",
  job_id: "Job",
  output_file: "Output file",
  additions: "Additions",
  deletions: "Deletions",
};
const normalize = (name: unknown): string =>
  String(name ?? "")
    .split(/[.:/]/)
    .pop()
    ?.replace(/^.*__/, "")
    .toLowerCase() ?? "";
const escape = (text: unknown): string =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const localized = (value: unknown): unknown =>
  isRecord(value) && typeof value.en === "string" ? value.en : value;
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (/^[{[]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {}
  }
  return value;
}
const label = (key: string): string =>
  LABELS[key] ||
  String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
const block = (text: unknown, kind: BlockKind = "plain"): Block => ({
  text: String(text ?? "").toWellFormed(),
  kind,
});
// Truncate text BEFORE wrapping it, accounting for encoded UTF-16 length, including entities.
// Closing tags and an explicit truncation notice are reserved up front.
function render(blocks: readonly Block[], limit: number): string {
  const marker = "\n… (truncated)";
  let html = "",
    truncated = false;
  for (let index = 0; index < blocks.length; index++) {
    const item = blocks[index];
    if (!item) continue;
    const { text, kind } = item;
    if (!text) continue;
    const [open, close] =
      kind === "title"
        ? ["<b>", "</b>"]
        : kind === "code"
          ? ["<code>", "</code>"]
          : kind === "pre"
            ? ["<pre>", "</pre>"]
            : ["", ""];
    const separator = html ? "\n" : "";
    const available =
      limit -
      html.length -
      separator.length -
      open.length -
      close.length -
      marker.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    let encoded = "";
    for (const char of text) {
      const next = escape(char);
      if (encoded.length + next.length > available) {
        truncated = true;
        break;
      }
      encoded += next;
    }
    html += separator + open + encoded + close;
    if (truncated) break;
  }
  return html + (truncated ? marker : "");
}
function fields(value: unknown, blocks: Block[], depth = 0, prefix = ""): void {
  value = localized(value);
  if (value == null) return;
  if (depth > 5) {
    blocks.push(block("… (nested content omitted)"));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 60)) {
      if (item && typeof item === "object") fields(item, blocks, depth + 1);
      else blocks.push(block(`• ${String(item)}`, "code"));
    }
    if (value.length > 60) blocks.push(block("… (more items omitted)"));
  } else if (isRecord(value)) {
    // DSH/MCP text envelopes carry data, not formatting instructions.
    if (value.type === "text" && typeof value.text === "string") {
      resultBody(value.text, blocks, depth + 1);
      return;
    }
    for (const [key, raw] of Object.entries(value).slice(0, 60)) {
      const val = localized(raw);
      if (val == null || (key === "en" && typeof value.en === "string"))
        continue;
      blocks.push(block(`${prefix}${label(key)}`, "title"));
      if (val && typeof val === "object") fields(val, blocks, depth + 1);
      else
        blocks.push(
          block(
            val,
            /command|content|stdout|stderr|output|diff|old_string|new_string|prompt|text/.test(
              key,
            )
              ? "pre"
              : /path|file|url/.test(key)
                ? "code"
                : "plain",
          ),
        );
    }
  } else blocks.push(block(value, "pre"));
}
// Only recognize whole DSH envelopes made of these known wrappers. The content
// body is opaque: literal tags, including known wrappers, remain escaped code.
function envelope(text: string): [string, string][] | null {
  const known = new Set([
    "path",
    "type",
    "content",
    "stdout",
    "stderr",
    "output",
    "exit_code",
    "exitCode",
    "status",
    "error",
    "message",
    "diff",
    "matches",
  ]);
  let rest = text.trim();
  const pairs: [string, string][] = [];
  while (rest) {
    const start = /^<([a-zA-Z_]+)>/.exec(rest);
    if (!start || !start[1] || !known.has(start[1])) return null;
    const tag = start[1],
      close = `</${tag}>`;
    const end =
      tag === "content" ? rest.lastIndexOf(close) : rest.indexOf(close);
    if (end < start[0].length) return null;
    pairs.push([tag, rest.slice(start[0].length, end).replace(/^\n|\n$/g, "")]);
    rest = rest.slice(end + close.length).trim();
  }
  return pairs.length ? pairs : null;
}
function resultBody(input: unknown, blocks: Block[], depth = 0): void {
  if (depth > 5) {
    blocks.push(block("… (nested content omitted)"));
    return;
  }
  const value = parse(input);
  if (typeof value !== "string") {
    fields(value, blocks, depth);
    return;
  }
  const pairs = envelope(value);
  if (pairs) {
    for (const [key, text] of pairs) {
      if (key === "type") continue;
      blocks.push(
        block(label(key), "title"),
        block(text, key === "path" ? "code" : "pre"),
      );
    }
    return;
  }
  // Native bash output is plain text with a trailing exit marker.
  const exit = /(?:\n|^)\[exit code: (-?\d+)\]\s*$/.exec(value);
  if (exit) {
    blocks.push(
      block(`Exit code: ${exit[1]}`, "title"),
      block("Output", "title"),
      block(value.slice(0, exit.index), "pre"),
    );
  } else blocks.push(block(value, "pre"));
}
export function formatToolResult(name: unknown, text: unknown): string {
  const normalized = normalize(name);
  const blocks = [
    block(TITLES[normalized] || label(normalized || "Tool result"), "title"),
  ];
  resultBody(text, blocks);
  return render(blocks, LIMITS.result);
}
export function formatToolCall(name: unknown, args: unknown): string {
  const normalized = normalize(name);
  const blocks = [
    block(TITLES[normalized] || label(normalized || "Tool call"), "title"),
  ];
  fields(parse(args), blocks);
  return render(blocks, LIMITS.call);
}
function operationReason(input: unknown): OperationReason | null {
  if (typeof input !== "string") return null;
  const prefix =
    /^Allow this operation with ([\w-]+) permissions:\s*([\w.:/-]+)\s*/.exec(
      input,
    );
  if (!prefix || !prefix[1] || !prefix[2]) return null;
  const start = prefix[0].length;
  if (input[start] !== "{") return null;
  let depth = 0,
    quoted = false,
    escaped = false,
    end = -1;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return null;
  try {
    const args: unknown = JSON.parse(input.slice(start, end));
    if (!isRecord(args)) return null;
    return {
      permission: prefix[1],
      tool: prefix[2],
      args,
      warning: input
        .slice(end)
        .replace(/^\s*\.\s*/, "")
        .trim(),
    };
  } catch {
    return null;
  }
}
export function formatApproval(request: unknown, t?: Translator): string {
  const localizedRender = (blocks: Block[]): string =>
    render(
      blocks.map((item) => {
        const translations: Readonly<Record<string, string>> = {
          "Approval required": "approvalRequired",
          Reason: "reason",
          Command: "command",
          Paths: "paths",
          Consequences: "consequences",
          "Requested access": "requestedAccess",
          "Full access — outside the workspace sandbox": "fullAccess",
          "Remove plugin bundle": "removedBundle",
          "Install plugin bundle": "installBundle",
          "Change plugin bundle": "changeBundle",
          "Change plugin": "changePlugin",
        };
        const key = translations[item.text];
        return key && t ? { ...item, text: t(key) } : item;
      }),
      LIMITS.approval,
    );
  const req: DataRecord =
    request && typeof request === "object"
      ? (request as DataRecord)
      : { reason: request };
  const operation =
    operationReason(localized(req.reason)) ??
    operationReason(localized(req.displayReason)) ??
    operationReason(localized(req.description));
  if (operation) {
    const actions: Readonly<Record<string, string>> = {
      remove_bundle: "Remove plugin bundle",
      install_bundle: "Install plugin bundle",
      set_bundle: "Change plugin bundle",
      set_plugin: "Change plugin",
    };
    const blocks = [
      block("Approval required", "title"),
      block(
        actions[String(operation.args.action)] || label(operation.tool),
        "title",
      ),
    ];
    if (operation.args.target)
      blocks.push(
        block("Bundle", "title"),
        block(operation.args.target, "code"),
      );
    const extra = Object.fromEntries(
      Object.entries(operation.args).filter(
        ([key]) => !["action", "target"].includes(key),
      ),
    );
    fields(extra, blocks);
    blocks.push(
      block("Requested access", "title"),
      block(
        operation.permission === "danger-full-access"
          ? "Full access — outside the workspace sandbox"
          : operation.permission,
      ),
    );
    if (operation.warning)
      blocks.push(block("Consequences", "title"), block(operation.warning));
    return localizedRender(blocks);
  }
  const reason = parse(localized(req.reason));
  const description = parse(localized(req.description));
  const details = {
    ...(isRecord(reason) ? reason : {}),
    ...(isRecord(description) ? description : {}),
  };
  const action = localized(
    req.title ||
      req.action ||
      req.toolName ||
      details.title ||
      details.action ||
      "Action",
  );
  const title =
    typeof action === "string" ? TITLES[normalize(action)] || action : "Action";
  const blocks = [block("Approval required", "title"), block(title, "title")];
  const args = parse(req.callArgs);
  const callArgs = isRecord(args) ? args : {};
  const commands = req.command ?? details.command ?? callArgs.command;
  const paths =
    req.paths ??
    req.path ??
    details.paths ??
    details.path ??
    details.file_path ??
    callArgs.paths ??
    callArgs.path ??
    callArgs.file_path;
  if (typeof callArgs.description === "string")
    blocks.push(block(callArgs.description));
  const why =
    localized(req.displayReason) ??
    (typeof reason === "string"
      ? reason
      : localized(details.reason ?? details.justification));
  if (why) {
    blocks.push(block("Reason", "title"));
    fields(why, blocks);
  }
  if (typeof description === "string" && description !== why)
    blocks.push(block(description));
  if (commands != null) {
    blocks.push(block("Command", "title"));
    fields(commands, blocks);
  }
  if (paths != null) {
    blocks.push(block("Paths", "title"));
    for (const path of (Array.isArray(paths) ? paths : [paths]).slice(0, 40)) {
      if (path && typeof path === "object") fields(path, blocks);
      else blocks.push(block(`• ${path}`, "code"));
    }
  }
  const consequences = localized(
    req.consequences ??
      req.consequence ??
      details.consequences ??
      details.consequence,
  );
  if (consequences != null) {
    blocks.push(block("Consequences", "title"));
    fields(consequences, blocks);
  }
  // Show only permissions actually present; do not infer persistence or scope.
  for (const key of ["permission", "sandbox_permissions", "scope"]) {
    const value = req[key] ?? details[key];
    if (value != null) {
      blocks.push(block(label(key), "title"));
      fields(value, blocks);
    }
  }
  const extra = Object.fromEntries(
    Object.entries(details).filter(
      ([key]) =>
        ![
          "title",
          "action",
          "command",
          "paths",
          "path",
          "file_path",
          "reason",
          "justification",
          "consequences",
          "consequence",
          "permission",
          "sandbox_permissions",
          "scope",
        ].includes(key),
    ),
  );
  fields(extra, blocks);
  return localizedRender(blocks);
}
