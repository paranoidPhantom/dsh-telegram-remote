import path from "node:path";
import {
  isRunEvent,
  type RunEventInput,
  type RunState,
  type ToolResultEvent,
  type TouchedFile,
} from "../projection/types.js";

export type { TouchedFile } from "../projection/types.js";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
export const toolName = (name: unknown): string =>
  String(name ?? "")
    .split(/[.:/]/)
    .pop()
    ?.replace(/^.*__/, "")
    .toLowerCase() ?? "";
export function parseArguments(raw: unknown): Record<string, unknown> {
  if (object(raw)) return raw;
  try {
    const value: unknown = JSON.parse(String(raw));
    return object(value) ? value : {};
  } catch {
    return {};
  }
}
// Only paths and operation intent enter the projection; never retain write/patch text.
export function mutationIntents(name: unknown, raw: unknown): TouchedFile[] {
  const args = parseArguments(raw);
  const tool = toolName(name);
  const p = args.file_path ?? args.path;
  if (
    [
      "write",
      "edit",
      "delete",
      "delete_file",
      "remove",
      "move",
      "move_file",
    ].includes(tool)
  ) {
    if (tool === "move" || tool === "move_file") {
      const source = args.source ?? args.source_path ?? args.from ?? p;
      const destination =
        args.destination ?? args.destination_path ?? args.to ?? args.target;
      const result: TouchedFile[] = [];
      if (validPath(source)) result.push({ path: source, kind: "removed" });
      if (validPath(destination))
        result.push({ path: destination, kind: "added" });
      return result;
    }
    return validPath(p)
      ? [
          {
            path: p,
            kind: tool === "write" || tool === "edit" ? "edited" : "removed",
          },
        ]
      : [];
  }
  if (tool !== "apply_patch") return [];
  const result: TouchedFile[] = [];
  for (const line of String(args.input ?? args.patch ?? "").split("\n")) {
    const match =
      /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const [, kind, p] = match;
    if (p === undefined) continue;
    if (kind === "Move to") {
      const previous = result.at(-1);
      if (previous) previous.kind = "removed";
      result.push({ path: p, kind: "added" });
    } else {
      result.push({
        path: p,
        kind:
          kind === "Add File"
            ? "added"
            : kind === "Delete File"
              ? "removed"
              : "edited",
      });
    }
  }
  return result.filter((item) => validPath(item.path));
}
const textOf = (data: ToolResultEvent["data"]): string =>
  (data.message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
export interface MutationCall {
  name: string;
  mutations?: readonly TouchedFile[];
  arguments?: unknown;
}
type PathDiff = Record<string, unknown> & { path: string };
const validDiff = (value: unknown): value is PathDiff =>
  object(value) && validPath(value.path);
export function successfulMutations(
  call: MutationCall,
  event: ToolResultEvent,
): TouchedFile[] {
  const d = event.data;
  if (d.error || d.message.isError) return [];
  const meta = object(d.meta) ? d.meta : {};
  const intents = call.mutations ?? mutationIntents(call.name, call.arguments);
  const diffs: PathDiff[] = Array.isArray(meta.diffs)
    ? meta.diffs.filter(validDiff)
    : [];
  const result = intents.map((item) => ({ ...item }));
  if (meta.stopped === true) {
    // Stopped patches are not all-or-nothing; only applied diff metadata is proof.
    return [...new Set(diffs.map((diff) => diff.path))].map((p) => ({
      path: p,
      kind: "edited",
      sourceSeq: event.seq,
    }));
  }
  const only = result.length === 1 ? result[0] : undefined;
  if (only && validPath(meta.path)) only.path = meta.path;
  for (const item of result) {
    const canonical = diffs.find(
      (diff) =>
        diff.path === item.path ||
        (!path.isAbsolute(item.path) && diff.path.endsWith("/" + item.path)),
    );
    if (canonical) item.path = canonical.path;
    if (meta.operation === "create" && result.length === 1) item.kind = "added";
    else if (meta.operation === "update" && result.length === 1)
      item.kind = "edited";
    else if (
      toolName(call.name) === "write" &&
      /<content>\s*Created file\s*<\/content>/.test(textOf(d))
    )
      item.kind = "added";
    item.sourceSeq = event.seq;
  }
  // Applied diffs are authoritative even for tools whose names are not known here.
  for (const diff of diffs) {
    if (!result.some((item) => item.path === diff.path))
      result.push({ path: diff.path, kind: "edited", sourceSeq: event.seq });
  }
  return result;
}
export function aggregateTouched(
  files: readonly TouchedFile[],
  changes: readonly TouchedFile[],
): TouchedFile[] {
  const result = files.map((item) => ({ ...item }));
  for (const change of changes) {
    const index = result.findIndex((item) => item.path === change.path);
    const previous = result[index];
    if (!previous) {
      result.push({ ...change });
      continue;
    }
    const kind =
      change.kind === "removed"
        ? "removed"
        : previous.kind === "added"
          ? "added"
          : previous.kind === "removed"
            ? "edited"
            : change.kind;
    result[index] = { ...previous, ...change, kind };
  }
  return result;
}
// Full removal diffs in presentation metadata contain the entire LF-normalized basis.
// Do not reconstruct arbitrary edit hunks, read windows, or model prose as a file.
export function removedContent(
  events: readonly RunEventInput[],
  file: TouchedFile,
): string | undefined {
  const event = events.find(
    (item) => item.seq === file.sourceSeq && item.type === "tool/result",
  );
  if (
    !event ||
    !isRunEvent(event) ||
    event.type !== "tool/result" ||
    event.data.error ||
    event.data.message.isError
  )
    return undefined;
  const meta = event.data.meta;
  if (!object(meta)) return undefined;
  if (
    meta.path === file.path &&
    typeof meta.before === "string" &&
    meta.after === null
  )
    return meta.before;
  const diffs: PathDiff[] = Array.isArray(meta.diffs)
    ? meta.diffs.filter(
        (diff: unknown): diff is PathDiff =>
          object(diff) && diff.path === file.path,
      )
    : [];
  const diff = diffs.length === 1 ? diffs[0] : undefined;
  if (
    file.kind === "removed" &&
    diff &&
    typeof diff.oldText === "string" &&
    diff.newText === ""
  )
    return diff.oldText;
  return undefined;
}
export interface WorkspaceSummary {
  turn: number;
  cwd: string;
  files: readonly { path: string }[];
}
export interface WorkspaceSummaryService {
  summary(sessionId: string, seq: number): WorkspaceSummary | null | undefined;
}
export function workspaceTouched(
  state: Pick<RunState, "workspaceSeqs" | "turn" | "touchedFiles">,
  sessionId: string,
  service?: WorkspaceSummaryService,
): TouchedFile[] {
  const seq = state.workspaceSeqs?.at(-1);
  const summary =
    seq === undefined ? undefined : service?.summary(sessionId, seq);
  if (!summary || summary.turn !== state.turn) return state.touchedFiles;
  const files: TouchedFile[] = state.touchedFiles.map((file) => ({
    ...file,
    cwd: summary.cwd,
  }));
  for (const [sourceIndex, item] of summary.files.entries()) {
    if (!validPath(item.path)) continue;
    const existing = files.find(
      (file) =>
        path.resolve(summary.cwd, file.path) ===
        path.resolve(summary.cwd, item.path),
    );
    if (existing) continue;
    files.push({
      path: item.path,
      kind: "edited",
      cwd: summary.cwd,
      sourceSeq: seq,
      sourceIndex,
    });
  }
  return files;
}
export interface ResolveTouchedOptions {
  cwd?: string;
  signal?: AbortSignal;
}
// A Host provider owns resolution and canonical containment. Handle deliberately
// need not be a native path (or expose one); never pass it to node:path/node:fs.
export interface TouchedFileSystem<Handle> {
  resolve(path: string, options?: ResolveTouchedOptions): Promise<Handle>;
  contains(root: Handle, target: Handle): boolean;
  stat(
    target: Handle,
    signal?: AbortSignal,
  ): Promise<{ type: string; size: number } | null | undefined>;
  readBytes(
    target: Handle,
    signal?: AbortSignal,
    maxBytes?: number,
  ): Promise<Uint8Array>;
}
export interface ReadTouchedFileOptions {
  cwd: string;
  file: TouchedFile;
  events: readonly RunEventInput[];
  signal?: AbortSignal;
}
export interface TouchedFileResult {
  name: string;
  content: Buffer;
}
export async function readTouchedFile<Handle>(
  ctx: { fs: TouchedFileSystem<Handle> },
  { cwd, file, events, signal }: ReadTouchedFileOptions,
): Promise<TouchedFileResult> {
  if (!validPath(file.path) || typeof cwd !== "string")
    throw Error("Invalid touched file path");
  const root = await ctx.fs.resolve(cwd, { signal });
  const target = await ctx.fs.resolve(file.path, {
    cwd: file.cwd ?? cwd,
    signal,
  });
  if (!ctx.fs.contains(root, target))
    throw Error("File is outside the session workspace");
  let content: Buffer;
  if (file.kind === "removed") {
    const before = removedContent(events, file);
    if (before === undefined)
      throw Error(
        "Removed file content is not available in the trusted session log",
      );
    content = Buffer.from(before);
  } else {
    const info = await ctx.fs.stat(target, signal);
    if (!info || info.type !== "file")
      throw Error("Touched file is no longer a regular file");
    if (info.size > MAX_FILE_BYTES)
      throw Error("File exceeds the 10 MiB upload limit");
    content = Buffer.from(
      await ctx.fs.readBytes(target, signal, MAX_FILE_BYTES),
    );
  }
  if (content.length > MAX_FILE_BYTES)
    throw Error("File exceeds the 10 MiB upload limit");
  return { name: path.basename(file.path), content };
}
