import type { Translator } from "../i18n/bot-i18n.js";
import type { ToolNameRule } from "../rendering/tool-name.js";
import type {
  SessionMetadata as RenderMetadata,
  ToolLogEntry,
} from "../rendering/console-render.js";
import type { AnswerEntity } from "../rendering/answer-format.js";

export type SessionId = string;
export type TurnId = string | number;
export interface TopicContext {
  chatId: number;
  threadId: number;
}
export interface TopicBinding extends TopicContext {
  todoReceipt?: {
    chatId: number;
    threadId: number;
    messageId?: number;
    hash?: string;
    pinned?: boolean;
    pending?: boolean;
    version?: number;
  };
  cardId?: number;
  latestControlMessageId?: number;
  topicTitle?: string;
  topicClosed?: boolean;
  deleted?: boolean;
  closed?: boolean;
  activeTurn?: TurnId;
}
export interface BoundTopic extends TopicBinding {
  id: SessionId;
}
export interface ControlsReceipt {
  cardId?: number;
  latestControlMessageId?: number;
}
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface SessionMetadata extends RenderMetadata {
  id?: SessionId;
  selection?: ModelSelection;
  cwd?: string;
  turns?: number;
  lastActivity?: number;
}
export interface SessionListEntry extends SessionMetadata {
  id: SessionId;
}
export interface WorkspaceEntry {
  id: string;
  title: string;
  path: string;
}
export interface ModelReasoning {
  efforts: { id: string; name: string; description?: string }[];
  defaultEffort?: string;
}
export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
  description?: string;
  reasoning?: ModelReasoning;
}
export interface SelectionReceipt {
  ok?: boolean;
  accepted?: boolean;
  success?: boolean;
  error?: string;
  reason?: string;
  appliesNextTurn?: boolean;
  running?: boolean;
  deferred?: boolean;
}
export type FileChangeKind = "added" | "removed" | "edited";
export interface TouchedFile {
  path: string;
  kind: FileChangeKind;
}
export interface ToolSummary extends ToolLogEntry {
  callId?: string;
}
export interface CommittedOutput {
  id: string;
  text: string;
  toolCount?: number;
  logCount?: number;
}
/** Committed normal text and the current transient attempt are deliberately separate. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export interface RunView {
  todos?: TodoItem[];
  todoVersion?: number;
  turn: TurnId;
  final?: boolean;
  status?: string;
  answer?: string;
  partialAnswer?: string;
  partialId?: string;
  outputs?: CommittedOutput[];
  toolLog?: ToolSummary[];
  /** Chronological presentation rows; reasoning never counts as a tool call. */
  runLog?: ToolSummary[];
  touchedFiles?: TouchedFile[];
  cwd?: string;
  tools?: string[];
  elapsed?: number;
  logEnd?: number;
}
export interface ActiveRun {
  view: RunView;
  draftId: number;
}
export interface OutputReceipt {
  id: string;
  hash: string;
  messageIds: number[];
  format?: "rich-v1";
  pending?: boolean;
  complete?: boolean;
  /** Terminal delivery exception, not success; retained to prevent blind replay. */
  quarantine?: "uncertain" | "rejected" | "invalid";
  /** Tool-log boundary captured before sending this committed output. */
  segmentEnd?: number;
}
/** Delivery metadata only: never persist answer text or DSH model/session truth. */
export interface RunReceipt extends TopicContext {
  id: SessionId;
  draftId: number;
  messageId?: number;
  answerPreview?: boolean;
  final?: boolean;
  superseded?: boolean;
  /** Legacy final delivery exception; never treated as accepted output. */
  quarantine?: "uncertain" | "rejected" | "invalid";
  outputs?: OutputReceipt[];
  finalMessageIds?: number[];
  finalFormat?: "rich-v1";
  logMessageIds?: number[];
  sealedLogMessageIds?: number[];
  logStart?: number;
  /** Absent receipts retain legacy tool-only boundary indices for this turn. */
  logFormat?: "activity-v1";
  lastOutputHash?: string;
}
/** Old activations can have only message IDs; they are used solely for cleanup. */
export type HistoricalRunReceipt = Partial<RunReceipt>;
export interface ConsoleStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  entries(): Promise<Iterable<[string, unknown]>>;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  style?: "primary" | "success" | "danger";
  icon_custom_emoji_id?: string;
}
export interface InlineMarkup {
  inline_keyboard: InlineButton[][];
}
export interface ForceReplyMarkup {
  force_reply: true;
  selective: true;
}
export interface TelegramEntity extends Omit<AnswerEntity, "type"> {
  type: AnswerEntity["type"] | "custom_emoji";
  custom_emoji_id?: string;
}
export interface MessageOptions {
  rich_message?: { markdown: string; skip_entity_detection?: boolean };
  disable_notification?: boolean;
  parse_mode?: "HTML";
  entities?: TelegramEntity[];
  reply_markup?: InlineMarkup | ForceReplyMarkup;
}
export interface TelegramMessageResult {
  message_id: number;
}
export type TelegramMethod =
  | "sendMessage"
  | "sendRichMessage"
  | "sendRichMessageDraft"
  | "editMessageText"
  | "editMessageReplyMarkup"
  | "pinChatMessage"
  | "editForumTopic"
  | "reopenForumTopic"
  | "createForumTopic"
  | "deleteForumTopic"
  | "answerCallbackQuery"
  | "getMe"
  | "sendMessageDraft"
  | "sendChatAction"
  | "deleteMessage";
export interface TelegramParams extends MessageOptions {
  chat_id?: number;
  message_thread_id?: number;
  message_id?: number;
  text?: string;
  name?: string;
  callback_query_id?: string;
  show_alert?: boolean;
  draft_id?: number;
  can_stop?: boolean;
  action?: "typing";
}
/** Unknown results keep the adapter and lightweight fakes honest; validate only
 * methods whose response fields are actually consumed, at the facade boundary. */
export interface TelegramApiPort {
  call(method: TelegramMethod, params?: TelegramParams): Promise<unknown>;
  document(file: ConsoleDocument): Promise<unknown>;
  download?(fileId: string): Promise<Uint8Array>;
  typing?(params: TelegramParams): Promise<unknown>;
}
export interface ConsoleFile {
  name: string;
  content: Uint8Array;
}
export interface ConsoleDocument extends ConsoleFile, TopicContext {
  caption: string;
}
export interface ConsoleBridge {
  list(): Promise<SessionListEntry[]>;
  metadata(id: SessionId): Promise<SessionMetadata | null | undefined>;
  models(): Promise<ModelEntry[]>;
  selectModel(
    id: SessionId,
    selection: ModelSelection,
  ): Promise<SelectionReceipt | null | undefined>;
  workspaces(): Promise<WorkspaceEntry[]>;
  create(workspaceId?: string): Promise<SessionId>;
  newSessionSelection(
    source?: SessionId,
  ): Promise<ModelSelection | null | undefined>;
  receiveFile?(
    id: SessionId,
    file: ConsoleFile,
    requestId: string,
  ): Promise<string>;
  prompt(id: SessionId, text: string, requestId: string): Promise<unknown>;
  stop(id: SessionId): Promise<unknown>;
  details(id: SessionId): Promise<string>;
  files(id: SessionId): Promise<ConsoleFile[]>;
  fileForTurn(id: SessionId, turn: TurnId, path: string): Promise<ConsoleFile>;
  steerQueued(
    id: SessionId,
    requestId: string,
  ): Promise<{ accepted: boolean; reason?: string }>;
}
export interface NativePrompt {
  media?: { fileId: string; name: string };
  text: string;
  requestId: string;
}
export interface PendingInitiation {
  ctx: TopicContext;
  model: ModelSelection;
  workspace?: WorkspaceEntry;
  native: boolean;
  prompts: NativePrompt[];
  expires: number;
  key: string;
  messageId?: number;
  done?: boolean;
}
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";
export interface ApprovalRequest {
  title?: unknown;
  description?: unknown;
  reason?: unknown;
  command?: unknown;
  paths?: unknown;
  consequences?: unknown;
  tool?: unknown;
  args?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  onReason?(reason: string): Promise<unknown> | unknown;
}
export interface PendingApproval {
  req: ApprovalRequest;
  sessionId: SessionId;
  done: boolean;
  outcome?: ApprovalOutcome;
  messageId?: number;
  timer?: ReturnType<typeof setTimeout>;
  abort(): void;
  finish(outcome: ApprovalOutcome): void;
}
export type NavigationAction =
  | { type: "sessions" }
  | { type: "providers"; id: SessionId; picker?: boolean }
  | { type: "models"; id: SessionId; provider: string }
  | { type: "new-providers"; pending: PendingInitiation }
  | { type: "new-models"; pending: PendingInitiation; provider: string };
export type ConsoleAction =
  | { type: "new" }
  | { type: "new-confirm" | "new-cancel"; pending: PendingInitiation }
  | { type: "new-workspaces"; pending: PendingInitiation; page: number }
  | {
      type: "new-workspace";
      pending: PendingInitiation;
      workspaceId?: string;
      page: number;
    }
  | { type: "new-providers"; pending: PendingInitiation; page: number }
  | {
      type: "new-models";
      pending: PendingInitiation;
      provider: string;
      page: number;
    }
  | {
      type: "new-select";
      pending: PendingInitiation;
      provider: string;
      model: string;
      reasoningEffort?: string;
      effortSelection?: boolean;
      page?: number;
    }
  | {
      type: "close" | "close-cancel" | "open" | "refresh" | "stop";
      id: SessionId;
    }
  | { type: "close-confirm"; id: SessionId; targetThreadId: number }
  | {
      type: "turn-file";
      id: SessionId;
      turn: TurnId;
      path: string;
      kind: FileChangeKind;
    }
  | { type: "steer"; id: SessionId; requestId: string }
  | { type: "sessions"; page: number }
  | { type: "providers"; id: SessionId; page: number; picker?: boolean }
  | { type: "models"; id: SessionId; provider: string; page: number }
  | {
      type: "select";
      id: SessionId;
      provider: string;
      model: string;
      reasoningEffort?: string;
      effortSelection?: boolean;
      page?: number;
    }
  | { type: "approve" | "deny"; pending: PendingApproval };
export type StoredAction = ConsoleAction & TopicContext & { expires: number };
export type SelectAction = Extract<ConsoleAction, { type: "select" }>;
export type PendingPickerAction = Extract<
  ConsoleAction,
  {
    type:
      | "new-providers"
      | "new-models"
      | "new-select"
      | "new-workspaces"
      | "new-workspace";
  }
>;
export type CloseAction = Pick<
  Extract<ConsoleAction, { type: "close-confirm" }>,
  "id" | "targetThreadId"
>;

export interface TelegramChat {
  id: number;
  type: string;
}
export interface TelegramMediaFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  photo?: (TelegramMediaFile & { width: number; height: number })[];
  sticker?: TelegramMediaFile & { is_animated?: boolean; is_video?: boolean };
  audio?: TelegramMediaFile;
  voice?: TelegramMediaFile;
  document?: TelegramMediaFile;
  video?: TelegramMediaFile;
  animation?: TelegramMediaFile;
  video_note?: TelegramMediaFile;
  reply_to_message?: { message_id: number };
  forum_topic_created?: { name?: string };
  forum_topic_deleted?: object;
  forum_topic_closed?: object;
  forum_topic_reopened?: object;
}
export interface CallbackQuery {
  id: string;
  from?: { id: number };
  data?: string;
  message?: TelegramMessage;
}
export interface TelegramUpdate {
  callback_query?: CallbackQuery;
  message?: TelegramMessage;
  stopped_message_generation?: {
    chat: TelegramChat;
    message_thread_id?: number;
    draft_id: number;
  };
}

/** Focused capabilities rather than a child-to-facade dependency. */
export interface MessagePort {
  readonly t: Translator;
  send(
    ctx: TopicContext,
    text: string,
    extra?: MessageOptions,
  ): Promise<TelegramMessageResult>;
  edit(
    ctx: TopicContext,
    messageId: number,
    text: string,
    markup?: InlineMarkup,
  ): Promise<unknown>;
  latest(ctx: TopicContext, messageId: number | undefined): Promise<unknown>;
  button(text: string, ctx: TopicContext, action: ConsoleAction): InlineButton;
}
export interface QueuePort {
  serial<T>(id: string, task: () => Promise<T>): Promise<T>;
}
export interface PickerPort extends MessagePort, QueuePort {
  readonly bridge: Pick<
    ConsoleBridge,
    "list" | "metadata" | "models" | "selectModel"
  >;
  readonly draftsUnsupported: boolean;
  running(id: SessionId): Promise<boolean>;
  page(
    ctx: TopicContext,
    messageId: number | undefined,
    text: string,
    rows: InlineButton[][],
  ): Promise<unknown>;
  navigation(
    ctx: TopicContext,
    page: number,
    total: number,
    action: NavigationAction,
  ): InlineButton[][];
}
export interface SessionActionsPort extends MessagePort, QueuePort {
  readonly bridge: Pick<
    ConsoleBridge,
    | "prompt"
    | "workspaces"
    | "newSessionSelection"
    | "create"
    | "selectModel"
    | "metadata"
    | "models"
  >;
  forwardPrompt(id: SessionId, prompt: NativePrompt): Promise<void>;
  readonly api: Pick<TelegramApiPort, "call">;
  readonly store: ConsoleStore;
  readonly closed: boolean;
  readonly username: string;
  readonly actions: Map<string, StoredAction>;
  readonly pending: Set<PendingApproval>;
  readonly active: Pick<Map<SessionId, ActiveRun>, "delete">;
  mapping(id: SessionId): Promise<TopicBinding | undefined>;
  bound(chatId: number, threadId: number): Promise<BoundTopic | null>;
  save(id: SessionId, mapping: TopicBinding): Promise<void>;
  card(
    id: SessionId,
    mapping: TopicBinding,
    metadata: SessionMetadata | null | undefined,
  ): Promise<void>;
  open(id: SessionId, ctx: TopicContext): Promise<TopicBinding | undefined>;
  providers(
    target: SessionId | PendingInitiation,
    ctx: TopicContext,
    page?: number,
    messageId?: number,
  ): Promise<unknown>;
  models(
    target: SessionId | PendingInitiation,
    ctx: TopicContext,
    provider: string,
    page?: number,
    messageId?: number,
    notice?: string,
    metadata?: SessionMetadata | null,
  ): Promise<unknown>;
}
export interface DeliveryPort extends QueuePort {
  readonly toolNameRules?: readonly ToolNameRule[];
  readonly api: TelegramApiPort;
  readonly store: ConsoleStore;
  readonly t: Translator;
  readonly closed: boolean;
  warning?(event: {
    code: "DELIVERY_UNCERTAIN" | "DELIVERY_REJECTED" | "DELIVERY_INVALID";
    operation: "deliver-output" | "deliver-view" | "delivery-cosmetic";
  }): void;
  draftsUnsupported: boolean;
  readonly active: Map<SessionId, ActiveRun>;
  readonly clearedMarkup: Set<string>;
  mapping(id: SessionId): Promise<TopicBinding | undefined>;
  save(id: SessionId, mapping: TopicBinding): Promise<void>;
  params(ctx: TopicContext): TelegramParams;
  controls(id: SessionId, ctx: TopicContext, running?: boolean): InlineMarkup;
  finalControls(id: SessionId, ctx: TopicContext, view: RunView): InlineMarkup;
  clearMarkup(ctx: TopicContext, messageId: number | undefined): Promise<void>;
  latest(ctx: TopicContext, messageId: number | undefined): Promise<unknown>;
  edit(
    ctx: TopicContext,
    messageId: number,
    text: string,
    markup?: InlineMarkup,
    parse_mode?: "HTML",
  ): Promise<unknown>;
  preview(
    mapping: TopicBinding | undefined,
    receipt: RunReceipt,
    view: RunView,
  ): Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === "string"
    ? error.message
    : String(error);
}
export function messageResult(value: unknown): TelegramMessageResult {
  if (!isRecord(value) || typeof value.message_id !== "number")
    throw new TypeError("Telegram sendMessage returned no message_id");
  return { message_id: value.message_id };
}
export function topicResult(value: unknown): number {
  if (!isRecord(value) || typeof value.message_thread_id !== "number")
    throw new TypeError(
      "Telegram createForumTopic returned no message_thread_id",
    );
  return value.message_thread_id;
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isTurn(value: unknown): value is TurnId {
  return isString(value) || isNumber(value);
}
function optionalFields(
  value: Record<string, unknown>,
  keys: readonly string[],
  check: (item: unknown) => boolean,
): boolean {
  return keys.every((key) => value[key] === undefined || check(value[key]));
}
function numberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}
function isTopicBinding(value: unknown): value is TopicBinding {
  return (
    isRecord(value) &&
    isNumber(value.chatId) &&
    isNumber(value.threadId) &&
    optionalFields(value, ["cardId", "latestControlMessageId"], isNumber) &&
    optionalFields(value, ["topicTitle"], isString) &&
    optionalFields(value, ["topicClosed", "deleted", "closed"], isBoolean) &&
    optionalFields(value, ["activeTurn"], isTurn)
  );
}
export function controlsReceipt(value: unknown): ControlsReceipt {
  if (value == null) return {};
  if (
    !isRecord(value) ||
    !optionalFields(value, ["cardId", "latestControlMessageId"], isNumber)
  )
    throw new TypeError("Invalid persisted Telegram controls receipt");
  return {
    ...(isNumber(value.cardId) ? { cardId: value.cardId } : {}),
    ...(isNumber(value.latestControlMessageId)
      ? { latestControlMessageId: value.latestControlMessageId }
      : {}),
  };
}
export function topicBinding(value: unknown): TopicBinding | undefined {
  if (value == null) return undefined;
  if (!isTopicBinding(value))
    throw new TypeError("Invalid persisted Telegram topic binding");
  return value;
}
function isOutputReceipt(value: unknown): value is OutputReceipt {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.hash) &&
    numberArray(value.messageIds) &&
    (value.format === undefined || value.format === "rich-v1") &&
    optionalFields(value, ["segmentEnd"], isNumber) &&
    optionalFields(value, ["pending", "complete"], isBoolean) &&
    (value.quarantine === undefined ||
      value.quarantine === "uncertain" ||
      value.quarantine === "rejected" ||
      value.quarantine === "invalid")
  );
}
function isHistoricalReceipt(value: unknown): value is HistoricalRunReceipt {
  return (
    isRecord(value) &&
    optionalFields(value, ["id", "lastOutputHash"], isString) &&
    (value.quarantine === undefined ||
      value.quarantine === "uncertain" ||
      value.quarantine === "rejected" ||
      value.quarantine === "invalid") &&
    (value.logFormat === undefined || value.logFormat === "activity-v1") &&
    (value.finalFormat === undefined || value.finalFormat === "rich-v1") &&
    optionalFields(
      value,
      ["draftId", "chatId", "threadId", "messageId", "logStart"],
      isNumber,
    ) &&
    optionalFields(
      value,
      ["answerPreview", "final", "superseded"],
      isBoolean,
    ) &&
    optionalFields(
      value,
      ["finalMessageIds", "logMessageIds", "sealedLogMessageIds"],
      numberArray,
    ) &&
    (value.outputs === undefined ||
      (Array.isArray(value.outputs) && value.outputs.every(isOutputReceipt)))
  );
}
/** Storage is a local persistence boundary, not a wire payload. Historical rows
 * intentionally remain readable even when they predate id/draftId. A malformed
 * row must not become an absent receipt and trigger an unsafe automatic resend. */
export function historicalReceipt(
  value: unknown,
): HistoricalRunReceipt | undefined {
  if (value == null) return undefined;
  if (!isHistoricalReceipt(value))
    throw new TypeError("Invalid persisted Telegram run receipt");
  return value;
}
function isRunReceipt(value: unknown): value is RunReceipt {
  return (
    isHistoricalReceipt(value) &&
    isString(value.id) &&
    isNumber(value.draftId) &&
    isNumber(value.chatId) &&
    isNumber(value.threadId)
  );
}
export function runReceipt(value: unknown): RunReceipt | undefined {
  if (value == null) return undefined;
  if (!isRunReceipt(value))
    throw new TypeError("Incomplete persisted Telegram run receipt");
  return value;
}
