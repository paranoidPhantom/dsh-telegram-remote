import type { ZodType } from "zod";
import type { ToolNameRule } from "../rendering/tool-name.js";
import type {
  BridgeContext,
  CredentialsService,
  HostSession,
  HostRunEvent,
  LocaleSettingsService,
  WorkspaceChangesService,
  SettingsRouteContext,
} from "./dsh-contracts.js";
import type {
  ArtifactAgent,
  ArtifactFileSystem,
  SendFileTool,
} from "../files/send-file.js";
import type { JsonValue } from "../protocol/json.js";
import type { ApprovalOutcome } from "./approvals.js";

import type { RpcPeer } from "../protocol/rpc.js";
import type { SupervisorOptions, SupervisorState } from "./supervisor.js";

export interface SupervisorPort {
  readonly state: SupervisorState;
  readonly currentGeneration: string;
  readonly pid: number | undefined;
  readonly peer: RpcPeer | undefined;
  start(): Promise<void>;
  close(): Promise<void>;
}
export interface ActivationDependencies {
  createSupervisor?(options: SupervisorOptions): SupervisorPort;
}

export interface ActivationConfig {
  ownerId: number;
  credentialKey: string;
  bootstrapPath?: string;
  statusPath?: string;
  toolNameRules?: ToolNameRule[];
}
export type Registration = (() => void | Promise<void>) | void;
export interface DeliveryTable {
  get(key: string): Promise<JsonValue | undefined>;
  put(key: string, value: JsonValue): Promise<void>;
  entries(): Iterable<readonly [string, JsonValue]>;
}
export interface DeliveryDomain {
  table(name: "delivery"): DeliveryTable;
  close(): void | Promise<void>;
}
export interface StreamEvent<Handle> {
  agent: ArtifactAgent<Handle>;
  frame:
    | { type: "start"; attemptId: string; turn: number }
    | {
        type: "chunk";
        attemptId: string;
        chunk: { type: string; text?: string };
      }
    | { type: "end"; attemptId: string };
}
export interface HostApproval<Handle> {
  agent: ArtifactAgent<Handle> & {
    session: { id: string; snapshotEvents(): HostRunEvent[] };
  };
  callId: string;
  toolName: string;
  displayReason?: { en?: string };
  reason?: string;
  onReason?(reason: string): unknown;
  signal?: AbortSignal;
}
/** Narrow structural contracts for calls already made by the legacy activation. */
export interface ActivationContext<Handle>
  extends BridgeContext<Handle>, SettingsRouteContext {
  fs: ArtifactFileSystem<Handle>;
  get(name: "workspaceChanges"): WorkspaceChangesService | null | undefined;
  get(name: "settings"): LocaleSettingsService | null | undefined;
  credentials: CredentialsService;
  storageDomain: {
    open(options: {
      name: "telegram_console_delivery";
      version: 1;
      tables: { delivery: { valueSchema: ZodType<JsonValue> } };
    }): Promise<DeliveryDomain>;
  };
  tools: { register(tool: SendFileTool<Handle>): Registration };
  systemPrompt: {
    section(section: {
      name: string;
      order: number;
      interpolate: false;
      text: string;
    }): Registration;
  };
  on(
    name: "session/event",
    listener: (session: HostSession, event: HostRunEvent) => void,
  ): Registration;
  on(
    name: "agent/assistant-stream",
    listener: (event: StreamEvent<Handle>) => void,
  ): Registration;
  on(
    name: "tools/result",
    listener: (
      exec: {
        name: string;
        agent?: ArtifactAgent<Handle>;
        arguments: Record<string, unknown>;
      },
      result: { isError?: boolean },
    ) => void,
  ): Registration;
  on(
    name: "approval/request",
    listener: (
      request: HostApproval<Handle>,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>,
    options: { prepend: true },
  ): Registration;
}
