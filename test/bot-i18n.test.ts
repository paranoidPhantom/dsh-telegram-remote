import { inlineMarkup, requiredField } from "./console-param-checks.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLocale,
  createTranslator,
  dictionaries,
} from "../src/i18n/bot-i18n.js";
import { FixtureConsole as TelegramConsole } from "./console-constructor.js";
import type {
  TelegramMethod,
  TelegramParams,
  ConsoleDocument,
} from "../src/bot/contracts.js";

import {
  required,
  type ApiParams,
  type Bridge,
  type State,
} from "./console-fixture-types.js";

interface LocaleCall {
  method: string;
  params?: ApiParams;
  args?: [string, string, string];
}
function fixture(locale = "en") {
  const calls: LocaleCall[] = [],
    data = new Map<string, State>();
  let currentLocale = locale,
    nextId = 0;
  const metadata = {
    id: "s1",
    title: "Model answer title",
    model: "provider/model",
    selection: { provider: "provider-id", model: "model-id" },
    cwd: "/work/Model",
    running: false,
  };
  const bridge: Bridge = {
    async list() {
      return [metadata];
    },
    async metadata() {
      return metadata;
    },
    async models() {
      return [
        {
          provider: "provider-id",
          id: "model-id",
          name: "Model",
          description: "Model payload untouched",
        },
      ];
    },
    async newSessionSelection() {
      return { provider: "provider-id", model: "model-id" };
    },
    async prompt(...args) {
      calls.push({ method: "prompt", args });
    },
  };
  const c = new TelegramConsole({
    signal: undefined,
    ownerId: 1,
    getLocale: () => currentLocale,
    bridge,
    api: {
      async call(method: TelegramMethod, params: TelegramParams = {}) {
        calls.push({ method, params: params });
        return method === "sendMessage" ? { message_id: ++nextId } : true;
      },
    },
    store: {
      async get(key: string) {
        return data.get(key);
      },
      async set(key: string, value: State) {
        data.set(key, structuredClone(value));
      },
      async entries() {
        return [...data];
      },
    },
  });
  const ctx = { chatId: 1, threadId: 2 };
  const message = (text: string) => ({
    message: {
      message_id: ++nextId,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      message_thread_id: 2,
      text,
    },
  });
  const callback = (data: string) => ({
    callback_query: {
      id: "query",
      from: { id: 1 },
      data,
      message: {
        message_id: ++nextId,
        chat: { id: 1, type: "private" },
        message_thread_id: 2,
      },
    },
  });
  return {
    c,
    ctx,
    bridge,
    calls,
    message,
    callback,
    setLocale(value: string) {
      currentLocale = value;
    },
    lastSend() {
      return required(
        required(calls.filter((x) => x.method === "sendMessage").at(-1)).params,
      );
    },
  };
}

test("normalizes supported language tags and safely falls back to English", () => {
  for (const [tag, locale] of [
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["ru-RU", "ru"],
    ["RU_ru", "ru"],
    ["en-US", "en"],
    ["fr-FR", "en"],
    ["", "en"],
    [undefined, "en"],
    [42, "en"],
  ])
    assert.equal(normalizeLocale(tag), locale);
  assert.equal(createTranslator(() => "unsupported")("model"), "Model");
  assert.equal(createTranslator()("model"), "Model");
  assert.equal(createTranslator()("missing.key"), "missing.key");
});

test("dictionaries have full key and interpolation parity for all languages", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const locale of ["zh", "ru"] as const) {
    assert.deepEqual(
      Object.keys(dictionaries[locale]!).sort(),
      Object.keys(dictionaries.en!).sort(),
    );
    for (const key of Object.keys(dictionaries.en!)) {
      assert.equal(
        typeof dictionaries[locale]![key]!,
        "string",
        `${locale}.${key}`,
      );
      assert.ok(dictionaries[locale]![key]!.length, `${locale}.${key}`);
      assert.deepEqual(
        placeholders(dictionaries[locale]![key]!),
        placeholders(dictionaries.en![key]!),
        `${locale}.${key}`,
      );
    }
  }
});

test("translator switches dynamically and interpolation preserves raw payloads", () => {
  let locale = "en";
  const t = createTranslator(() => locale);
  assert.equal(t("model"), "Model");
  locale = "zh-CN";
  assert.equal(t("model"), "模型");
  locale = "ru-RU";
  assert.equal(t("model"), "Модель");
  const raw = "backend: Model /private/模型 {page} $&";
  assert.equal(
    t("modelUnchanged", { error: raw }),
    `⚠ Модель не изменена: ${raw}`,
  );
  assert.equal(
    t("modelsPage", { provider: "provider-id", page: 3 }),
    "provider-id · страница 3",
  );
});

test("console changes help and menus without recreation; semantic Model button callbacks work", async (t) => {
  const f = fixture();
  t.after(() => f.c.close());
  await f.c.handleUpdate(f.message("/help"));
  assert.match(requiredField(f.lastSend().text), /open a live DSH session/);
  for (const [locale, model, providerHeading] of [
    ["zh-CN", "模型", "选择提供商"],
    ["ru-RU", "Модель", "Выберите провайдера"],
  ] as const) {
    f.setLocale(locale);
    const toolbar = f.c.controls("s1", f.ctx);
    const button = toolbar.inline_keyboard
      .flat()
      .find((b) => b.text === model)!;
    assert.equal(button.style, "primary");
    assert.ok(button.icon_custom_emoji_id);
    await f.c.handleUpdate(f.callback(required(button.callback_data)));
    assert.ok(requiredField(f.lastSend().text).startsWith(providerHeading));
    const provider = inlineMarkup(f.lastSend().reply_markup)
      .inline_keyboard.flat()
      .find((b) => b.text.includes("provider-id"))!;
    await f.c.handleUpdate(f.callback(requiredField(provider.callback_data)));
    const picker = f.calls
      .filter((x) => x.method === "editMessageText")
      .at(-1)!.params!;
    assert.match(requiredField(picker.text), /Model payload untouched/);
    const back = inlineMarkup(picker.reply_markup)
      .inline_keyboard.flat()
      .find(
        (b) =>
          f.c.actions.get(requiredField(b.callback_data))?.type === "providers",
      )!;
    assert.equal(
      back.style,
      undefined,
      "picker navigation is not the initial model toolbar",
    );
    await f.c.handleUpdate(f.message("/help"));
    assert.ok(
      !requiredField(f.lastSend().text).includes("open a live DSH session"),
    );
  }
});

test("new confirmation, queue and expiry are localized while model IDs and backend errors stay raw", async (t) => {
  const f = fixture("ru");
  t.after(() => f.c.close());
  await f.c.requestNew(f.ctx);
  assert.match(
    requiredField(f.lastSend().text),
    /Создать сессию DSH с provider-id \/ model-id/,
  );
  const button = inlineMarkup(f.lastSend().reply_markup)
    .inline_keyboard[0]![0]!;
  required(f.c.actions.get(requiredField(button.callback_data))).expires = 0;
  await f.c.handleUpdate(f.callback(required(button.callback_data)));
  assert.match(
    requiredField(
      f.calls.filter((x) => x.method === "editMessageText").at(-1)!.params!
        .text,
    ),
    /Подтверждение устарело/,
  );
  await f.c.save("s1", f.ctx);
  f.bridge.metadata = async () => ({ running: true });
  await f.c.handleUpdate(f.message("Model answer should not translate"));
  assert.match(requiredField(f.lastSend().text), /Добавлено в очередь DSH/);
  assert.equal(
    f.calls.find((x) => x.method === "prompt")!.args![1],
    "Model answer should not translate",
  );
  const error = "backend ERROR /work/Model provider-id";
  f.bridge.prompt = async () => {
    throw new Error(error);
  };
  await f.c.handleUpdate(f.message("another prompt"));
  assert.equal(requiredField(f.lastSend().text), `⚠ ${error}`);
});

test("assistant answers are delivered without translation", async (t) => {
  const f = fixture("zh");
  t.after(() => f.c.close());
  await f.c.save("s1", f.ctx);
  const answer = "Model Details Idle — 原始回答 Ответ модели";
  await f.c.onRun("s1", { turn: 1, final: true, status: "completed", answer });
  assert.ok(
    f.calls.some(
      (x) =>
        x.method === "sendMessage" &&
        requiredField(x.params!.text).includes(answer),
    ),
    "answer text is unchanged",
  );
});
