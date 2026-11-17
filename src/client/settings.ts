import type {
  ChangeEvent,
  CSSProperties,
  FormEvent,
  ReactElement,
} from "react";
import { messages, normalizeLocale, errorKeys } from "./messages.js";
import type { Locale, MessageKey } from "./messages.js";

interface SettingsResponse {
  locale?: unknown;
  adminUserId: unknown;
  tokenConfigured: boolean;
  error?: unknown;
}
interface SettingsWrite {
  adminUserId: string;
  botToken?: string;
}
interface Note {
  key: MessageKey;
  details?: string;
}
export interface SettingsSection {
  name: "settings.section";
  id: "telegram-console";
  order: number;
  label(): string;
}
export interface Slots {
  inject(name: "settings.section", register: () => void): void;
  register(options: SettingsSection, component: () => ReactElement): void;
}
export interface ClientContext {
  slots: Slots;
}
export function applySettings(
  React: typeof import("react"),
  ctx: ClientContext,
): void {
  const h = React.createElement;
  let locale: Locale = "en";
  function Settings(): ReactElement {
    const [language, setLanguage] = React.useState(locale),
      [admin, setAdmin] = React.useState(""),
      [token, setToken] = React.useState(""),
      [configured, setConfigured] = React.useState(false),
      [busy, setBusy] = React.useState(true),
      [saving, setSaving] = React.useState(false),
      [note, setNote] = React.useState<Note | null>(null),
      [copying, setCopying] = React.useState(false),
      [copyNote, setCopyNote] = React.useState<MessageKey | null>(null);
    const text = messages[language];
    function acceptLocale(value: SettingsResponse) {
      locale = normalizeLocale(value.locale);
      setLanguage(locale);
    }
    async function call(body?: SettingsWrite): Promise<SettingsResponse> {
      const response = await fetch("/telegram-console/settings", {
        credentials: "same-origin",
        cache: "no-store",
        ...(body
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      // Some rejected requests have no JSON body. Keep their UI error localized.
      let value: SettingsResponse;
      try {
        value = (await response.json()) as SettingsResponse;
      } catch {
        throw Error("");
      }
      if (!response.ok)
        throw Error(typeof value?.error === "string" ? value.error : "");
      return value;
    }
    function failure(error: unknown, kind: "loadError" | "saveError"): Note {
      const message = (error as { message: string }).message;
      return {
        key: errorKeys[message] || kind,
        details: errorKeys[message] ? "" : message,
      };
    }
    React.useEffect(() => {
      let live = true;
      call()
        .then((value) => {
          if (live) {
            acceptLocale(value);
            setAdmin(String(value.adminUserId));
            setConfigured(value.tokenConfigured);
          }
        })
        .catch((error) => {
          if (live) setNote(failure(error, "loadError"));
        })
        .finally(() => {
          if (live) setBusy(false);
        });
      return () => {
        live = false;
      };
    }, []);
    async function save(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setBusy(true);
      setSaving(true);
      setNote(null);
      try {
        const value = await call({
          adminUserId: admin,
          ...(token ? { botToken: token } : {}),
        });
        acceptLocale(value);
        setToken("");
        setConfigured(value.tokenConfigured);
        setNote({ key: "saved" });
      } catch (error) {
        setNote(failure(error, "saveError"));
      } finally {
        setBusy(false);
        setSaving(false);
      }
    }
    async function copyDebugLog() {
      if (copying) return;
      setCopying(true);
      setCopyNote(null);
      try {
        const response = await fetch("/telegram-console/settings?debug=1", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw Error("Debug export failed");
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("debugLog" in value) ||
          typeof value.debugLog !== "string"
        ) {
          throw Error("Invalid debug export");
        }
        await navigator.clipboard.writeText(value.debugLog);
        setCopyNote("debugCopied");
      } catch {
        // Do not display backend/clipboard exception details or exported content.
        setCopyNote("debugCopyError");
      } finally {
        setCopying(false);
      }
    }
    const input: CSSProperties = {
      width: "100%",
      boxSizing: "border-box",
      padding: "10px 12px",
      borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-primary)",
      font: "inherit",
    };
    return h(
      "section",
      {
        style: {
          maxWidth: 600,
          padding: 24,
          color: "var(--dsw-alias-label-primary)",
        },
      },
      h("h2", null, text.title),
      h(
        "p",
        { style: { color: "var(--dsw-alias-label-secondary)" } },
        text.intro,
      ),
      h(
        "form",
        { onSubmit: save },
        h("label", { htmlFor: "telegram-admin" }, text.admin),
        h("input", {
          id: "telegram-admin",
          inputMode: "numeric",
          value: admin,
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setAdmin(e.target.value),
          style: input,
        }),
        h(
          "p",
          {
            style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
          },
          text.adminHelp,
        ),
        h("label", { htmlFor: "telegram-token" }, text.token),
        h("input", {
          id: "telegram-token",
          type: "password",
          autoComplete: "new-password",
          value: token,
          disabled: busy,
          placeholder: configured ? text.tokenSaved : text.tokenPlaceholder,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setToken(e.target.value),
          style: input,
        }),
        h(
          "p",
          {
            style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
          },
          text.tokenHelp,
        ),
        h(
          "button",
          {
            type: "submit",
            disabled: busy,
            style: {
              padding: "9px 18px",
              borderRadius: 8,
              border: 0,
              background: "var(--dsw-alias-button-primary-fill)",
              color: "var(--dsw-alias-label-primary-inverted)",
            },
          },
          busy ? (saving ? text.saving : text.loading) : text.save,
        ),
        h(
          "p",
          { role: "status", "aria-live": "polite" },
          note ? text[note.key] + (note.details ? " " + note.details : "") : "",
        ),
      ),
      h(
        "button",
        { type: "button", disabled: copying, onClick: copyDebugLog },
        copying ? text.debugCopying : text.copyDebugLog,
      ),
      h(
        "p",
        { role: "status", "aria-live": "polite" },
        copyNote ? text[copyNote] : "",
      ),
    );
  }
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "telegram-console",
        order: 35,
        label: () => messages[locale].title,
      },
      Settings,
    ),
  );
}
