import {
  readTouchedFile,
  workspaceTouched,
  MAX_FILE_BYTES,
  type TouchedFile,
  type TouchedFileResult,
} from "../files/touched-files.js";
import {
  runProjection,
  initialRun,
  foldRun,
  type RunState,
} from "../projection/run-projection.js";
import { isRunEvent } from "../projection/types.js";
import { newSessionSelection } from "./session-selection.js";
import type {
  AttachmentReference,
  BridgeContext,
  HostSession,
  ModelSelection,
  QueueAcknowledgement,
  SessionState,
} from "../host/dsh-contracts.js";
import type { JsonValue } from "../protocol/json.js";
export { textOf, initialRun, foldRun } from "../projection/run-projection.js";

export interface SessionSummary {
  id: string;
  title: string;
  running: boolean;
  cwd: string;
  lastActivity: number;
  model: string;
}
export interface SessionMetadata extends SessionSummary {
  selection: ModelSelection | null;
  activeModel: string;
  turns: number | null;
  context: JsonValue;
  queue: SessionState["queue"];
  pendingInput: SessionState["pendingInput"];
}
export interface AvailableModel {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  description?: string;
}
export interface RunView extends RunState {
  cwd: string;
  elapsed: number;
}
/** Host-only operations accept a live session and must never become remote RPC. */
export interface LocalBridge {
  touchedFiles(session: HostSession): TouchedFile[];
  runView(session: HostSession): RunView;
  dispose(): Promise<void>;
}
/** Async identifier-based surface. File bytes still need an explicit transport codec. */
export interface RemoteBridge {
  list(): Promise<SessionSummary[]>;
  metadata(id: string): Promise<SessionMetadata>;
  models(): Promise<AvailableModel[]>;
  selectModel(
    id: string,
    selection: ModelSelection,
  ): Promise<ModelSelection & { appliesAtNextStep: boolean }>;
  newSessionSelection(sourceId?: string): Promise<ModelSelection>;
  workspaces(): Promise<{ id: string; title: string; path: string }[]>;
  create(workspaceId?: string): Promise<string>;
  prompt(
    id: string,
    text: string,
    requestId: string,
  ): Promise<QueueAcknowledgement>;
  steerQueued(id: string, requestId: string): Promise<QueueAcknowledgement>;
  stop(id: string): Promise<unknown>;
  details(id: string): Promise<string>;
  files(id: string): Promise<TouchedFileResult[]>;
  fileForTurn(
    id: string,
    turn: number,
    filePath: string,
  ): Promise<TouchedFileResult>;
}
/** Preserve the existing flat call syntax while exposing the authority split. */
export type Bridge = LocalBridge & RemoteBridge;

function attachmentOf(block: unknown): AttachmentReference | undefined {
  if (
    !block ||
    typeof block !== "object" ||
    !("type" in block) ||
    block.type !== "file" ||
    !("attachment" in block)
  )
    return undefined;
  const ref = block.attachment;
  if (
    !ref ||
    typeof ref !== "object" ||
    !("attachmentId" in ref) ||
    !("name" in ref) ||
    !("bytes" in ref)
  )
    return undefined;
  if (
    typeof ref.attachmentId !== "string" ||
    typeof ref.name !== "string" ||
    typeof ref.bytes !== "number"
  )
    return undefined;
  return ref as AttachmentReference;
}

export async function createBridge<Handle>(
  ctx: BridgeContext<Handle>,
  signal?: AbortSignal,
): Promise<Bridge> {
  const run = await ctx.sessionProjections.register(runProjection);
  const controller = ctx.sessionController;
  const bridge: Bridge = {
    async list() {
      const { items } = await controller.list({}, signal);
      return items
        .filter((item) => !item.parentSessionId)
        .map((item) => ({
          id: item.sessionId,
          title:
            item.projections?.values?.title ||
            `Session ${item.sessionId.slice(-8)}`,
          running: item.running,
          cwd: item.cwd,
          lastActivity: item.updatedAt,
          model:
            item.projections?.values?.modelSelection?.next?.model ??
            "Not selected",
        }));
    },
    async metadata(id) {
      const observation = await ctx.sessionQuery.observeSession(id, {
        signal,
        projectionMode: "all",
      });
      try {
        const p = observation.projections?.values ?? {};
        const state = await controller.state({ sessionId: id }, signal);
        const selection =
          p.modelSelection?.next ??
          p.modelSelection?.pending ??
          p.modelSelection?.lastUsed ??
          null;
        return {
          id,
          selection,
          title: p.title || `Session ${id.slice(-8)}`,
          model: selection?.model ?? "Not selected",
          activeModel: p.modelSelection?.lastUsed?.model ?? "Not used yet",
          turns: p.sessionStats?.turns ?? p.turnBoundary?.lastTurn ?? null,
          context: p.contextPressure ?? null,
          cwd:
            p.workingDirectory ??
            observation.header.cwd ??
            ctx.workingDirectory.defaultDirectory,
          lastActivity:
            observation.events.at(-1)?.time ?? observation.header.createdAt,
          running: state.running,
          queue: state.queue,
          pendingInput: state.pendingInput,
        };
      } finally {
        observation[Symbol.dispose]();
      }
    },
    async models() {
      const catalog = await controller.modelCatalog();
      return catalog.groups.flatMap((group) =>
        group.models.map((model) => ({
          provider: group.id,
          providerName: group.name,
          id: model.id,
          name: model.name,
          description: model.description,
        })),
      );
    },
    async selectModel(id, selection) {
      const ack = await controller.selectModel({ sessionId: id, ...selection });
      const state = await controller.state({ sessionId: id }, signal);
      return { ...ack.selected, appliesAtNextStep: state.running };
    },
    async newSessionSelection(sourceId) {
      return newSessionSelection(
        { controller, metadata: (id) => bridge.metadata(id), signal },
        sourceId,
      );
    },
    async workspaces() {
      return (ctx.workspaceRegistry?.list() ?? []).map(
        ({ id, title, path }) => ({ id, title, path }),
      );
    },
    async create(workspaceId) {
      if (
        workspaceId !== undefined &&
        !(await bridge.workspaces()).some((w) => w.id === workspaceId)
      )
        throw new Error("Workspace is no longer available");
      return (
        await controller.create(
          workspaceId === undefined ? {} : { workspaceId },
        )
      ).sessionId;
    },
    async prompt(id, text, requestId) {
      return controller.prompt(
        {
          sessionId: id,
          requestId,
          mode: "queue",
          content: [{ type: "text", text }],
        },
        signal,
      );
    },
    async steerQueued(id, requestId) {
      const state = await controller.state({ sessionId: id }, signal);
      const item = state.queue?.find((item) => item.rpcId === requestId);
      if (!item)
        return {
          accepted: false,
          reason: "This message has already left the queue.",
        };
      if (item.placement === "steering") return { accepted: true };
      return controller.updateQueue({
        sessionId: id,
        itemId: item.id,
        action: { kind: "steer" },
      });
    },
    async stop(id) {
      return controller.cancel({ sessionId: id });
    },
    async details(id) {
      const page = await controller.events(
        { address: { kind: "session", sessionId: id }, maxMessages: 30 },
        signal,
      );
      const events = page.records.map((record) => record.event);
      const start = events.findLastIndex(
        (event) => event.type === "turn/start",
      );
      const recent = start >= 0 ? events.slice(start) : events;
      const tools = recent.flatMap((event) =>
        isRunEvent(event) && event.type === "tool/call"
          ? [event.data.name]
          : [],
      );
      const failed = recent.filter(
        (event) =>
          isRunEvent(event) && event.type === "tool/result" && event.data.error,
      ).length;
      const first = recent[0]?.time,
        last = recent.at(-1)?.time;
      return [
        tools.length
          ? `${tools.length} tool ${tools.length === 1 ? "call" : "calls"} · ${[...new Set(tools)].join(", ")}`
          : "No tool calls",
        failed ? `${failed} tool ${failed === 1 ? "failure" : "failures"}` : "",
        first && last
          ? `Elapsed: ${Math.max(0, (last - first) / 1000).toFixed(1)} s`
          : "",
        page.hasMore ? "Recent activity only" : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    async files(id) {
      const observation = await ctx.sessionQuery.observeSession(id, {
        signal,
        projectionMode: "none",
      });
      try {
        const refs = new Map<string, AttachmentReference>();
        for (const event of observation.events) {
          if (!isRunEvent(event) || event.type !== "tool/result") continue;
          for (const block of event.data.message.content ?? []) {
            const ref = attachmentOf(block);
            if (ref) refs.set(ref.attachmentId, ref);
          }
        }
        const results: TouchedFileResult[] = [];
        for (const ref of [...refs.values()].slice(-10)) {
          if (ref.bytes > MAX_FILE_BYTES) continue;
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const bytes of ctx.attachments.readFileStream(
            ref,
            signal,
          )) {
            size += bytes.length;
            if (size > MAX_FILE_BYTES)
              throw Error("Artifact exceeds upload limit");
            chunks.push(bytes);
          }
          results.push({ name: ref.name, content: Buffer.concat(chunks) });
        }
        return results;
      } finally {
        observation[Symbol.dispose]();
      }
    },
    touchedFiles(session) {
      return workspaceTouched(
        run.stateOf(session),
        session.id,
        ctx.get?.("workspaceChanges") ?? undefined,
      );
    },
    async fileForTurn(id, turn, filePath) {
      if (
        !Number.isSafeInteger(turn) ||
        turn < 1 ||
        typeof filePath !== "string"
      )
        throw Error("Invalid turn file request");
      const observation = await ctx.sessionQuery.observeSession(id, {
        signal,
        projectionMode: "all",
      });
      try {
        let state = initialRun(),
          selected: RunState | null = null;
        for (const event of observation.events) {
          if (event.type === "turn/start" && state.turn === turn) {
            selected = state;
            break;
          }
          state = foldRun(state, event);
        }
        selected ??= state.turn === turn ? state : null;
        const file =
          selected &&
          workspaceTouched(
            selected,
            id,
            ctx.get?.("workspaceChanges") ?? undefined,
          ).find((item) => item.path === filePath);
        if (!file)
          throw Error("File was not successfully touched in this turn");
        const cwd =
          observation.header.cwd ?? ctx.workingDirectory.defaultDirectory;
        return await readTouchedFile(ctx, {
          cwd,
          file,
          events: observation.events,
          signal,
        });
      } finally {
        observation[Symbol.dispose]();
      }
    },
    runView(session) {
      const state = run.stateOf(session);
      return {
        ...state,
        cwd: ctx.workingDirectory.get(session),
        touchedFiles: bridge.touchedFiles(session),
        elapsed: Math.max(
          0,
          ((state.ended || Date.now()) - state.started) / 1000,
        ),
      };
    },
    async dispose() {
      await run.dispose();
    },
  };
  return bridge;
}
