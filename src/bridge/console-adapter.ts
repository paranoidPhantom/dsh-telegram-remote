import type { Bridge, RunView as HostRunView } from "./bridge.js";
import type {
  ConsoleBridge,
  SessionMetadata,
  RunView,
} from "../bot/contracts.js";

/** Explicit adaptation keeps Host metadata/projection shapes out of bot contracts. */
export function consoleBridge(bridge: Bridge): ConsoleBridge {
  const metadata = async (id: string): Promise<SessionMetadata> => {
    const value = await bridge.metadata(id);
    const context = value.context;
    return {
      id: value.id,
      title: value.title,
      model: value.model,
      activeModel: value.activeModel,
      cwd: value.cwd,
      running: value.running,
      lastActivity: value.lastActivity,
      ...(value.selection ? { selection: value.selection } : {}),
      ...(value.turns === null ? {} : { turns: value.turns }),
      context:
        typeof context === "string" || typeof context === "number"
          ? context
          : null,
    };
  };
  return {
    list: () => bridge.list(),
    metadata,
    models: () => bridge.models(),
    selectModel: async (id, selection) => {
      const result = await bridge.selectModel(id, selection);
      return {
        accepted: true,
        deferred: result.appliesAtNextStep,
        running: result.appliesAtNextStep,
      };
    },
    workspaces: () => bridge.workspaces(),
    create: (workspaceId) => bridge.create(workspaceId),
    newSessionSelection: (id) => bridge.newSessionSelection(id),
    prompt: (id, text, requestId) => bridge.prompt(id, text, requestId),
    stop: (id) => bridge.stop(id),
    details: (id) => bridge.details(id),
    files: (id) => bridge.files(id),
    fileForTurn: (id, turn, path) => {
      if (typeof turn !== "number") throw new Error("Invalid turn");
      return bridge.fileForTurn(id, turn, path);
    },
    steerQueued: (id, requestId) => bridge.steerQueued(id, requestId),
  };
}

/** Only semantic normal output and bounded reasoning previews are published. Never serialize the projection wholesale. */
export function semanticRunView(view: HostRunView): RunView & { turn: number } {
  return {
    turn: view.turn,
    todos: view.todos,
    todoVersion: view.todoVersion,
    final: view.final,
    status: view.status,
    answer: view.answer,
    partialAnswer: view.partialAnswer,
    outputs: view.outputs.map((output) => ({
      id: output.id,
      text: output.text,
      toolCount: output.toolCount,
      logCount: output.logCount,
    })),
    toolLog: view.toolLog.map((tool) => ({
      name: tool.name,
      summary: tool.summary,
      status: tool.status,
      ...(tool.resultHtml ? { resultHtml: tool.resultHtml } : {}),
      callId: tool.callId,
    })),
    runLog: view.activityLog.flatMap<import("../bot/contracts.js").ToolSummary>(
      (entry) => {
        if (entry.kind === "reasoning")
          return [{ kind: "reasoning" as const, text: entry.text }];
        const tool = view.toolLog.find((tool) => tool.callId === entry.callId);
        return tool
          ? [
              {
                kind: "tool" as const,
                name: tool.name,
                summary: tool.summary,
                status: tool.status,
                callId: tool.callId,
                ...(tool.resultHtml ? { resultHtml: tool.resultHtml } : {}),
              },
            ]
          : [];
      },
    ),
    touchedFiles: view.touchedFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
    })),
    cwd: view.cwd,
    elapsed: view.elapsed,
  };
}
