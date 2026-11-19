import { z } from "zod";
import { toolNameRulesSchema } from "./rendering/tool-name.js";
import { readFile, chmod, unlink, access } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createBridge, type Bridge } from "./bridge/bridge.js";
import { consoleBridge, semanticRunView } from "./bridge/console-adapter.js";
export { consoleBridge, semanticRunView } from "./bridge/console-adapter.js";
import type { RunView } from "./bot/contracts.js";
import { RuntimeLifecycle } from "./delivery/runtime-lifecycle.js";
import { createStreamScheduler } from "./delivery/stream-scheduler.js";
import { dshLocale } from "./i18n/dsh-locale.js";
import { ChildSupervisor } from "./host/supervisor.js";
import { HostAuthority } from "./host/authority.js";
import { ApprovalRegistry } from "./host/approvals.js";
import { QuestionRegistry } from "./host/questions.js";
import { registerQuestionForwarding } from "./host/question-forwarding.js";
import { registerApprovalForwarding } from "./host/approval-forwarding.js";
import { RuntimeDiagnosticsPoller } from "./host/diagnostics.js";
import { RuntimeStatusWriter } from "./host/runtime-status.js";
import {
  startupEventSchema,
  startupFailure,
  startupErrorType,
  type StartupEvent,
} from "./protocol/startup.js";
import { ResourceRegistry } from "./host/resources.js";
import { Inbox } from "./host/inbox.js";
import { BotLease } from "./host/lease.js";
import {
  createSettingsController,
  registerSettingsRoute,
} from "./host/settings-host.js";
import {
  registerSendFile,
  type ArtifactDependencies,
} from "./files/send-file.js";
import {
  createWidgetPipeline,
  WidgetResourceAccess,
} from "./host/widget-pipeline.js";
import type {
  ActivationConfig,
  ActivationContext,
  ActivationDependencies,
  SupervisorPort,
  Registration,
} from "./host/activation-contracts.js";
import { object, integer, string, wireValue } from "./protocol/values.js";
import {
  decodeJson,
  encodeJson,
  ProtocolError,
  type JsonValue,
} from "./protocol/json.js";
import type { RpcHandler, RpcPeer } from "./protocol/rpc.js";
import { foldRun, initialRun } from "./projection/run-projection.js";

// Initialization includes two sequential 40s Telegram requests plus bounded Host RPCs.
export const INITIALIZE_TIMEOUT_MS = 180_000;
// Delivery ACKs include paced sends, log sealing and global Telegram cooldowns.
// A timeout is uncertain, never permission to resend or restart the worker.
export const DELIVERY_TIMEOUT_MS = 300_000;

export const inject = [
  "tools",
  "webServer",
  "connection",
  "credentials",
  "sessionController",
  "sessionQuery",
  "sessionProjections",
  "storageDomain",
  "workingDirectory",
  "workspaceRegistry",
  "agents",
  "fs",
  "attachments",
  "systemPrompt",
];

/** Resolve both source and compiled layouts by walking to the package marker. */
export async function resolvePackageDirectory(
  moduleUrl: string,
): Promise<string> {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    try {
      await access(resolve(directory, "cordis.patch.yml"));
      await access(resolve(directory, "package.json"));
      return directory;
    } catch {
      /* compiled subtree */
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error("Telegram package root unavailable");
    directory = parent;
  }
}

export async function apply<Handle>(
  ctx: ActivationContext<Handle>,
  config: ActivationConfig,
  activationDependencies: ActivationDependencies = {},
): Promise<void> {
  if (!Number.isSafeInteger(config.ownerId) || config.ownerId < 0)
    throw new Error(
      "Telegram ownerId must be a non-negative integer; zero disables access until configured.",
    );
  const toolNameRules = toolNameRulesSchema.parse(config.toolNameRules ?? []);
  const packageDir = await resolvePackageDirectory(import.meta.url);
  const manifest: unknown = JSON.parse(
    await readFile(resolve(packageDir, "package.json"), "utf8"),
  );
  const version = z.object({ version: z.string() }).parse(manifest).version;
  const statusPath =
    config.statusPath ?? resolve(packageDir, ".runtime-status.json");
  const startedAt = new Date().toISOString();
  let ownerId = config.ownerId,
    ownerEpoch = 0,
    generation = "",
    supervisor: SupervisorPort | undefined,
    authority: HostAuthority | undefined;
  let lease: BotLease | undefined,
    leasedBot: number | undefined,
    leaseTail: Promise<void> = Promise.resolve();
  let bridge: Bridge | undefined,
    domain: Awaited<ReturnType<typeof ctx.storageDomain.open>> | undefined;
  let readyPeer: RpcPeer | undefined;
  let lastError: string | null = null;
  const lifecycle = new RuntimeLifecycle(() => report());
  const signal = lifecycle.signal;
  const questions = new QuestionRegistry();
  const approvals = new ApprovalRegistry(),
    resources = new ResourceRegistry(),
    widgetResources = new WidgetResourceAccess<Handle>();
  let statusState = "starting";
  const statusWriter = new RuntimeStatusWriter(statusPath, () => ({
    version,
    startedAt,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? null,
    ownerId,
    ownerEpoch,
    state: statusState,
    lastError,
    supervisorState: supervisor?.state ?? "idle",
    childPid: supervisor?.pid ?? null,
    generation: supervisor?.currentGeneration ?? null,
    diagnostics:
      supervisor?.state === "running"
        ? diagnostics.snapshot(supervisor.currentGeneration)
        : null,
  }));
  const trace = (event: StartupEvent) => {
    void statusWriter.record("host", event).catch(() => {});
  };
  const status = (state: string) => {
    statusState = state;
    return statusWriter.flush();
  };
  const diagnostics = new RuntimeDiagnosticsPoller({
    peer: () => readyPeer,
    onSample: () => {
      void statusWriter.flush().catch(() => {});
    },
  });
  lifecycle.own(() => diagnostics.close());
  diagnostics.start();
  trace({ stage: "activation", outcome: "begin" });
  // Deliberately do not retain arbitrary backend error strings: they may contain credentials.
  const report = () => {
    lastError = "Telegram isolated runtime operation failed";
    void status(signal.aborted ? "stopped" : "degraded").catch(() => {});
  };
  const own = (register: () => Registration) => ctx.effect(register);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const streams = new Map<
    string,
    { attempt: string; turn: number; text: string }
  >();
  let rotation: Promise<void> = Promise.resolve();
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closed ??= (async () => {
      lifecycle.controller.abort();
      readyPeer = undefined;
      authority?.close();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      scheduler.close();
      await rotation.catch(() => {});
      await supervisor?.close(); // Never release exclusion or close Host stores before owned PID exit.
      await leaseTail.catch(() => {});
      await lease?.close();
      lease = undefined;
      approvals.close();
      questions.close();
      resources.close();
      widgetResources.close();
      await lifecycle.close();
      await bridge?.dispose();
      await domain?.close();
      await status("stopped").catch(() => {});
    })());
  ctx.effect(() => close);
  const dispatch = {
    request: async (
      method: string,
      payload: Record<string, JsonValue>,
      options?: { signal?: AbortSignal },
    ): Promise<JsonValue> => {
      signal.throwIfAborted();
      const peer = readyPeer;
      if (!peer)
        throw new ProtocolError("CHILD_OFFLINE", "Telegram worker unavailable");
      return peer.request(method, payload, {
        signal: options?.signal
          ? AbortSignal.any([signal, options.signal])
          : signal,
      });
    },
  };
  const sendView = async (
    peer: RpcPeer,
    id: string,
    view: RunView & { turn: number },
    replay = false,
  ) => {
    // This is an explicitly mapped semantic DTO; JSON.stringify removes its
    // optional fields before strict bounded validation (never arbitrary Host objects).
    const payload = decodeJson(
      JSON.stringify({ sessionId: id, view, replay }),
      10 * 1024 * 1024,
    );
    const text = encodeJson(payload, 10 * 1024 * 1024),
      bytes = Buffer.from(text);
    const request = async (
      method: "run.push" | "run.chunk" | "run.chunk.commit",
      params: JsonValue,
    ) => {
      try {
        return await peer.request(method, params, {
          signal,
          ...(method === "run.chunk" ? {} : { timeoutMs: DELIVERY_TIMEOUT_MS }),
        });
      } catch (error) {
        trace({
          stage: "replay",
          outcome: "failed",
          operation: "send-view",
          rpcMethod: method,
          ...startupFailure(error),
          ...startupErrorType(error),
        });
        throw error;
      }
    };
    if (bytes.length < 192 * 1024) {
      const result = object(await request("run.push", payload));
      if (
        result.status !== "delivered" &&
        result.status !== "detached" &&
        result.status !== "warning"
      )
        throw new ProtocolError(
          "DELIVERY_ACK",
          "Invalid delivery acknowledgement",
        );
      return result.status;
    }
    const transferId = randomUUID(),
      size = 48 * 1024,
      count = Math.ceil(bytes.length / size);
    for (let index = 0; index < count; index++)
      await request("run.chunk", {
        transferId,
        index,
        count,
        data: bytes
          .subarray(index * size, (index + 1) * size)
          .toString("base64"),
      });
    const result = object(await request("run.chunk.commit", { transferId }));
    if (
      result.status !== "delivered" &&
      result.status !== "detached" &&
      result.status !== "warning"
    )
      throw new ProtocolError(
        "DELIVERY_ACK",
        "Invalid delivery acknowledgement",
      );
    return result.status;
  };
  const deliveryBarriers = new Map<string, Promise<void>>();
  const replayWatermarks = new Map<
    string,
    { peer: RpcPeer; turn: number; outputs: Set<string>; final: boolean }
  >();
  const scheduler = createStreamScheduler<string, RunView & { turn: number }>({
    deliver: async (id, view) => {
      // A barrier can be replaced while an older scan is awaited. Recheck it
      // rather than letting progress jump ahead of a newly admitted boundary.
      for (;;) {
        const barrier = deliveryBarriers.get(id);
        if (!barrier) break;
        await barrier;
        if (deliveryBarriers.get(id) === barrier) break;
      }
      const peer = readyPeer;
      const watermark = replayWatermarks.get(id);
      if (!peer || watermark?.peer !== peer || view.turn !== watermark.turn)
        return;
      if (
        (view.outputs ?? []).some((output) => !watermark.outputs.has(output.id))
      )
        return;
      if (view.final && !watermark.final) return;
      await sendView(peer, id, view);
    },
    onError: report,
  });
  const debounce = (key: string, task: () => Promise<unknown>, delay = 600) => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (!signal.aborted) void lifecycle.launch(task());
      }, delay),
    );
  };
  try {
    if (config.bootstrapPath) {
      const path = config.bootstrapPath;
      if (
        !path.startsWith("/") ||
        !path.endsWith("/.telegram-console-bootstrap")
      )
        throw new Error("Unexpected bootstrap path");
      try {
        const token = (await readFile(path, "utf8")).trim();
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
          throw new Error("Malformed bootstrap token");
        await chmod(path, 0o600);
        await ctx.credentials.modifyRecord(config.credentialKey, async () => ({
          kind: "api-key",
          key: token,
        }));
        const saved = await ctx.credentials.readRecord(config.credentialKey);
        if (saved?.key !== token)
          throw new Error("Bootstrap credential write not confirmed");
        await unlink(path);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    trace({ stage: "storage", outcome: "begin" });
    domain = await ctx.storageDomain
      .open({
        name: "telegram_console_delivery",
        version: 1,
        tables: { delivery: { valueSchema: z.json() } },
      })
      .catch((error: unknown) => {
        trace({
          stage: "storage",
          outcome: "failed",
          ...startupFailure(error),
        });
        throw error;
      });
    trace({ stage: "storage", outcome: "ok" });
    trace({ stage: "configuration", outcome: "begin" });
    const table = domain.table("delivery");
    const store = {
      get: (key: string) => table.get(key),
      set: (key: string, value: JsonValue) => table.put(key, value),
      entries: async () => [...table.entries()],
    };
    const savedOwner = await store.get("settings:adminUserId");
    if (
      typeof savedOwner === "number" &&
      Number.isSafeInteger(savedOwner) &&
      savedOwner >= 0
    )
      ownerId = savedOwner;
    const savedEpoch = await store.get("settings:ownerEpoch");
    ownerEpoch =
      typeof savedEpoch === "number" &&
      Number.isSafeInteger(savedEpoch) &&
      savedEpoch >= 0
        ? savedEpoch
        : 1;
    await store.set("settings:ownerEpoch", ownerEpoch);
    bridge = await createBridge(ctx, signal);
    const localBridge = bridge;
    const remoteBridge = consoleBridge(localBridge),
      inbox = new Inbox({ store });
    const surface = {
      getTopic: async (id: string) => {
        const value = await store.get(`console:topic:${id}`);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.closed === true ||
          value.deleted === true ||
          value.topicClosed === true ||
          value.chatId !== ownerId ||
          typeof value.threadId !== "number"
        )
          return undefined;
        return { chatId: ownerId, threadId: value.threadId };
      },
    };
    const dependencies: ArtifactDependencies = {
      resources,
      get generation() {
        return generation;
      },
      get ownerEpoch() {
        return ownerEpoch;
      },
      dispatch,
      surface,
    };
    own(() => registerSendFile(ctx, dependencies));
    const widget = createWidgetPipeline({
      ...dependencies,
      ctx,
      widgetResources,
      signal,
      get generation() {
        return generation;
      },
      get ownerEpoch() {
        return ownerEpoch;
      },
    });
    const fence = (payload: JsonValue) => {
      const p = object(payload);
      if (
        signal.aborted ||
        !authority ||
        p.generation !== generation ||
        p.ownerEpoch !== ownerEpoch
      )
        throw new ProtocolError("AUTHORITY_DENIED", "Host authority denied");
      return p;
    };
    const handlers: Record<string, RpcHandler> = {};
    // Keys are fixed for the supervisor lifetime, closures resolve only the current authority.
    for (const name of [
      "bridge.list",
      "bridge.workspaces",
      "bridge.models",
      "bridge.newSessionSelection",
      "bridge.create",
      "bridge.metadata",
      "bridge.details",
      "bridge.files",
      "bridge.fileForTurn",
      "bridge.selectModel",
      "bridge.prompt",
      "bridge.steerQueued",
      "bridge.stop",
      "credentials.read",
      "resources.read",
      "resources.release",
      "uploads.begin",
      "uploads.chunk",
      "uploads.commit",
      "uploads.release",
      "questions.answer",
      "approvals.decide",
      "approvals.reason",
      "storage.namespace",
    ])
      handlers[name] = async (payload, rpcSignal) => {
        fence(payload);
        const handler = authority?.handlers()[name];
        if (!handler)
          throw new ProtocolError(
            "AUTHORITY_DENIED",
            "Host authority unavailable",
          );
        try {
          return await handler(payload, rpcSignal);
        } catch (error) {
          if (name === "credentials.read")
            trace({
              stage: "credential-read",
              outcome: "failed",
              ...startupFailure(error),
            });
          throw error;
        }
      };
    handlers["runtime.startup"] = async (payload) => {
      const p = fence(payload);
      const { generation: _generation, ownerEpoch: _epoch, ...event } = p;
      await statusWriter
        .record("child", startupEventSchema.parse(event))
        .catch(() => {});
      return null;
    };
    handlers["inbox.offset"] = async (payload) => {
      fence(payload);
      return inbox.offset();
    };
    handlers["inbox.pending"] = async (payload) => {
      fence(payload);
      return wireValue(
        (await inbox.pending()).filter(
          (entry) => entry.ownerEpoch === ownerEpoch,
        ),
      );
    };
    handlers["inbox.admit"] = async (payload) => {
      const p = fence(payload),
        update = object(p.update ?? null);
      return inbox.admit({
        updateId: integer(update.update_id, "update_id"),
        ownerEpoch,
        operation: update,
      });
    };
    handlers["inbox.settle"] = async (payload) => {
      const p = fence(payload),
        outcome = p.outcome;
      if (
        outcome !== "completed" &&
        outcome !== "failed" &&
        outcome !== "uncertain"
      )
        throw new ProtocolError("INVALID_OUTCOME", "Invalid inbox outcome");
      await inbox.settle(integer(p.updateId, "updateId"), ownerEpoch, outcome);
      return null;
    };
    handlers["runtime.acquireLease"] = async (payload) => {
      const p = fence(payload),
        botId = integer(p.botId, "botId"),
        requestedGeneration = generation;
      const operation = leaseTail.then(async () => {
        fence(payload);
        if (lease) {
          if (leasedBot !== botId)
            throw new ProtocolError(
              "LEASE_ACTIVE",
              "Activation already owns a bot lease",
            );
          return;
        }
        const acquired = await BotLease.acquire({
          directory: resolve(tmpdir(), "dsh-telegram-remote-leases"),
          botId,
          generation: requestedGeneration,
        });
        try {
          fence(payload);
          const previousBot = await store.get("settings:botIdentity");
          if (typeof previousBot === "number" && previousBot !== botId) {
            await store.set("poll-offset", 0);
            await store.set("console:inbox", { version: 1, entries: [] });
            for (const [key, value] of await store.entries())
              if (key.startsWith("console:topic:"))
                await store.set(key, {
                  ...(value &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                    ? value
                    : {}),
                  closed: true,
                  deleted: true,
                });
          }
          await store.set("settings:botIdentity", botId);
          fence(payload);
          lease = acquired;
          leasedBot = botId;
        } catch (error) {
          await acquired.close();
          throw error;
        }
      });
      leaseTail = operation.then(
        () => {},
        () => {},
      );
      await operation.catch((error: unknown) => {
        trace({ stage: "lease", outcome: "failed", ...startupFailure(error) });
        throw error;
      });
      return { acquired: true };
    };
    handlers["widgets.canonicalize"] = async (payload) => {
      const p = fence(payload);
      return widgetResources.canonicalize(
        string(p.widgetId, "widgetId"),
        string(p.path, "path"),
      );
    };
    handlers["widgets.read"] = async (payload, rpcSignal) => {
      const p = fence(payload);
      const bytes = await widgetResources.read(
        string(p.widgetId, "widgetId"),
        string(p.path, "path"),
        integer(p.maxBytes, "maxBytes"),
        rpcSignal,
      );
      fence(payload);
      return {
        ...resources.add({
          generation,
          ownerEpoch,
          name: "widget-resource",
          bytes,
        }),
      };
    };
    // One catch-up lane per session. Durable boundaries are reconstructed from
    // authoritative events, not held in a lossy progress queue. Cursor advances
    // only after child onRun has persisted delivery receipts or an explicit
    // quarantine acknowledgement. A warning is processed, never delivered.
    const replayInfrastructureErrors = new WeakSet<object>();
    const replayFatal = (error: unknown) =>
      (typeof error === "object" &&
        error !== null &&
        (replayInfrastructureErrors.has(error) ||
          (error as { code?: unknown }).code === "CANCELLED")) ||
      [
        "ABORTED",
        "TIMEOUT",
        "CLOSED",
        "CHILD_OFFLINE",
        "TRANSPORT_ERROR",
        "PENDING_LIMIT",
        "QUEUE_LIMIT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
        "EACCES",
        "EPERM",
        "ENOSPC",
      ].includes(startupFailure(error).code ?? "UNKNOWN");
    const warnReplay = (
      operation: NonNullable<StartupEvent["operation"]>,
      error: unknown,
      sourceSeq?: number,
    ) =>
      trace({
        stage: "replay",
        outcome: "warning",
        operation,
        ...startupFailure(error),
        ...startupErrorType(error),
        ...(replayTopicIndex === undefined
          ? {}
          : { topicIndex: replayTopicIndex }),
        ...(sourceSeq === undefined ? {} : { sourceSeq }),
      });
    const catchups = new Map<
      string,
      { work: Promise<void>; pending: RpcPeer | undefined }
    >();
    const catchUp = (id: string, peer: RpcPeer): Promise<void> => {
      const active = catchups.get(id);
      if (active) {
        active.pending = peer; // A single dirty slot, never one closure per boundary.
        return active.work;
      }
      const scan = async (peer: RpcPeer) => {
        if (
          readyPeer !== peer ||
          signal.aborted ||
          !(await replayStep("topic-lookup", () => surface.getTopic(id)))
        )
          return;
        const epoch = ownerEpoch;
        const saved = await replayStep("read-cursor", () =>
          store.get(`console:source:${id}`),
        );
        const cursor =
          saved &&
          typeof saved === "object" &&
          !Array.isArray(saved) &&
          saved.ownerEpoch === epoch &&
          typeof saved.seq === "number"
            ? saved.seq
            : -1;
        const observation = await replayStep("observe-session", () =>
          ctx.sessionQuery.observeSession(id, {
            signal,
            projectionMode: "all",
          }),
        );
        try {
          let state = initialRun();
          let observedTurn = false;
          let cursorBlocked = false;
          for (let index = 0; index < observation.events.length; index++) {
            if (readyPeer !== peer || epoch !== ownerEpoch || signal.aborted)
              return;
            const event = observation.events[index];
            if (!event) continue;
            if (event.type === "turn/start") observedTurn = true;
            if (
              !observedTurn &&
              ["assistant/message", "turn/end"].includes(event.type)
            ) {
              cursorBlocked = true;
              warnReplay(
                "fold-events",
                new ProtocolError(
                  "SOURCE_INCOMPLETE",
                  "Session observation is missing its turn prefix",
                ),
                event.seq ?? index,
              );
              continue;
            }
            const seq = event.seq ?? index;
            try {
              state = foldRun(state, event);
            } catch (error) {
              if (replayFatal(error)) throw error;
              // A malformed historical event is not delivery evidence. Keep the
              // cursor behind it, but let subsequent valid boundaries be tried.
              cursorBlocked = true;
              warnReplay("fold-events", error, seq);
              continue;
            }
            if (
              seq <= cursor ||
              !["assistant/message", "turn/end"].includes(event.type)
            )
              continue;
            if (readyPeer !== peer || epoch !== ownerEpoch || signal.aborted)
              return;
            let acknowledgement: "delivered" | "detached" | "warning";
            try {
              const view = semanticRunView({
                ...state,
                cwd:
                  observation.header.cwd ??
                  ctx.workingDirectory.defaultDirectory,
                elapsed: Math.max(
                  0,
                  ((state.ended || Date.now()) - state.started) / 1000,
                ),
              });
              acknowledgement = await replayStep(
                "send-view",
                () => sendView(peer, id, view, true),
                seq,
              );
            } catch (error) {
              if (readyPeer !== peer || epoch !== ownerEpoch || signal.aborted)
                return;
              if (replayFatal(error)) throw error;
              // HANDLER_ERROR and invalid ACKs can hide accepted sends. Later
              // boundaries may reconcile via child receipts, but cannot certify
              // this source prefix or enable progress to bypass it.
              cursorBlocked = true;
              warnReplay("send-view", error, seq);
              continue;
            }
            if (acknowledgement === "detached") return;
            if (acknowledgement === "warning")
              warnReplay("send-view", { code: "OUTPUT_QUARANTINED" }, seq);
            if (readyPeer !== peer || epoch !== ownerEpoch || signal.aborted)
              return;
            if (cursorBlocked) continue;
            await replayStep(
              "write-cursor",
              () =>
                store.set(`console:source:${id}`, {
                  ownerEpoch: epoch,
                  seq,
                }),
              seq,
            );
          }
          if (
            !cursorBlocked &&
            readyPeer === peer &&
            epoch === ownerEpoch &&
            !signal.aborted
          ) {
            replayWatermarks.set(id, {
              peer,
              turn: state.turn,
              outputs: new Set(state.outputs.map((output) => output.id)),
              final: state.final,
            });
          }
        } finally {
          await replayStep("dispose-observation", () =>
            observation[Symbol.dispose](),
          );
        }
      };
      const cell: { work: Promise<void>; pending: RpcPeer | undefined } = {
        work: Promise.resolve(),
        pending: peer,
      };
      const work = Promise.resolve().then(async () => {
        while (cell.pending) {
          const next = cell.pending;
          cell.pending = undefined;
          try {
            await scan(next);
          } catch (error) {
            // A replacement peer may arrive while the old peer's request fails.
            // Its one dirty slot must survive that failure, not inherit it.
            if (readyPeer !== next || signal.aborted) {
              if (!cell.pending || cell.pending === next) return;
              continue;
            }
            if (replayFatal(error)) throw error;
            warnReplay("replay-topic", error);
          }
        }
      });
      cell.work = work;
      catchups.set(id, cell);
      deliveryBarriers.set(id, work);
      void work
        .finally(() => {
          if (catchups.get(id) === cell) catchups.delete(id);
          if (deliveryBarriers.get(id) === work) deliveryBarriers.delete(id);
        })
        .catch(() => {});
      return work;
    };
    let replayTopicIndex: number | undefined;
    const replayStep = async <T>(
      operation: NonNullable<StartupEvent["operation"]>,
      task: () => T | Promise<T>,
      sourceSeq?: number,
    ): Promise<T> => {
      const started = performance.now();
      const tracing =
        operation === "list-topics" || replayTopicIndex !== undefined;
      if (tracing)
        trace({
          stage: "replay",
          outcome: "begin",
          operation,
          ...(replayTopicIndex === undefined
            ? {}
            : { topicIndex: replayTopicIndex }),
          ...(sourceSeq === undefined ? {} : { sourceSeq }),
        });
      try {
        const result = await task();
        if (tracing)
          trace({
            stage: "replay",
            outcome: "ok",
            operation,
            durationMs: Math.floor(performance.now() - started),
            ...(replayTopicIndex === undefined
              ? {}
              : { topicIndex: replayTopicIndex }),
            ...(sourceSeq === undefined ? {} : { sourceSeq }),
          });
        return result;
      } catch (error) {
        if (
          [
            "list-topics",
            "topic-lookup",
            "read-cursor",
            "write-cursor",
            "dispose-observation",
          ].includes(operation) &&
          typeof error === "object" &&
          error !== null
        )
          replayInfrastructureErrors.add(error);
        if (tracing)
          trace({
            stage: "replay",
            outcome: replayFatal(error) ? "failed" : "warning",
            operation,
            durationMs: Math.floor(performance.now() - started),
            ...startupFailure(error),
            ...startupErrorType(error),
            ...(replayTopicIndex === undefined
              ? {}
              : { topicIndex: replayTopicIndex }),
            ...(sourceSeq === undefined ? {} : { sourceSeq }),
          });
        throw error;
      }
    };
    const replay = async (peer: RpcPeer) => {
      let index = 0;
      for (const [key] of await replayStep("list-topics", () =>
        store.entries(),
      )) {
        if (readyPeer !== peer || signal.aborted) return;
        if (key.startsWith("console:topic:")) {
          replayTopicIndex = ++index;
          try {
            await catchUp(key.slice("console:topic:".length), peer);
          } finally {
            replayTopicIndex = undefined;
          }
        }
      }
    };
    const rotate = (): Promise<void> => {
      const operation = rotation.then(async () => {
        trace({ stage: "rotation", outcome: "begin" });
        readyPeer = undefined;
        authority?.close();
        authority = undefined;
        await supervisor?.close();
        await leaseTail;
        await lease?.close();
        lease = undefined;
        leasedBot = undefined;
        if (signal.aborted) return;
        trace({ stage: "credential-check", outcome: "begin" });
        let configured: boolean;
        try {
          configured =
            ownerId > 0 &&
            (await ctx.credentials.describeRecord(config.credentialKey))
              .configured;
          trace({
            stage: "credential-check",
            outcome: configured ? "ok" : "skipped",
            ...(!configured ? { code: "NOT_CONFIGURED" as const } : {}),
          });
        } catch (error) {
          trace({
            stage: "credential-check",
            outcome: "failed",
            ...startupFailure(error),
          });
          throw error;
        }
        if (!configured) {
          trace({
            stage: "rotation",
            outcome: "skipped",
            code: "NOT_CONFIGURED",
          });
          await status("unconfigured");
          return;
        }
        trace({ stage: "credential-read", outcome: "begin" });
        const credential = await ctx.credentials
          .readRecord(config.credentialKey)
          .catch((error: unknown) => {
            trace({
              stage: "credential-read",
              outcome: "failed",
              ...startupFailure(error),
            });
            throw error;
          });
        trace({ stage: "credential-read", outcome: "ok" });
        const pinnedCredential =
          credential?.kind === "api-key" && credential.key
            ? { kind: "api-key", key: credential.key }
            : null;
        const current = (
          activationDependencies.createSupervisor ??
          ((options) => new ChildSupervisor(options))
        )({
          entry: new URL("./child/index.js", import.meta.url),
          build: version,
          handlers,
          onStartup: trace,
          onHandlerError: (method, error) => {
            const rpcMethod =
              startupEventSchema.shape.rpcMethod.safeParse(method);
            trace({
              stage: "runtime-error",
              outcome: "failed",
              operation: "rpc-handler",
              ...(rpcMethod.success ? { rpcMethod: rpcMethod.data } : {}),
              ...startupFailure(error),
              ...startupErrorType(error),
            });
          },
          onOffline: report,
          onReady: (peer) => {
            if (signal.aborted || supervisor !== current) return;
            readyPeer = undefined;
            authority?.close();
            const launchGeneration = current.currentGeneration;
            generation = launchGeneration;
            authority = new HostAuthority({
              bridge: remoteBridge,
              store,
              credentials: { readRecord: async () => pinnedCredential },
              credentialKey: config.credentialKey,
              ownerId,
              ownerEpoch,
              generation,
              approvals,
              questions,
              resources,
            });
            let startupPhase: "initialize" | "replay" = "initialize";
            void lifecycle.launch(
              (async () => {
                trace({ stage: "initialize", outcome: "begin" });
                await peer.request(
                  "runtime.initialize",
                  {
                    ownerId,
                    ownerEpoch,
                    locale: dshLocale(ctx),
                    version,
                    toolNameRules,
                  },
                  { signal, timeoutMs: INITIALIZE_TIMEOUT_MS },
                );
                if (
                  supervisor !== current ||
                  generation !== launchGeneration ||
                  current.currentGeneration !== launchGeneration ||
                  current.peer !== peer ||
                  signal.aborted
                )
                  return;
                trace({ stage: "initialize", outcome: "ok" });
                readyPeer = peer;
                startupPhase = "replay";
                trace({ stage: "replay", outcome: "begin" });
                await replay(peer);
                if (
                  signal.aborted ||
                  supervisor !== current ||
                  readyPeer !== peer ||
                  current.peer !== peer ||
                  generation !== launchGeneration ||
                  current.currentGeneration !== launchGeneration
                )
                  return;
                trace({ stage: "replay", outcome: "ok" });
                trace({ stage: "ready", outcome: "ok" });
                lastError = null;
                await status("running");
              })().catch(async (error: unknown) => {
                trace({
                  stage: startupPhase,
                  outcome: "failed",
                  ...startupFailure(error),
                });
                // Ignore late failures from a rotated/unloaded generation.
                if (
                  signal.aborted ||
                  supervisor !== current ||
                  current.peer !== peer
                )
                  return;
                report();
                if (startupPhase === "initialize") {
                  readyPeer = undefined;
                  authority?.close();
                  // Keep the Host lease until the owned worker has exited. Recovery
                  // uses the supervisor's bounded restart budget, not a fresh loop.
                  current.recover(peer);
                }
                // Replay may contain an accepted-but-unacknowledged Telegram send.
                // Keep polling/control RPCs alive; never restart/resend blindly.
                // The cursor stays unadvanced and delivery receipts retain uncertainty.
              }),
            );
          },
        });
        supervisor = current;
        await status("connecting");
        await current.start();
      });
      rotation = operation.catch((error: unknown) => {
        trace({
          stage: "rotation",
          outcome: "failed",
          ...startupFailure(error),
        });
        report();
      });
      return operation;
    };
    const settings = createSettingsController({
      credentials: ctx.credentials,
      credentialKey: config.credentialKey,
      store,
      getLocale: () => dshLocale(ctx),
      getAdmin: () => ownerId,
      onCredentialsChanged: rotate,
      setAdmin: async (value) => {
        if (ownerId === value) return;
        const old = ownerEpoch;
        ownerId = value;
        ownerEpoch++;
        approvals.revokeEpoch(old);
        authority?.close();
        for (const entry of await inbox.pending())
          if (entry.ownerEpoch !== ownerEpoch)
            await inbox.settle(entry.updateId, entry.ownerEpoch, "uncertain");
        await store.set("settings:ownerEpoch", ownerEpoch);
        await rotate();
      },
    });
    registerSettingsRoute(ctx, settings, {
      getDebugLog: () => statusWriter.debugLog(),
    });
    let lastLocale = dshLocale(ctx);
    const localeTimer = setInterval(() => {
      if (signal.aborted || !readyPeer) return;
      const locale = dshLocale(ctx);
      if (locale === lastLocale) return;
      const peer = readyPeer;
      void lifecycle.launch(
        peer.request("settings.update", { locale }, { signal }).then(() => {
          if (readyPeer === peer) lastLocale = locale;
        }),
      );
    }, 1000);
    lifecycle.own(() => clearInterval(localeTimer));
    own(() =>
      ctx.systemPrompt.section({
        name: "telegram-result-files",
        order: 901,
        interpolate: false,
        text: "For a finished result file in a connected Telegram session, call send_file to deliver it as a document. Merely mentioning its path does not upload it.",
      }),
    );
    own(() =>
      ctx.systemPrompt.section({
        name: "telegram-widget-authoring",
        order: 900,
        interpolate: false,
        text: "Telegram output: to publish an interactive widget in a connected Telegram session, write telegram_widget_<name>.html inside the session workspace. Rewriting the same filename replaces its widget. Use self-contained HTML, inline CSS/classic JS, SVG/CSS charts, no network calls, no navigation or external fonts. Maximum 32 KiB UTF-8 and 4 KiB zlib-9. Widget queries are disabled. Controls and approvals remain owner-only Telegram buttons. See WIDGETS.md in the telegram console plugin for details.",
      }),
    );
    const publish = (
      id: string,
      view: RunView & { turn: number },
      immediate = false,
    ) => {
      scheduler.push(id, view, { immediate });
    };
    own(() =>
      ctx.on("session/event", (session, event) => {
        if (signal.aborted) return;
        if (
          [
            "turn/start",
            "step/start",
            "tool/call",
            "tool/result",
            "todo/write",
            "assistant/message",
            "assistant/attempt",
            "turn/end",
          ].includes(event.type)
        ) {
          const view = semanticRunView(localBridge.runView(session)),
            stream = streams.get(session.id);
          if (stream && stream.turn === view.turn) {
            view.partialAnswer = stream.text;
            view.partialId = stream.attempt;
          }
          if (
            (event.type === "assistant/message" ||
              event.type === "turn/end" ||
              event.type === "turn/start") &&
            readyPeer
          )
            void lifecycle.launch(catchUp(session.id, readyPeer));
          publish(
            session.id,
            view,
            event.type === "turn/start" ||
              event.type === "todo/write" ||
              event.type === "turn/end" ||
              event.type === "assistant/message",
          );
        }
        if (
          [
            "session/title",
            "model/selection",
            "working-directory/change",
            "turn/end",
          ].includes(event.type)
        )
          debounce(`card:${session.id}`, () =>
            dispatch.request("session.refresh", { sessionId: session.id }),
          );
      }),
    );
    own(() =>
      ctx.on("agent/assistant-stream", ({ agent, frame }) => {
        if (signal.aborted) return;
        if (frame.type === "start")
          streams.set(agent.id, {
            attempt: frame.attemptId,
            turn: frame.turn,
            text: "",
          });
        if (
          frame.type === "chunk" &&
          frame.chunk.type === "text-delta" &&
          typeof frame.chunk.text === "string"
        ) {
          const current = streams.get(agent.id);
          if (!current || current.attempt !== frame.attemptId) return;
          current.text += frame.chunk.text;
          publish(agent.id, {
            ...semanticRunView(localBridge.runView(agent.session)),
            turn: current.turn,
            partialAnswer: current.text,
            partialId: current.attempt,
          });
        }
        if (
          frame.type === "end" &&
          streams.get(agent.id)?.attempt === frame.attemptId
        )
          streams.delete(agent.id);
      }),
    );
    own(() =>
      ctx.on("tools/result", (exec, result) => {
        if (
          result.isError ||
          !exec.agent ||
          !["write", "edit", "apply_patch", "write_file", "edit_file"].includes(
            exec.name,
          )
        )
          return;
        const path = exec.arguments.file_path ?? exec.arguments.path;
        const agent = exec.agent;
        if (
          typeof path === "string" &&
          /^telegram_widget_.*\.html$/i.test(basename(path))
        )
          debounce(
            `widget:${agent.id}:${path}`,
            () => widget(agent, path),
            200,
          );
      }),
    );
    own(() =>
      registerApprovalForwarding(ctx, {
        approvals,
        signal,
        surface,
        get ownerId() {
          return ownerId;
        },
        get ownerEpoch() {
          return ownerEpoch;
        },
        get peer() {
          return readyPeer;
        },
      }),
    );
    own(() =>
      registerQuestionForwarding(ctx, {
        questions,
        signal,
        surface,
        get ownerId() {
          return ownerId;
        },
        get ownerEpoch() {
          return ownerEpoch;
        },
        get generation() {
          return generation;
        },
        get peer() {
          return readyPeer;
        },
      }),
    );
    trace({ stage: "configuration", outcome: "ok" });
    trace({ stage: "activation", outcome: "ok" });
    await rotate();
  } catch (error) {
    trace({ stage: "activation", outcome: "failed", ...startupFailure(error) });
    await close();
    throw error;
  }
}
