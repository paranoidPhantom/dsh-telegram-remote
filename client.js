"use strict";
(() => {
  // src/client/messages.ts
  var messages = {
    en: {
      title: "Telegram Remote",
      intro: "Connect a private Telegram bot and choose the only user allowed to control it.",
      admin: "Admin user ID",
      adminHelp: "Numeric Telegram user ID. Changing it revokes the previous admin\u2019s access.",
      token: "Bot token",
      tokenSaved: "Token saved \u2014 leave blank to keep it",
      tokenPlaceholder: "Paste the token from BotFather",
      tokenHelp: "Stored in DSH credentials, never in plugin configuration. The saved token is not returned to this page.",
      loading: "Loading\u2026",
      saving: "Saving\u2026",
      save: "Save",
      copyDebugLog: "Copy debug log",
      debugCopying: "Copying\u2026",
      debugCopied: "Debug log copied.",
      debugCopyError: "Unable to copy debug log.",
      saved: "Saved. The admin ID applies immediately; token changes are read on the next API request.",
      loadError: "Unable to load settings.",
      saveError: "Unable to save settings.",
      adminError: "Admin user ID must be a positive integer.",
      tokenError: "Enter a valid Telegram bot token.",
      credentialError: "The credentials store did not confirm the token write.",
      rejected: "Harness rejected this settings request.",
      ownerError: "Owner access required.",
      methodError: "Method not allowed.",
      jsonError: "JSON required.",
      sizeError: "Request too large."
    },
    zh: {
      title: "Telegram \u8FDC\u7A0B\u63A7\u5236",
      intro: "\u8FDE\u63A5\u79C1\u4EBA Telegram \u673A\u5668\u4EBA\uFF0C\u5E76\u6307\u5B9A\u552F\u4E00\u6709\u6743\u63A7\u5236\u5B83\u7684\u7528\u6237\u3002",
      admin: "\u7BA1\u7406\u5458\u7528\u6237 ID",
      adminHelp: "Telegram \u6570\u5B57\u7528\u6237 ID\u3002\u66F4\u6539\u540E\uFF0C\u539F\u7BA1\u7406\u5458\u5C06\u5931\u53BB\u8BBF\u95EE\u6743\u9650\u3002",
      token: "\u673A\u5668\u4EBA\u4EE4\u724C",
      tokenSaved: "\u4EE4\u724C\u5DF2\u4FDD\u5B58 \u2014 \u7559\u7A7A\u4EE5\u4FDD\u7559",
      tokenPlaceholder: "\u7C98\u8D34 BotFather \u63D0\u4F9B\u7684\u4EE4\u724C",
      tokenHelp: "\u4EC5\u5B58\u50A8\u5728 DSH \u51ED\u636E\u4E2D\uFF0C\u4E0D\u5199\u5165\u63D2\u4EF6\u914D\u7F6E\u3002\u6B64\u9875\u9762\u4E0D\u4F1A\u8BFB\u53D6\u5DF2\u4FDD\u5B58\u7684\u4EE4\u724C\u3002",
      loading: "\u52A0\u8F7D\u4E2D\u2026",
      saving: "\u4FDD\u5B58\u4E2D\u2026",
      save: "\u4FDD\u5B58",
      copyDebugLog: "\u590D\u5236\u8C03\u8BD5\u65E5\u5FD7",
      debugCopying: "\u590D\u5236\u4E2D\u2026",
      debugCopied: "\u8C03\u8BD5\u65E5\u5FD7\u5DF2\u590D\u5236\u3002",
      debugCopyError: "\u65E0\u6CD5\u590D\u5236\u8C03\u8BD5\u65E5\u5FD7\u3002",
      saved: "\u5DF2\u4FDD\u5B58\u3002\u7BA1\u7406\u5458 ID \u7ACB\u5373\u751F\u6548\uFF1B\u4EE4\u724C\u66F4\u6539\u5C06\u5728\u4E0B\u4E00\u6B21 API \u8BF7\u6C42\u65F6\u4F7F\u7528\u3002",
      loadError: "\u65E0\u6CD5\u52A0\u8F7D\u8BBE\u7F6E\u3002",
      saveError: "\u65E0\u6CD5\u4FDD\u5B58\u8BBE\u7F6E\u3002",
      adminError: "\u7BA1\u7406\u5458\u7528\u6237 ID \u5FC5\u987B\u4E3A\u6B63\u6574\u6570\u3002",
      tokenError: "\u8BF7\u8F93\u5165\u6709\u6548\u7684 Telegram \u673A\u5668\u4EBA\u4EE4\u724C\u3002",
      credentialError: "\u51ED\u636E\u5B58\u50A8\u672A\u786E\u8BA4\u4EE4\u724C\u5199\u5165\u6210\u529F\u3002",
      rejected: "Harness \u62D2\u7EDD\u4E86\u6B64\u8BBE\u7F6E\u8BF7\u6C42\u3002",
      ownerError: "\u9700\u8981\u6240\u6709\u8005\u6743\u9650\u3002",
      methodError: "\u4E0D\u652F\u6301\u6B64\u8BF7\u6C42\u65B9\u6CD5\u3002",
      jsonError: "\u9700\u8981 JSON \u683C\u5F0F\u3002",
      sizeError: "\u8BF7\u6C42\u8FC7\u5927\u3002"
    },
    ru: {
      title: "\u0423\u0434\u0430\u043B\u0451\u043D\u043D\u044B\u0439 \u0434\u043E\u0441\u0442\u0443\u043F \u0447\u0435\u0440\u0435\u0437 Telegram",
      intro: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u043B\u0438\u0447\u043D\u043E\u0433\u043E Telegram-\u0431\u043E\u0442\u0430 \u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0433\u043E \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F, \u043A\u043E\u0442\u043E\u0440\u043E\u043C\u0443 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u043E \u0438\u043C \u0443\u043F\u0440\u0430\u0432\u043B\u044F\u0442\u044C.",
      admin: "ID \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430",
      adminHelp: "\u0427\u0438\u0441\u043B\u043E\u0432\u043E\u0439 ID \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F Telegram. \u041F\u043E\u0441\u043B\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043F\u0440\u0435\u0436\u043D\u0438\u0439 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u043F\u043E\u0442\u0435\u0440\u044F\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F.",
      token: "\u0422\u043E\u043A\u0435\u043D \u0431\u043E\u0442\u0430",
      tokenSaved: "\u0422\u043E\u043A\u0435\u043D \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D \u2014 \u043E\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043F\u043E\u043B\u0435 \u043F\u0443\u0441\u0442\u044B\u043C, \u0447\u0442\u043E\u0431\u044B \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0435\u0433\u043E",
      tokenPlaceholder: "\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u0442\u043E\u043A\u0435\u043D \u043E\u0442 BotFather",
      tokenHelp: "\u0425\u0440\u0430\u043D\u0438\u0442\u0441\u044F \u0432 \u0443\u0447\u0451\u0442\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 DSH, \u0430 \u043D\u0435 \u0432 \u043A\u043E\u043D\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u0438 \u043F\u043B\u0430\u0433\u0438\u043D\u0430. \u0421\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u0442\u043E\u043A\u0435\u043D \u043D\u0435 \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u044D\u0442\u0443 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443.",
      loading: "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430\u2026",
      saving: "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435\u2026",
      save: "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C",
      copyDebugLog: "\u0421\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0436\u0443\u0440\u043D\u0430\u043B \u043E\u0442\u043B\u0430\u0434\u043A\u0438",
      debugCopying: "\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435\u2026",
      debugCopied: "\u0416\u0443\u0440\u043D\u0430\u043B \u043E\u0442\u043B\u0430\u0434\u043A\u0438 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D.",
      debugCopyError: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0436\u0443\u0440\u043D\u0430\u043B \u043E\u0442\u043B\u0430\u0434\u043A\u0438.",
      saved: "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E. ID \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430 \u043F\u0440\u0438\u043C\u0435\u043D\u044F\u0435\u0442\u0441\u044F \u0441\u0440\u0430\u0437\u0443; \u043D\u043E\u0432\u044B\u0439 \u0442\u043E\u043A\u0435\u043D \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u043C \u0437\u0430\u043F\u0440\u043E\u0441\u0435 API.",
      loadError: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438.",
      saveError: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438.",
      adminError: "ID \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u043E\u043B\u043E\u0436\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u043C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C.",
      tokenError: "\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0442\u043E\u043A\u0435\u043D Telegram-\u0431\u043E\u0442\u0430.",
      credentialError: "\u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u0443\u0447\u0451\u0442\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u043B\u043E \u0437\u0430\u043F\u0438\u0441\u044C \u0442\u043E\u043A\u0435\u043D\u0430.",
      rejected: "Harness \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u044D\u0442\u043E\u0442 \u0437\u0430\u043F\u0440\u043E\u0441 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043A.",
      ownerError: "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0434\u043E\u0441\u0442\u0443\u043F \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430.",
      methodError: "\u041C\u0435\u0442\u043E\u0434 \u043D\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043D.",
      jsonError: "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u0444\u043E\u0440\u043C\u0430\u0442 JSON.",
      sizeError: "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441."
    }
  };
  var normalizeLocale = (value) => {
    const base = typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : "";
    return base === "en" || base === "zh" || base === "ru" ? base : "en";
  };
  var errorKeys = {
    "Admin user ID must be a positive integer.": "adminError",
    "Enter a valid Telegram bot token.": "tokenError",
    "The credentials store did not confirm the token write.": "credentialError",
    "Harness rejected this settings request.": "rejected",
    "Owner access required": "ownerError",
    "Method not allowed": "methodError",
    "JSON required": "jsonError",
    "Request too large": "sizeError",
    "Unable to load settings": "loadError"
  };

  // src/client/settings.ts
  function applySettings(React, ctx) {
    const h = React.createElement;
    let locale = "en";
    function Settings() {
      const [language, setLanguage] = React.useState(locale), [admin, setAdmin] = React.useState(""), [token, setToken] = React.useState(""), [configured, setConfigured] = React.useState(false), [busy, setBusy] = React.useState(true), [saving, setSaving] = React.useState(false), [note, setNote] = React.useState(null), [copying, setCopying] = React.useState(false), [copyNote, setCopyNote] = React.useState(null);
      const text = messages[language];
      function acceptLocale(value) {
        locale = normalizeLocale(value.locale);
        setLanguage(locale);
      }
      async function call(body) {
        const response = await fetch("/telegram-console/settings", {
          credentials: "same-origin",
          cache: "no-store",
          ...body ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          } : {}
        });
        let value;
        try {
          value = await response.json();
        } catch {
          throw Error("");
        }
        if (!response.ok)
          throw Error(typeof value?.error === "string" ? value.error : "");
        return value;
      }
      function failure(error, kind) {
        const message = error.message;
        return {
          key: errorKeys[message] || kind,
          details: errorKeys[message] ? "" : message
        };
      }
      React.useEffect(() => {
        let live = true;
        call().then((value) => {
          if (live) {
            acceptLocale(value);
            setAdmin(String(value.adminUserId));
            setConfigured(value.tokenConfigured);
          }
        }).catch((error) => {
          if (live) setNote(failure(error, "loadError"));
        }).finally(() => {
          if (live) setBusy(false);
        });
        return () => {
          live = false;
        };
      }, []);
      async function save(event) {
        event.preventDefault();
        setBusy(true);
        setSaving(true);
        setNote(null);
        try {
          const value = await call({
            adminUserId: admin,
            ...token ? { botToken: token } : {}
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
            cache: "no-store"
          });
          if (!response.ok) throw Error("Debug export failed");
          const value = await response.json();
          if (!value || typeof value !== "object" || !("debugLog" in value) || typeof value.debugLog !== "string") {
            throw Error("Invalid debug export");
          }
          await navigator.clipboard.writeText(value.debugLog);
          setCopyNote("debugCopied");
        } catch {
          setCopyNote("debugCopyError");
        } finally {
          setCopying(false);
        }
      }
      const input = {
        width: "100%",
        boxSizing: "border-box",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit"
      };
      return h(
        "section",
        {
          style: {
            maxWidth: 600,
            padding: 24,
            color: "var(--dsw-alias-label-primary)"
          }
        },
        h("h2", null, text.title),
        h(
          "p",
          { style: { color: "var(--dsw-alias-label-secondary)" } },
          text.intro
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
            onChange: (e) => setAdmin(e.target.value),
            style: input
          }),
          h(
            "p",
            {
              style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" }
            },
            text.adminHelp
          ),
          h("label", { htmlFor: "telegram-token" }, text.token),
          h("input", {
            id: "telegram-token",
            type: "password",
            autoComplete: "new-password",
            value: token,
            disabled: busy,
            placeholder: configured ? text.tokenSaved : text.tokenPlaceholder,
            onChange: (e) => setToken(e.target.value),
            style: input
          }),
          h(
            "p",
            {
              style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" }
            },
            text.tokenHelp
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
                color: "var(--dsw-alias-label-primary-inverted)"
              }
            },
            busy ? saving ? text.saving : text.loading : text.save
          ),
          h(
            "p",
            { role: "status", "aria-live": "polite" },
            note ? text[note.key] + (note.details ? " " + note.details : "") : ""
          )
        ),
        h(
          "button",
          { type: "button", disabled: copying, onClick: copyDebugLog },
          copying ? text.debugCopying : text.copyDebugLog
        ),
        h(
          "p",
          { role: "status", "aria-live": "polite" },
          copyNote ? text[copyNote] : ""
        )
      );
    }
    ctx.slots.inject(
      "settings.section",
      () => ctx.slots.register(
        {
          name: "settings.section",
          id: "telegram-console",
          order: 35,
          label: () => messages[locale].title
        },
        Settings
      )
    );
  }

  // src/client/index.ts
  window.__ModuleLoader__.load({
    id: "dsh-telegram-remote",
    factory(require2) {
      const React = require2("react");
      return {
        inject: ["slots"],
        apply(ctx) {
          applySettings(React, ctx);
        }
      };
    }
  });
})();
