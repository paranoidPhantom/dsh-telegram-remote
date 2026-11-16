import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { projectRoot as root } from "./project-root.js";

type Child = Node | string | number | boolean | null | undefined | Child[];
interface Node {
  type: string;
  props: {
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onSubmit?: (event: { preventDefault(): void }) => Promise<void>;
    [key: string]: unknown;
  };
  children: Child[];
}
interface Registration {
  label(): string;
}
interface ClientPlugin {
  apply(ctx: {
    slots: {
      inject(name: string, register: () => void): void;
      register(options: Registration, render: () => Node): void;
    };
  }): void;
}
interface ClientModule {
  id: string;
  factory(require: (name: string) => unknown): ClientPlugin;
}

const source = await readFile(new URL("client.js", root), "utf8");
function harness(locale: string | undefined = "en") {
  const state: unknown[] = [];
  const effects: Array<() => () => void> = [];
  const requests: Array<{ url: string; options: RequestInit }> = [];
  let cursor = 0;
  let component: (() => Node) | undefined;
  let registration: Registration | undefined;
  let plugin: ClientPlugin | undefined;
  let cleanup: (() => void) | undefined;
  let response: { ok: boolean; value: unknown; invalid?: boolean } = {
    ok: true,
    value: { locale, adminUserId: 123, tokenConfigured: true },
  };
  const React = {
    createElement: (
      type: string,
      props: Node["props"] | null,
      ...children: Child[]
    ): Node => ({ type, props: props || {}, children }),
    useState: <T>(initial: T): [T, (value: T) => void] => {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      // This mock, like React, allocates one stable hook slot per render order.
      return [
        state[index] as T,
        (value: T) => {
          state[index] = value;
        },
      ];
    },
    useEffect: (effect: () => () => void) => {
      if (!effects.length) effects.push(effect);
    },
  };
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: (module: ClientModule) => {
          assert.equal(module.id, "dsh-telegram-remote");
          plugin = module.factory((name: string) => {
            assert.equal(name, "react");
            return React;
          });
        },
      },
    },
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return {
        ok: response.ok,
        json: async () => {
          if (response.invalid) throw Error("invalid JSON");
          return response.value;
        },
      };
    },
  });
  assert.equal(requests.length, 0, "factory must not request settings");
  assert.ok(plugin);
  // The classic script initializes the module synchronously through the loader.
  const loaded = plugin as ClientPlugin;
  loaded.apply({
    slots: {
      inject: (_name, register) => register(),
      register: (options, render) => {
        registration = options;
        component = render;
      },
    },
  });
  assert.equal(requests.length, 0, "apply must not request settings");
  return {
    requests,
    get registration() {
      assert.ok(registration);
      return registration;
    },
    render() {
      cursor = 0;
      assert.ok(component);
      return component();
    },
    async mount() {
      this.render();
      const effect = effects[0];
      assert.ok(effect);
      cleanup = effect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return this.render();
    },
    cleanup() {
      assert.ok(cleanup);
      cleanup();
    },
    respond(value: unknown, ok = true, invalid = false) {
      response = { value, ok, invalid };
    },
  };
}
function isNode(value: Child): value is Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function descendants(children: Child[]): Node[] {
  return children.flatMap((value) =>
    Array.isArray(value) ? descendants(value) : isNode(value) ? [value] : [],
  );
}
function elements(tree: Node, type: string): Node[] {
  return [
    tree,
    ...descendants(tree.children).flatMap((value) => elements(value, type)),
  ].filter((node) => node.type === type);
}
function text(tree: Node): string {
  const flatten = (values: Child[]): string[] =>
    values.flatMap((value) =>
      Array.isArray(value)
        ? flatten(value)
        : [isNode(value) ? text(value) : String(value ?? "")],
    );
  return flatten(tree.children).join(" ");
}
function element(tree: Node, type: string, index = 0): Node {
  const found = elements(tree, type)[index];
  assert.ok(found);
  return found;
}
function change(node: Node, value: string) {
  assert.ok(node.props.onChange);
  node.props.onChange({ target: { value } });
}
async function submit(tree: Node) {
  const form = element(tree, "form");
  assert.ok(form.props.onSubmit);
  await form.props.onSubmit({ preventDefault() {} });
}

test("READMEs cross-link all languages and retain the same minimal installation outline", async () => {
  for (const name of ["README.md", "README.zh-CN.md", "README.ru.md"]) {
    const value = await readFile(new URL(name, root), "utf8");
    for (const link of ["README.md", "README.zh-CN.md", "README.ru.md"])
      assert.ok(value.includes(`](${link})`));
    assert.equal((value.match(/^- /gm) || []).length, 4);
    assert.equal((value.match(/^\d\. /gm) || []).length, 5);
    for (const token of [
      "dsh-telegram-remote",
      "/start",
      "/sessions",
      "@BotFather",
    ])
      assert.ok(value.includes(token));
  }
});
test("metadata locales have identical keys and localized names", async () => {
  for (const lang of ["en", "zh", "ru"]) {
    const value = JSON.parse(
      await readFile(new URL(`locale/${lang}.json`, root), "utf8"),
    ) as { meta: { title: string; description: string } };
    assert.deepEqual(Object.keys(value.meta).sort(), ["description", "title"]);
    assert.ok(value.meta.title && value.meta.description);
  }
});
test("settings language comes from Host locale with regional normalization and English fallback", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["zh-CN", "Telegram 远程控制"],
    ["RU_ru", "Удалённый доступ через Telegram"],
    ["fr", "Telegram Remote"],
    [undefined, "Telegram Remote"],
  ];
  for (const [locale, title] of cases) {
    const app = harness(locale);
    const tree = await app.mount();
    assert.equal(element(tree, "h2").children[0], title);
    assert.equal(app.registration.label(), title);
    assert.equal(app.requests.length, 1);
    assert.equal(
      element(tree, "input", 1).props.value,
      "",
      "saved credentials must never populate the password",
    );
    app.cleanup();
  }
  assert.ok(!source.includes("navigator"));
});
test("localized errors preserve unsaved token; successful save clears it", async () => {
  const app = harness("zh");
  let tree = await app.mount();
  change(element(tree, "input", 1), "unsaved-token");
  tree = app.render();
  app.respond({ error: "Enter a valid Telegram bot token." }, false);
  await submit(tree);
  tree = app.render();
  assert.ok(text(tree).includes("请输入有效的 Telegram 机器人令牌。"));
  assert.equal(element(tree, "input", 1).props.value, "unsaved-token");
  const request = app.requests[1];
  assert.ok(request);
  const body = request.options.body;
  assert.equal(typeof body, "string");
  assert.equal(
    (JSON.parse(body as string) as { botToken: string }).botToken,
    "unsaved-token",
  );
  app.respond({ locale: "ru", adminUserId: 123, tokenConfigured: true });
  await submit(tree);
  tree = app.render();
  assert.equal(element(tree, "input", 1).props.value, "");
  assert.ok(text(tree).includes("Сохранено."));
});
test("empty rejection and unexpected backend errors get localized generic messages", async () => {
  const app = harness("ru");
  let tree = await app.mount();
  app.respond(null, false, true);
  await submit(tree);
  tree = app.render();
  assert.ok(text(tree).includes("Не удалось сохранить настройки."));
  app.respond({ error: "Backend detail" }, false);
  await submit(tree);
  tree = app.render();
  assert.ok(
    text(tree).includes("Не удалось сохранить настройки. Backend detail"),
  );
});
