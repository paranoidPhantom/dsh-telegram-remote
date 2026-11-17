import { AsyncLocalStorage } from "node:async_hooks";
import { toolNameRulesSchema } from "../rendering/tool-name.js";
import { z } from "zod";
import { TelegramConsole } from "../bot/console.js";
import type { TelegramApiPort } from "../bot/contracts.js";
import { TelegramAdapter } from "../telegram/adapter.js";
import { decodeJson, encodeJson, type JsonValue } from "../protocol/json.js";
import type { RpcPeer } from "../protocol/rpc.js";
import { createHostPort, type ActorOperationScope } from "./host-port.js";
import { UpdateIngress } from "./ingress.js";
import { compileWidget } from "../widgets/compiler.js";
import { WidgetDelivery } from "../widgets/widget-delivery.js";
import { createTranslator } from "../i18n/bot-i18n.js";
import {
  startupEventSchema,
  startupFailure,
  type StartupEvent,
} from "../protocol/startup.js";

const initializeSchema = z.object({
  ownerId: z.number().int().nonnegative(),
  ownerEpoch: z.number().int().nonnegative(),
  locale: z.string(),
  version: z.string(),
  toolNameRules: toolNameRulesSchema.optional(),
});
const runSchema = z.object({
  turn: z.union([z.string(), z.number().finite()]),
  final: z.boolean().optional(),
  status: z.string().optional(),
  answer: z.string().optional(),
  partialAnswer: z.string().optional(),
  partialId: z.string().optional(),
  outputs: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        toolCount: z.number().optional(),
        logCount: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  toolLog: z
    .array(
      z.object({
        name: z.string().optional(),
        tool: z.string().optional(),
        text: z.string().optional(),
        summary: z.string().optional(),
        status: z.string().optional(),
        resultHtml: z.string().optional(),
        callHtml: z.string().optional(),
        callId: z.string().optional(),
      }),
    )
    .optional(),
  runLog: z
    .array(
      z.object({
        kind: z.enum(["tool", "reasoning"]),
        text: z.string().max(240).optional(),
        name: z.string().optional(),
        summary: z.string().optional(),
        status: z.string().optional(),
        resultHtml: z.string().optional(),
        callId: z.string().optional(),
      }),
    )
    .optional(),
  todos: z
    .array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .optional(),
  todoVersion: z.number().int().nonnegative().optional(),
  touchedFiles: z
    .array(
      z.object({
        path: z.string(),
        kind: z.enum(["added", "removed", "edited"]),
      }),
    )
    .optional(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional(),
  elapsed: z.number().optional(),
  logEnd: z.number().optional(),
});
const messageSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int(), type: z.string() }),
  from: z.object({ id: z.number().int() }).optional(),
  message_thread_id: z.number().int().optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number().int() }).optional(),
  forum_topic_created: z.object({ name: z.string().optional() }).optional(),
  forum_topic_closed: z.object({}).optional(),
  forum_topic_deleted: z.object({}).optional(),
  forum_topic_reopened: z.object({}).optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().optional(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number().int() }).optional(),
      data: z.string().optional(),
      message: messageSchema.optional(),
    })
    .optional(),
  stopped_message_generation: z
    .object({
      chat: z.object({ id: z.number().int(), type: z.string() }),
      message_thread_id: z.number().int().optional(),
      // Telegram emits native stop draft IDs as decimal strings as well as
      // numbers. Normalize only that wire representation, never broad coercion.
      draft_id: z
        .union([
          z.number(),
          z
            .string()
            .regex(/^[0-9]+$/)
            .transform(Number),
        ])
        .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
    })
    .optional(),
});
const descriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  size: z
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024),
});
const json = (value: unknown): JsonValue => decodeJson(encodeJson(value));
type Handler = (payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
export interface ChildRuntimeOptions {
  peer: Pick<RpcPeer, "request"> & Partial<Pick<RpcPeer, "pendingCount">>;
  generation: string;
  build: string;
  drainMs?: number;
  adapterFactory?: (
    options: ConstructorParameters<typeof TelegramAdapter>[0],
  ) => TelegramAdapter;
  onError?: (error: unknown) => void;
}

/** Child-owned lifetimes and Telegram rendering; Host capabilities remain RPC-only. */
export class ChildRuntime {
  private readonly eventStarted = new AsyncLocalStorage<number>();
  private latencyLastMs: number | null = null;
  private latencyMaxMs: number | null = null;
  readonly controller = new AbortController();
  readonly scope = new AsyncLocalStorage<ActorOperationScope>();
  private surface?: TelegramConsole;
  private ingress?: UpdateIngress;
  private adapter?: TelegramAdapter;
  private port?: ReturnType<typeof createHostPort>;
  private settings?: z.infer<typeof initializeSchema>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private widgetDelivery?: WidgetDelivery;
  private readonly work = new Set<Promise<unknown>>();
  private readonly approvals = new Map<string, AbortController>();
  private readonly approvalActors = new WeakMap<object, ActorOperationScope>();
  private closing?: Promise<void>;
  private commandSync: Promise<void> = Promise.resolve();
  private startupUnavailable = false;
  private readonly transfers = new Map<
    string,
    { parts: string[]; count: number; bytes: number; expires: number }
  >();
  readonly handlers: Record<string, Handler>;

  constructor(private readonly options: ChildRuntimeOptions) {
    this.handlers = {
      "runtime.diagnostics": async () => this.diagnostics(),
      "runtime.initialize": (payload) => this.track(this.initialize(payload)),
      "runtime.shutdown": async () => {
        await this.shutdown();
        return null;
      },
      "settings.update": async (payload) => {
        const value = z.object({ locale: z.string() }).parse(payload);
        this.requireSurface();
        if (this.settings && this.settings.locale !== value.locale) {
          this.settings.locale = value.locale;
          await this.track(this.syncCommands());
        }
        return null;
      },
      "run.push": (payload) => this.track(this.run(payload)),
      "run.chunk": async (payload) => {
        this.requireSurface();
        const value = z
          .object({
            transferId: z.string(),
            index: z.number().int().nonnegative(),
            count: z.number().int().min(1).max(300),
            data: z.string().max(65536),
          })
          .parse(payload);
        for (const [id, item] of this.transfers)
          if (item.expires < Date.now()) this.transfers.delete(id);
        let item = this.transfers.get(value.transferId);
        if (!item) {
          if (this.transfers.size >= 2 || value.index !== 0)
            throw new Error("Transfer capacity exceeded");
          item = {
            parts: [],
            count: value.count,
            bytes: 0,
            expires: Date.now() + 30000,
          };
          this.transfers.set(value.transferId, item);
        }
        const bytes = Buffer.from(value.data, "base64");
        if (
          bytes.toString("base64") !== value.data ||
          bytes.length > 49152 ||
          value.count !== item.count ||
          value.index !== item.parts.length ||
          item.bytes + bytes.length > 10 * 1024 * 1024
        )
          throw new Error("Invalid run transfer");
        item.parts.push(value.data);
        item.bytes += bytes.length;
        return null;
      },
      "run.chunk.commit": (payload) =>
        this.track(
          (async () => {
            const value = z.object({ transferId: z.string() }).parse(payload);
            const item = this.transfers.get(value.transferId);
            this.transfers.delete(value.transferId);
            if (
              !item ||
              item.parts.length !== item.count ||
              item.expires < Date.now()
            )
              throw new Error("Incomplete run transfer");
            return this.run(
              decodeJson(
                Buffer.concat(
                  item.parts.map((part) => Buffer.from(part, "base64")),
                ).toString("utf8"),
                10 * 1024 * 1024,
              ),
            );
          })(),
        ),
      "session.refresh": (payload) => this.track(this.refresh(payload)),
      "approval.request": (payload, signal) =>
        this.track(this.approval(payload, signal)),
      "approval.cancel": async (payload) => {
        const value = z.object({ id: z.string() }).parse(payload);
        this.approvals.get(value.id)?.abort();
        return null;
      },
      "files.send": (payload) => this.track(this.sendFile(payload)),
      "widget.publish": (payload) => this.track(this.publishWidget(payload)),
    };
  }
  /** Explicit numeric/identity allowlist: never serialize runtime objects or errors. */
  private diagnostics(): JsonValue {
    const adapter = this.adapter;
    return {
      childPid: process.pid,
      build: this.options.build,
      generation: this.options.generation,
      uptimeMs: Math.floor(process.uptime() * 1000),
      rpcPending: this.options.peer.pendingCount ?? 0,
      ingress: this.ingress?.diagnostics() ?? null,
      outbound: {
        active: adapter?.outboundActive ?? 0,
        pending: adapter?.outboundWaiters.length ?? 0,
        lanes: adapter?.lanes.size ?? 0,
        lanePending: adapter
          ? [...adapter.lanes.values()].reduce(
              (sum, lane) => sum + lane.pending,
              0,
            )
          : 0,
        cooldownUntil: adapter?.cooldownUntil ?? 0,
        rateLimitCount: adapter?.rateLimitCount ?? 0,
        rateLimitLastWaitMs: adapter?.rateLimitLastWaitMs ?? 0,
        rateLimitMaxWaitMs: adapter?.rateLimitMaxWaitMs ?? 0,
      },
      eventToSend: { lastMs: this.latencyLastMs, maxMs: this.latencyMaxMs },
    };
  }
  private sampleSend(): void {
    const start = this.eventStarted.getStore();
    if (start === undefined) return;
    const elapsed = Math.max(0, performance.now() - start);
    this.latencyLastMs = elapsed;
    this.latencyMaxMs = Math.max(this.latencyMaxMs ?? 0, elapsed);
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.work.add(task);
    void task.then(
      () => this.work.delete(task),
      () => this.work.delete(task),
    );
    return task;
  }
  private requireSurface(): TelegramConsole {
    this.controller.signal.throwIfAborted();
    if (!this.surface) throw new Error("Child runtime is not initialized");
    return this.surface;
  }
  private request(
    method: string,
    payload: Record<string, JsonValue> = {},
  ): Promise<JsonValue> {
    return this.options.peer.request(
      method,
      {
        generation: this.options.generation,
        ownerEpoch: this.settings?.ownerEpoch ?? 0,
        ...payload,
      },
      { signal: this.controller.signal },
    );
  }
  /** Await diagnostics before proceeding, but never let an unavailable Host stall startup. */
  private async startup(event: StartupEvent): Promise<void> {
    if (this.startupUnavailable) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = startupEventSchema.parse(event);
      await Promise.race([
        this.options.peer.request(
          "runtime.startup",
          {
            generation: this.options.generation,
            ownerEpoch: this.settings?.ownerEpoch ?? 0,
            ...value,
          },
          { signal: controller.signal, timeoutMs: 250 },
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.startupUnavailable = true;
            controller.abort();
            resolve();
          }, 250);
        }),
      ]);
    } catch {
      this.startupUnavailable = true;
      /* Older Hosts and test peers may not support diagnostics. */
    } finally {
      clearTimeout(timer);
    }
  }
  private async startupStage<T>(
    stage: StartupEvent["stage"],
    operation: () => T | Promise<T>,
    detail: Pick<StartupEvent, "language"> = {},
  ): Promise<T> {
    await this.startup({ stage, outcome: "begin", ...detail });
    const start = performance.now();
    try {
      const result = await operation();
      await this.startup({
        stage,
        outcome: "ok",
        durationMs: Math.max(0, Math.floor(performance.now() - start)),
        ...detail,
      });
      return result;
    } catch (error) {
      await this.startup({
        stage,
        outcome: "failed",
        durationMs: Math.max(0, Math.floor(performance.now() - start)),
        ...startupFailure(error),
        ...detail,
      });
      throw error;
    }
  }
  private async initialize(payload: JsonValue): Promise<JsonValue> {
    if (this.settings || this.controller.signal.aborted)
      throw new Error("Child runtime cannot initialize twice");
    const settings = initializeSchema.parse(payload);
    this.settings = settings;
    await this.startupStage("surface", () => {
      this.port = createHostPort({
        peer: this.options.peer,
        generation: this.options.generation,
        ownerEpoch: settings.ownerEpoch,
        scope: () => this.scope.getStore(),
        signal: this.controller.signal,
      });
      this.adapter = (
        this.options.adapterFactory ??
        ((options) => new TelegramAdapter(options))
      )({
        credentials: this.port.credentials,
        credentialKey: "telegram-console/bot",
        signal: this.controller.signal,
        onSendStart: () => this.sampleSend(),
        onStartup: (event) => this.startup(event),
      });
      // Adapter validates Telegram method payloads at its boundary. The console's
      // narrower union is deliberately routed through its untyped wire method.
      const api: TelegramApiPort = {
        call: (method, params) => this.adapterCall(method, params ?? {}),
        document: (file) => this.adapterFile(file),
        typing: (params) => {
          if (!this.adapter || typeof params.chat_id !== "number")
            return Promise.resolve();
          return this.adapter.typing({
            chat_id: params.chat_id,
            ...(params.message_thread_id
              ? { message_thread_id: params.message_thread_id }
              : {}),
          });
        },
      };
      this.surface = new TelegramConsole({
        api,
        bridge: this.port.bridge,
        store: this.port.store,
        ownerId: settings.ownerId,
        signal: this.controller.signal,
        getLocale: () => this.settings?.locale,
        toolNameRules: settings.toolNameRules,
      });
      this.surface.runtimeVersion = settings.version;
      this.surface.runtimePid = process.ppid;
      this.surface.runtimeIdentity = {
        hostPid: process.ppid,
        childPid: process.pid,
        build: this.options.build,
        generation: this.options.generation,
      };
    });
    const me = await this.startupStage("getMe", async () =>
      z
        .object({ id: z.number().int(), username: z.string().optional() })
        .parse(await this.adapter!.call("getMe")),
    );
    const webhook = await this.startupStage("getWebhookInfo", async () =>
      z
        .object({ url: z.string() })
        .parse(await this.adapter!.call("getWebhookInfo")),
    );
    await this.startupStage("webhook-check", () => {
      if (webhook.url)
        throw Object.assign(
          new Error("Telegram webhook must be removed before polling"),
          { code: "WEBHOOK_CONFIGURED" },
        );
    });
    await this.startupStage("lease", async () =>
      z
        .object({ acquired: z.literal(true) })
        .parse(await this.request("runtime.acquireLease", { botId: me.id })),
    );
    this.surface!.username = me.username ?? "";
    await this.startupStage("ingress", () => {
      this.ingress = new UpdateIngress({
        api: {
          call: async (_method, params) =>
            json(await this.adapterCall("getUpdates", params)),
        },
        admit: async (update) =>
          z
            .enum(["admitted", "duplicate", "ignored"])
            .parse(await this.request("inbox.admit", { update })),
        getOffset: async () =>
          z
            .number()
            .int()
            .nonnegative()
            .parse(await this.request("inbox.offset")),
        pending: async () =>
          z
            .array(
              z.object({
                updateId: z.number().int(),
                ownerEpoch: z.number().int(),
                operation: z.json(),
                status: z
                  .enum(["pending", "completed", "failed", "uncertain"])
                  .optional(),
              }),
            )
            .parse(await this.request("inbox.pending")),
        settle: async (entry, outcome) => {
          await this.request("inbox.settle", {
            updateId: entry.updateId,
            ownerEpoch: entry.ownerEpoch,
            outcome,
          });
        },
        handle: async (operation) => this.handleUpdate(operation),
        classify: (operation) => this.classify(operation),
        signal: this.controller.signal,
        onError: (error) => this.options.onError?.(error),
      });
      void this.track(this.ingress.run()).catch((error) =>
        this.options.onError?.(error),
      );
      this.heartbeat = setInterval(() => {
        if (this.surface)
          void this.track(this.surface.delivery.refreshDrafts()).catch(
            (error) => this.options.onError?.(error),
          );
      }, 3000);
    });
    // Cosmetic command registration must not hold initialization or polling
    // behind four serial network requests. Track it for owned shutdown/drain.
    void this.track(this.syncCommands()).catch((error) =>
      this.options.onError?.(error),
    );
    return { initialized: true };
  }
  private syncCommands(): Promise<void> {
    const settings = this.settings;
    if (!settings || settings.ownerId <= 0)
      return this.startup({
        stage: "commands",
        outcome: "skipped",
        code: "NOT_CONFIGURED",
      });
    const t = createTranslator(() => settings.locale);
    const params = {
      scope: { type: "chat" as const, chat_id: settings.ownerId },
      // Override old language-specific menus too; DSH, not Telegram, selects locale.
      commands: [
        { command: "start", description: t("commandStart") },
        { command: "sessions", description: t("commandSessions") },
        { command: "new", description: t("commandNew") },
        { command: "status", description: t("commandStatus") },
        { command: "stop", description: t("commandStop") },
        { command: "files", description: t("commandFiles") },
        { command: "version", description: t("commandVersion") },
        { command: "help", description: t("commandHelp") },
      ],
    };
    this.commandSync = this.commandSync.then(async () => {
      try {
        await this.startupStage("commands", async () => {
          for (const language_code of ["", "en", "zh", "ru"] as const) {
            this.controller.signal.throwIfAborted();
            await this.startupStage(
              "setMyCommands",
              async () => {
                const accepted = await this.adapter?.call("setMyCommands", {
                  ...params,
                  language_code,
                });
                if (accepted !== true)
                  throw Object.assign(
                    new Error(
                      "Telegram command registration was not acknowledged",
                    ),
                    { code: "NOT_ACKNOWLEDGED" },
                  );
              },
              { language: language_code },
            );
          }
        });
      } catch (error) {
        // Menu cosmetics must not take down polling; retry at next startup/locale change.
        this.options.onError?.(error);
      }
    });
    return this.commandSync;
  }
  private adapterCall(method: string, params: unknown): Promise<unknown> {
    if (!this.adapter) return Promise.reject(new Error("Adapter unavailable"));
    const record = z.record(z.string(), z.unknown()).parse(params);
    const chat = z.object({ chat_id: z.number() }).passthrough();
    const message = chat.extend({ message_id: z.number() });
    const topic = chat.extend({ message_thread_id: z.number() });
    switch (method) {
      case "getUpdates":
        return this.adapter.call("getUpdates", record);
      case "sendMessage":
        return this.adapter.call(
          "sendMessage",
          chat.extend({ text: z.string() }).parse(record),
        );
      case "editMessageText":
        return this.adapter.call("editMessageText", record);
      case "editMessageReplyMarkup":
        return this.adapter.call("editMessageReplyMarkup", record);
      case "pinChatMessage":
        return this.adapter.call("pinChatMessage", message.parse(record));
      case "editForumTopic":
        return this.adapter.call("editForumTopic", topic.parse(record));
      case "reopenForumTopic":
        return this.adapter.call("reopenForumTopic", topic.parse(record));
      case "createForumTopic":
        return this.adapter.call(
          "createForumTopic",
          chat.extend({ name: z.string() }).parse(record),
        );
      case "deleteForumTopic":
        return this.adapter.call("deleteForumTopic", topic.parse(record));
      case "answerCallbackQuery":
        return this.adapter.call(
          "answerCallbackQuery",
          z
            .object({ callback_query_id: z.string() })
            .passthrough()
            .parse(record),
        );
      case "getMe":
        return this.adapter.call("getMe");
      case "sendMessageDraft":
        return this.adapter.call(
          "sendMessageDraft",
          chat.extend({ draft_id: z.number() }).parse(record),
        );
      case "sendChatAction":
        return this.adapter.call(
          "sendChatAction",
          chat.extend({ action: z.literal("typing") }).parse(record),
        );
      case "deleteMessage":
        return this.adapter.call("deleteMessage", message.parse(record));
      default:
        throw new Error("Unsupported Telegram method");
    }
  }
  private adapterFile(file: {
    chatId: number;
    threadId: number;
    name: string;
    content: Uint8Array;
    caption: string;
  }): Promise<unknown> {
    if (!this.adapter) return Promise.reject(new Error("Adapter unavailable"));
    return this.adapter.file({ ...file, content: Buffer.from(file.content) });
  }
  private classify(operation: JsonValue): { key: string; priority: boolean } {
    const update = updateSchema.parse(operation);
    const message = update.callback_query?.message ?? update.message;
    const action = update.callback_query?.data
      ? this.surface?.actions.get(update.callback_query.data)
      : undefined;
    return {
      key: `${message?.chat.id ?? 0}:${message?.message_thread_id ?? 0}`,
      priority: Boolean(
        update.stopped_message_generation ||
        (action && ["approve", "deny", "stop"].includes(action.type)),
      ),
    };
  }
  private async handleUpdate(operation: JsonValue): Promise<void> {
    const update = updateSchema.parse(operation);
    const message = update.callback_query?.message ?? update.message;
    const ownerId =
      update.callback_query?.from?.id ??
      update.message?.from?.id ??
      (update.stopped_message_generation?.chat.type === "private" &&
      update.stopped_message_generation.chat.id === this.settings?.ownerId
        ? this.settings.ownerId
        : 0);
    const actor: ActorOperationScope = {
      ownerId,
      chatId:
        message?.chat.id ?? update.stopped_message_generation?.chat.id ?? 0,
      threadId:
        message?.message_thread_id ??
        update.stopped_message_generation?.message_thread_id ??
        0,
      privateChat:
        (message?.chat.type ?? update.stopped_message_generation?.chat.type) ===
        "private",
      operationId: `telegram:${this.settings?.ownerEpoch}:${update.update_id ?? "unknown"}`,
    };
    const action = update.callback_query?.data
      ? this.surface?.actions.get(update.callback_query.data)
      : undefined;
    if (action && (action.type === "approve" || action.type === "deny"))
      this.approvalActors.set(
        action.pending.req.signal ?? action.pending,
        actor,
      );
    await this.scope.run(actor, () =>
      this.eventStarted.run(performance.now(), () =>
        this.requireSurface().handleUpdate(update),
      ),
    );
  }
  private run(payload: JsonValue): Promise<JsonValue> {
    return this.eventStarted.run(performance.now(), () =>
      this.deliverRun(payload),
    );
  }
  private async deliverRun(payload: JsonValue): Promise<JsonValue> {
    const value = z
      .object({ sessionId: z.string(), view: runSchema })
      .parse(payload);
    const surface = this.requireSurface();
    if (surface.closed) throw new Error("Child surface is closed");
    const before = await surface.mapping(value.sessionId);
    if (!before || before.deleted || before.closed)
      return { status: "detached" };
    await surface.delivery.onRun(value.sessionId, value.view);
    this.controller.signal.throwIfAborted();
    if (surface.closed) throw new Error("Child surface closed during delivery");
    const after = await surface.mapping(value.sessionId);
    if (
      !after ||
      after.deleted ||
      after.closed ||
      after.chatId !== before.chatId ||
      after.threadId !== before.threadId
    )
      return { status: "detached" };
    return { status: "delivered" };
  }
  private async refresh(payload: JsonValue): Promise<JsonValue> {
    const value = z.object({ sessionId: z.string() }).parse(payload);
    const surface = this.requireSurface();
    const binding = await surface.mapping(value.sessionId);
    if (!binding || !this.settings) return null;
    await this.scope.run(
      {
        ownerId: this.settings.ownerId,
        chatId: binding.chatId,
        threadId: binding.threadId,
        privateChat: binding.chatId === this.settings.ownerId,
        operationId: "",
      },
      () => surface.refresh(value.sessionId),
    );
    return null;
  }
  private async approval(
    payload: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const value = z
      .object({
        id: z.string(),
        sessionId: z.string(),
        callId: z.string(),
        expiresAt: z.number().optional(),
        request: z.record(z.string(), z.json()),
      })
      .parse(payload);
    const surface = this.requireSurface();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.approvals.set(value.id, controller);
    // Capture the callback's actor at settlement, not the presentation request's
    // async continuation. The Host remains the only authority that can settle.
    const ownerEpoch = this.settings?.ownerEpoch ?? 0;
    let denialActor: ActorOperationScope | undefined;
    let decision: Promise<JsonValue> | undefined;
    const outcomePromise = surface.approval(value.sessionId, {
      ...value.request,
      ...(value.request.hasOnReason === true
        ? {
            onReason: async (reason: string) => {
              // The console validates the later reply's private-chat/topic prompt.
              // Bind this RPC to the original denial actor, never the ambient reply scope.
              if (!denialActor || !decision || (await decision) !== true)
                return false;
              return this.request("approvals.reason", {
                id: value.id,
                sessionId: value.sessionId,
                callId: value.callId,
                ownerEpoch,
                actor: {
                  ownerId: denialActor.ownerId,
                  chatId: denialActor.chatId,
                  threadId: denialActor.threadId,
                  privateChat: denialActor.privateChat,
                },
                reason,
              });
            },
          }
        : {}),
      signal: controller.signal,
      timeoutMs: value.expiresAt
        ? Math.max(1, value.expiresAt - Date.now())
        : undefined,
    });
    try {
      const outcome = await outcomePromise;
      const actor = this.approvalActors.get(controller.signal);
      if ((outcome === "allowed-once" || outcome === "rejected") && actor) {
        if (outcome === "rejected") denialActor = { ...actor };
        decision = this.request("approvals.decide", {
          id: value.id,
          sessionId: value.sessionId,
          callId: value.callId,
          ownerEpoch,
          actor: {
            ownerId: actor.ownerId,
            chatId: actor.chatId,
            threadId: actor.threadId,
            privateChat: actor.privateChat,
          },
          outcome,
        });
        await decision;
      }
      return outcome;
    } finally {
      this.approvals.delete(value.id);
      signal.removeEventListener("abort", abort);
      this.controller.signal.removeEventListener("abort", abort);
    }
  }
  private async sendFile(payload: JsonValue): Promise<JsonValue> {
    const value = z
      .object({
        descriptor: descriptorSchema,
        chatId: z.number().int(),
        threadId: z.number().int(),
        caption: z.string().optional(),
      })
      .parse(payload);
    this.requireSurface();
    if (!this.port || !this.adapter) throw new Error("Adapter unavailable");
    const file = await this.port.downloadResource(value.descriptor);
    return json(
      await this.adapter.file({
        ...file,
        content: Buffer.from(file.content),
        chatId: value.chatId,
        threadId: value.threadId,
        caption: value.caption,
      }),
    );
  }
  private async publishWidget(payload: JsonValue): Promise<JsonValue> {
    const value = z
      .object({
        sessionId: z.string(),
        source: descriptorSchema,
        widgetId: z.string(),
        filePath: z.string(),
        rootDir: z.string(),
        chatId: z.number().int(),
        threadId: z.number().int(),
      })
      .parse(payload);
    this.requireSurface();
    const port = this.port;
    const adapter = this.adapter;
    if (!port || !adapter) throw new Error("Adapter unavailable");
    const source = await port.downloadResource(value.source);
    try {
      const compiled = await compileWidget({
        html: Buffer.from(source.content).toString("utf8"),
        rootDir: value.rootDir,
        filePath: value.filePath,
        localResources: {
          canonicalize: async (path) =>
            z.string().parse(
              await this.request("widgets.canonicalize", {
                widgetId: value.widgetId,
                path,
              }),
            ),
          read: async (path, maxBytes, signal) => {
            signal.throwIfAborted();
            const descriptor = descriptorSchema.parse(
              await this.request("widgets.read", {
                widgetId: value.widgetId,
                path,
                maxBytes,
              }),
            );
            if (descriptor.size > maxBytes)
              throw new Error("Widget resource exceeds limit");
            return Buffer.from(
              (await port.downloadResource(descriptor)).content,
            );
          },
        },
      });
      const delivery = (this.widgetDelivery ??= new WidgetDelivery({
        api: {
          call: async (method, params) =>
            method === "sendWidget"
              ? adapter.call(
                  "sendWidget",
                  z
                    .object({
                      chat_id: z.union([z.number(), z.string()]),
                      html: z.string(),
                      caption: z.string(),
                      protect_content: z.literal(true),
                      allow_queries: z.literal(false),
                      is_shared: z.literal(false),
                      message_thread_id: z.number().optional(),
                    })
                    .parse(params),
                )
              : adapter.call(
                  "deleteMessage",
                  z
                    .object({
                      chat_id: z.union([z.number(), z.string()]),
                      message_id: z.number(),
                    })
                    .parse(params),
                ),
        },
        store: {
          get: async (key) => {
            const stored = await port.store.get(key);
            return stored == null
              ? undefined
              : z
                  .object({
                    message_id: z.number().int(),
                    sent_at: z.string(),
                    content_hash: z.string(),
                  })
                  .parse(stored);
          },
          set: (key, metadata) => port.store.set(key, metadata),
        },
      }));
      return json({
        ...(await delivery.deliver({
          chatId: value.chatId,
          threadId: value.threadId,
          filename: value.source.name,
          compiled,
        })),
        warnings: compiled.warnings,
      });
    } catch (error: unknown) {
      this.controller.signal.throwIfAborted();
      // Compilation/eligibility failures retain access to the exact source. Do
      // not attempt a second widget send after an ambiguous transport failure.
      await adapter.file({
        chatId: value.chatId,
        threadId: value.threadId,
        name: source.name,
        content: Buffer.from(source.content),
        caption: value.filePath,
      });
      return {
        status: "source-fallback",
        reason: error instanceof Error ? error.message : "Widget unavailable",
      };
    }
  }
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    this.transfers.clear();
    clearInterval(this.heartbeat);
    this.surface?.close();
    const drain = Promise.allSettled([
      ...this.work,
      this.ingress?.drain() ?? Promise.resolve(),
    ]);
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(resolve, this.options.drainMs ?? 1000);
      void drain.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.closing;
  }
}
