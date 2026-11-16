import { normalizeLocale, type BotLocale } from "./bot-i18n.js";

/** Only the host settings fields needed by locale selection. */
export interface LocaleDocument {
  ns?: unknown;
  value?: { preference?: unknown } | null;
}

export interface LocaleSettings {
  describe(options: {
    redactSecrets: true;
  }): readonly LocaleDocument[] | null | undefined;
}

export interface LocaleContext {
  get(name: "settings"): LocaleSettings | null | undefined;
}

/** Read the explicit DSH language preference each time; never infer from Telegram. */
export function dshLocale(ctx: LocaleContext): BotLocale {
  const settings = ctx.get("settings");
  const documents = settings?.describe({ redactSecrets: true }) ?? [];
  const locale = documents.find(
    (item) =>
      String(item.ns) === "locale" || String(item.ns).endsWith(":locale"),
  );
  return normalizeLocale(locale?.value?.preference);
}
