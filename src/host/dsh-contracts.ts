import type { IncomingHttpHeaders } from "node:http";
import type {
  runProjection,
  initialRun,
  foldRun,
} from "../projection/run-projection.js";
import type {
  TouchedFileSystem,
  WorkspaceSummaryService,
} from "../files/touched-files.js";
import type { JsonValue } from "../protocol/json.js";

/** Structural contracts for Host calls already used by the plugin, not a DSH SDK. */
export interface HostSession {
  readonly id: string;
}
export interface ModelSelection {
  provider: string;
  model: string;
}
export interface ModelSelectionProjection {
  next?: ModelSelection | null;
  pending?: ModelSelection | null;
  lastUsed?: ModelSelection | null;
}
export interface SessionProjectionValues {
  title?: string | null;
  modelSelection?: ModelSelectionProjection | null;
  sessionStats?: { turns?: number | null } | null;
  turnBoundary?: { lastTurn?: number | null } | null;
  contextPressure?: JsonValue;
  workingDirectory?: string | null;
}
export interface SessionListItem {
  sessionId: string;
  parentSessionId?: string | null;
  running: boolean;
  cwd: string;
  updatedAt: number;
  projections?: { values?: SessionProjectionValues } | null;
}
export interface ModelCatalog {
  default?: ModelSelection | null;
  groups: {
    id: string;
    name: string;
    models: { id: string; name: string; description?: string }[];
  }[];
}
export interface QueuedRequest {
  id: string;
  rpcId?: string;
  placement?: string;
}
export interface SessionState {
  running: boolean;
  queue?: QueuedRequest[];
  pendingInput?: JsonValue;
}
export interface QueueAcknowledgement {
  accepted: boolean;
  reason?: string;
}
export interface SessionController {
  list(
    options: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<{ items: SessionListItem[] }>;
  state(
    options: { sessionId: string },
    signal?: AbortSignal,
  ): Promise<SessionState>;
  modelCatalog(): Promise<ModelCatalog>;
  selectModel(
    options: ModelSelection & { sessionId: string },
  ): Promise<{ selected: ModelSelection }>;
  create(options: Record<string, never>): Promise<{ sessionId: string }>;
  prompt(
    options: {
      sessionId: string;
      requestId: string;
      mode: "queue";
      content: { type: "text"; text: string }[];
    },
    signal?: AbortSignal,
  ): Promise<QueueAcknowledgement>;
  updateQueue(options: {
    sessionId: string;
    itemId: string;
    action: { kind: "steer" };
  }): Promise<QueueAcknowledgement>;
  cancel(options: { sessionId: string }): Promise<unknown>;
  events(
    options: {
      address: { kind: "session"; sessionId: string };
      maxMessages: number;
    },
    signal?: AbortSignal,
  ): Promise<{ records: { event: HostRunEvent }[]; hasMore: boolean }>;
}
export type HostRunEvent = Parameters<typeof foldRun>[1];
export type HostRunState = ReturnType<typeof initialRun>;
export interface SessionObservation {
  header: { cwd?: string | null; createdAt: number };
  projections?: { values?: SessionProjectionValues } | null;
  events: HostRunEvent[];
  [Symbol.dispose](): void;
}
export interface SessionQuery {
  observeSession(
    id: string,
    options: { signal?: AbortSignal; projectionMode: "all" | "none" },
  ): Promise<SessionObservation>;
}
export interface RunProjectionHandle {
  stateOf(session: HostSession): HostRunState;
  dispose(): void | Promise<void>;
}
export interface SessionProjections {
  register(projection: typeof runProjection): Promise<RunProjectionHandle>;
}
export interface AttachmentReference {
  attachmentId: string;
  name: string;
  bytes: number;
}
export interface AttachmentsService {
  readFileStream(
    reference: AttachmentReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}
export interface WorkingDirectoryService {
  defaultDirectory: string;
  get(session: HostSession): string;
}
export type WorkspaceChangesService = WorkspaceSummaryService;
/** Optional services remain separate: a locale-only fixture need not provide filesystem services. */
export interface WorkspaceChangesLookup {
  get?(name: "workspaceChanges"): WorkspaceChangesService | null | undefined;
}
export interface LocaleDocument {
  ns?: unknown;
  value?: { preference?: unknown } | null;
}
export interface LocaleSettingsService {
  describe(options: {
    redactSecrets: true;
  }): readonly LocaleDocument[] | null | undefined;
}
export interface SettingsLookup {
  get?(name: "settings"): LocaleSettingsService | null | undefined;
}
export interface BridgeContext<
  Handle = unknown,
> extends WorkspaceChangesLookup {
  fs: TouchedFileSystem<Handle>;
  sessionController: SessionController;
  sessionQuery: SessionQuery;
  sessionProjections: SessionProjections;
  workingDirectory: WorkingDirectoryService;
  attachments: AttachmentsService;
}
export interface CredentialRecord {
  kind: string;
  key?: string;
}
export interface ApiKeyCredential {
  kind: "api-key";
  key: string;
}
export interface CredentialsService {
  describeRecord(key: string): Promise<{ configured: boolean }>;
  readRecord(key: string): Promise<CredentialRecord | null | undefined>;
  modifyRecord(
    key: string,
    update: () => Promise<ApiKeyCredential>,
  ): Promise<unknown>;
}
export interface SettingsStore {
  entries(): Promise<Iterable<readonly [string, JsonValue]>>;
  set(key: string, value: JsonValue): Promise<unknown>;
}
export interface SettingsRequest extends AsyncIterable<Uint8Array> {
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
}
export interface SettingsResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}
export type SettingsHandler = (
  request: SettingsRequest,
  response: SettingsResponse,
) => Promise<void>;
export type RouteDisposer = (() => void | Promise<void>) | void;
export interface SettingsRouteContext {
  effect(callback: () => RouteDisposer): unknown;
  webServer: {
    register(route: {
      kind: "exact";
      path: "/telegram-console/settings";
      handler: SettingsHandler;
    }): RouteDisposer;
    getOrigin(): string;
  };
  connection: {
    requestRejection(request: {
      headers: IncomingHttpHeaders;
    }): number | null | undefined;
    admit(request: {
      headers: IncomingHttpHeaders;
    }): { rejection: unknown } | { peer: { principal: { kind: string } } };
  };
}
