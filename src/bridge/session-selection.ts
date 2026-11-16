import type {
  ModelSelection,
  SessionController,
} from "../host/dsh-contracts.js";

export interface SessionSelectionDependencies {
  controller: Pick<SessionController, "list" | "modelCatalog">;
  metadata?: (
    id: string,
  ) => Promise<{ selection?: ModelSelection | null } | null | undefined>;
  signal?: AbortSignal;
}

/** Resolve suggestions from DSH on each request; no bot-side model preference. */
export async function newSessionSelection(
  { controller, metadata, signal }: SessionSelectionDependencies,
  sourceId?: string,
): Promise<ModelSelection> {
  if (sourceId) {
    if (!metadata) throw Error("Source session metadata is required");
    const current = await metadata(sourceId);
    if (current?.selection?.provider && current.selection.model)
      return { ...current.selection };
  }
  const { items } = await controller.list({}, signal);
  const recent = items
    .filter((item) => !item.parentSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const item of recent) {
    const value = item.projections?.values?.modelSelection;
    const selection = value?.next ?? value?.pending ?? value?.lastUsed;
    if (selection?.provider && selection.model) return { ...selection };
  }
  const selection = (await controller.modelCatalog()).default;
  if (!selection?.provider || !selection.model)
    throw Error("DSH has no model selected. Select one in DSH first.");
  return { ...selection };
}
