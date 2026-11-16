import type {
  CredentialsService,
  SettingsRouteContext,
  SettingsStore,
} from "./dsh-contracts.js";

export interface SettingsSnapshot {
  adminUserId: number;
  tokenConfigured: boolean;
  locale?: string;
}
export interface SettingsController {
  read(): Promise<SettingsSnapshot>;
  save(input: unknown): Promise<SettingsSnapshot>;
}
export interface SettingsControllerDependencies {
  credentials: CredentialsService;
  credentialKey: string;
  store: SettingsStore;
  getAdmin(): number;
  /** Await owner revocation before acknowledging the updated settings. */
  setAdmin(value: number): unknown | Promise<unknown>;
  getLocale?(): string;
  /** Host-only notification: never pass the token to the route or its response. */
  onCredentialsChanged?(): void | Promise<void>;
}

export function createSettingsController({
  credentials,
  credentialKey,
  store,
  getAdmin,
  setAdmin,
  getLocale,
  onCredentialsChanged,
}: SettingsControllerDependencies): SettingsController {
  const read = async (): Promise<SettingsSnapshot> => ({
    adminUserId: getAdmin(),
    tokenConfigured: (await credentials.describeRecord(credentialKey))
      .configured,
    ...(getLocale ? { locale: getLocale() } : {}),
  });
  return {
    read,
    async save(input) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("Settings must be an object.");
      const fields: Record<string, unknown> = input as Record<string, unknown>;
      const admin = Number(fields.adminUserId);
      if (!Number.isSafeInteger(admin) || admin <= 0)
        throw Error("Admin user ID must be a positive integer.");
      const token = fields.botToken;
      if (
        token !== undefined &&
        token !== "" &&
        (typeof token !== "string" ||
          !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim()))
      ) {
        throw Error("Enter a valid Telegram bot token.");
      }
      if (typeof token === "string" && token.trim()) {
        const key = token.trim();
        await credentials.modifyRecord(credentialKey, async () => ({
          kind: "api-key",
          key,
        }));
        const saved = await credentials.readRecord(credentialKey);
        if (saved?.kind !== "api-key" || saved.key !== key)
          throw Error("The credentials store did not confirm the token write.");
        await onCredentialsChanged?.();
      }
      if (admin !== getAdmin()) {
        for (const [key, value] of await store.entries()) {
          if (key.startsWith("console:topic:")) {
            // Topic rows are JSON objects; a damaged row must not prevent owner revocation.
            const prior =
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value)
                ? value
                : {};
            await store.set(key, { ...prior, deleted: true, closed: true });
          }
        }
      }
      await store.set("settings:adminUserId", admin);
      await setAdmin(admin);
      return read();
    },
  };
}

/** Harness owns Host/Origin trust, including trusted Desktop origins. */
export function registerSettingsRoute(
  ctx: SettingsRouteContext,
  controller: SettingsController,
): unknown {
  return ctx.effect(() =>
    ctx.webServer.register({
      kind: "exact",
      path: "/telegram-console/settings",
      handler: async (req, res) => {
        const headers = {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        };
        const end = (status: number, value?: unknown): void => {
          res.writeHead(status, headers);
          res.end(value === undefined ? undefined : JSON.stringify(value));
        };
        const rejection = ctx.connection.requestRejection({
          headers: req.headers,
        });
        if (rejection) {
          end(rejection, { error: "Harness rejected this settings request." });
          return;
        }
        const admission = ctx.connection.admit({ headers: req.headers });
        if (
          "rejection" in admission ||
          admission.peer.principal.kind !== "owner"
        ) {
          end(403);
          return;
        }
        const content: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) {
            end(413);
            return;
          }
          content.push(chunk);
        }
        const requestHeaders = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value))
            for (const item of value) requestHeaders.append(name, item);
          else if (value !== undefined) requestHeaders.set(name, value);
        }
        const request = new Request(
          new URL(
            req.url ?? "/telegram-console/settings",
            ctx.webServer.getOrigin(),
          ),
          {
            method: req.method,
            headers: requestHeaders,
            ...(req.method === "POST" ? { body: Buffer.concat(content) } : {}),
          },
        );
        try {
          if (request.method === "GET") {
            end(200, await controller.read());
            return;
          }
          if (request.method !== "POST") {
            end(405, { error: "Method not allowed" });
            return;
          }
          if (
            !request.headers.get("content-type")?.startsWith("application/json")
          ) {
            end(415, { error: "JSON required" });
            return;
          }
          const body = await request.text();
          if (body.length > 4096) {
            end(413, { error: "Request too large" });
            return;
          }
          const input: unknown = JSON.parse(body);
          end(200, await controller.save(input));
        } catch (error) {
          end(400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
  );
}
