import { z } from "zod";

/** Fixed vocabulary: no backend text, paths, URLs, payloads or credentials. */
export const startupStages = [
  "activation",
  "storage",
  "configuration",
  "rotation",
  "credential-check",
  "credential-read",
  "launch",
  "handshake",
  "initialize",
  "surface",
  "getMe",
  "getWebhookInfo",
  "webhook-check",
  "lease",
  "commands",
  "setMyCommands",
  "ingress",
  "replay",
  "ready",
  "shutdown",
  "exit",
  "disconnect",
  "restart",
  "runtime-error",
] as const;
export const startupEventSchema = z
  .object({
    stage: z.enum(startupStages),
    outcome: z.enum(["begin", "ok", "failed", "skipped", "info"]),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    code: z
      .enum([
        "UNKNOWN",
        "ABORTED",
        "INVALID_DATA",
        "WEBHOOK_CONFIGURED",
        "NOT_CONFIGURED",
        "NOT_ACKNOWLEDGED",
        "AUTHORITY_DENIED",
        "LEASE_HELD",
        "LEASE_ACTIVE",
        "LEASE_DIRECTORY",
        "LEASE_IDENTITY",
        "LAUNCH_FAILED",
        "STARTUP_EXIT",
        "STARTUP_DISCONNECT",
        "STARTUP_TIMEOUT",
        "INVALID_HELLO",
        "RESTART_BUDGET",
        "TERMINATION_FAILED",
        "TERMINATION_TIMEOUT",
        "TIMEOUT",
        "CLOSED",
        "HANDLER_ERROR",
        "TRANSPORT_ERROR",
        "PENDING_LIMIT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EACCES",
        "EPERM",
        "ENOENT",
        "ENOSPC",
        "EEXIST",
        "EPIPE",
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "TELEGRAM_REJECTED",
      ])
      .optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    language: z.enum(["", "en", "zh", "ru"]).optional(),
    pid: z.number().int().positive().optional(),
    exitCode: z.number().int().optional(),
    signal: z
      .enum(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT", "SIGHUP"])
      .optional(),
    delayMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type StartupEvent = z.infer<typeof startupEventSchema>;
export type StartupObserver = (event: StartupEvent) => void;

export function startupFailure(
  error: unknown,
): Pick<StartupEvent, "code" | "statusCode"> {
  try {
    // Never stringify errors. Even their code/name may contain injected secrets.
    const fields =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const raw = fields.code ?? fields.errorCode;
    if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= 100 &&
      raw <= 599
    )
      return { code: "TELEGRAM_REJECTED", statusCode: raw };
    const parsed = startupEventSchema.shape.code.safeParse(raw);
    if (parsed.success && parsed.data) return { code: parsed.data };
    if (fields.name === "AbortError") return { code: "ABORTED" };
    if (fields.name === "ZodError" || fields.name === "TypeError")
      return { code: "INVALID_DATA" };
    const cause = fields.cause;
    if (cause && typeof cause === "object") {
      const nested = startupEventSchema.shape.code.safeParse(
        (cause as Record<string, unknown>).code,
      );
      if (nested.success && nested.data) return { code: nested.data };
    }
    return { code: "UNKNOWN" };
  } catch {
    return { code: "UNKNOWN" };
  }
}

export function observeStartup(
  observer: StartupObserver | undefined,
  event: StartupEvent,
): void {
  try {
    observer?.(startupEventSchema.parse(event));
  } catch {
    /* Diagnostics never own runtime control. */
  }
}
