import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileWidget } from "../src/widgets/compiler.js";
import {
  isPublicIP,
  validateResourceURL,
  safeFetch,
} from "../src/telegram/safe-fetch.js";

const rootDir = process.cwd();
type ResourceEntry = [mime: string, body: string];
const fixture =
  (entries: Record<string, ResourceEntry>, seen: string[] = []) =>
  async (url: string) => {
    seen.push(url);
    if (!(url in entries)) throw new Error(`fixture 404: ${url}`);
    const entry = entries[url];
    assert.ok(entry);
    const [mime, body] = entry;
    return { mime, body: Buffer.from(body), url };
  };
test("deterministic HTML/CSS resource parsing, imports, srcset and inline CSS", async () => {
  const seen: string[] = [];
  const options = {
    rootDir,
    html: `<link rel=stylesheet href="https://assets.example/main.css"><script src="https://assets.example/app.js"></script><img srcset="https://assets.example/a.png 1x, https://assets.example/b.png 2x"><p style="background:url(https://assets.example/a.png)">ok</p>`,
    fetchResource: fixture(
      {
        "https://assets.example/main.css": [
          "text/css",
          '@charset "latin1"; @import "sub.css" screen; p{background:url(a.png)}',
        ],
        "https://assets.example/sub.css": ["text/css", "p { color:red }"],
        "https://assets.example/app.js": ["text/javascript", "window.ready=1"],
        "https://assets.example/a.png": ["image/png", "aaa"],
        "https://assets.example/b.png": ["image/png", "bbb"],
      },
      seen,
    ),
  };
  const first = await compileWidget(options);
  const second = await compileWidget(options);
  assert.equal(first.html, second.html);
  assert.equal(first.hash, second.hash);
  assert.match(first.html, /@media screen/);
  assert.match(first.html, /data:image\/png;base64/);
  assert.doesNotMatch(first.html, /https?:\/\//);
  assert.doesNotMatch(first.html, /@charset/);
  assert.equal(seen.filter((x) => x.endsWith("/a.png")).length, 2);
});
test("required stylesheet/script failure never silently omits", async () => {
  for (const html of [
    '<link rel=stylesheet href="https://a.example/no.css">',
    '<script src="https://a.example/no.js"></script>',
  ])
    await assert.rejects(
      compileWidget({ rootDir, html, fetchResource: fixture({}) }),
      /fixture 404/,
    );
});
test("optional failures warn and remove runtime resource attribute", async () => {
  const r = await compileWidget({
    rootDir,
    html: '<img src="http://127.0.0.1/private"><img src="https://a.example/x.png">',
    fetchResource: fixture({}),
  });
  assert.equal(r.warnings.length, 2);
  assert.doesNotMatch(r.html, /src=/);
});
test("reject original 40KB even if compressible", async () => {
  await assert.rejects(
    compileWidget({ rootDir, html: "x".repeat(40000) }),
    /Original HTML exceeds/,
  );
});
test("modules bundle using guarded resolver; bare and dynamic modules fail precisely", async () => {
  const r = await compileWidget({
    rootDir,
    html: '<script type=module>import {value} from "https://a.example/a.js"; window.result=value; fetch("/no")</script>',
    fetchResource: fixture({
      "https://a.example/a.js": ["text/javascript", "export const value=42"],
    }),
  });
  assert.match(r.html, /42/);
  assert.doesNotMatch(r.html, /https:\/\/a.example/);
  assert.ok(r.warnings.length);
  await assert.rejects(
    compileWidget({
      rootDir,
      html: '<script type=module>import "not-a-package"</script>',
    }),
    /Unresolved bare module/,
  );
  await assert.rejects(
    compileWidget({
      rootDir,
      html: "<script type=module>window.go=(url)=>import(url)</script>",
    }),
    /Unresolved/,
  );
  await assert.rejects(
    compileWidget({ rootDir, html: "<script type=importmap>{}</script>" }),
    /Import maps unsupported/,
  );
});
test("local realpath containment, relative files, symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "widget-test-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "image.png"), "image");
  await writeFile(path.join(root, "outside.css"), "body{}");
  await symlink(
    path.join(root, "outside.css"),
    path.join(root, "src", "escape.css"),
  );
  const r = await compileWidget({
    rootDir: path.join(root, "src"),
    filePath: path.join(root, "src", "telegram_widget_a.html"),
    html: "<img src=image.png>",
  });
  assert.match(r.html, /data:image\/png/);
  await assert.rejects(
    compileWidget({
      rootDir: path.join(root, "src"),
      filePath: path.join(root, "src", "widget.html"),
      html: "<link rel=stylesheet href=escape.css>",
    }),
    /escapes source workspace root/,
  );
});
test("fonts before images budget trimming, required JS retained", async () => {
  const random = Array.from({ length: 12000 }, (_, i) =>
    String.fromCharCode(33 + ((i * i * 13 + i * 17) % 90)),
  ).join("");
  const r = await compileWidget({
    rootDir,
    html: "<style>@font-face{font-family:a;src:url(https://a.example/font.woff2)}p{background:url(https://a.example/a.png)}</style><script>window.essential=true</script>",
    limits: { maxRawBytes: 1500 },
    fetchResource: fixture({
      "https://a.example/font.woff2": ["font/woff2", random],
      "https://a.example/a.png": ["image/png", random],
    }),
  });
  assert.ok(r.rawBytes <= 1500);
  assert.match(r.html, /essential/);
  assert.ok(r.warnings[0]);
  assert.ok(r.warnings[1]);
  assert.match(r.warnings[0], /font/);
  assert.match(r.warnings[1], /image/);
});
test("required code budget cannot be fixed by dropping external JS", async () => {
  await assert.rejects(
    compileWidget({
      rootDir,
      html: '<script src="https://a.example/big.js"></script>',
      limits: { maxRawBytes: 150 },
      fetchResource: fixture({
        "https://a.example/big.js": [
          "text/javascript",
          `window.value=${JSON.stringify("a".repeat(500))}`,
        ],
      }),
    }),
    /required CSS\/JS cannot be omitted/,
  );
});
test("wrong required MIME fails; unsafe optional MIME omitted", async () => {
  await assert.rejects(
    compileWidget({
      rootDir,
      html: '<script src="https://a.example/no.js"></script>',
      fetchResource: fixture({
        "https://a.example/no.js": ["text/html", "<html>oops"],
      }),
    }),
    /incorrect js MIME/,
  );
  const r = await compileWidget({
    rootDir,
    html: '<img src="https://a.example/x.png">',
    fetchResource: fixture({
      "https://a.example/x.png": ["text/html", "oops"],
    }),
  });
  assert.equal(r.warnings.length, 1);
  assert.doesNotMatch(r.html, /src=/);
});
test("CSS import cycles and malformed CSS reject", async () => {
  await assert.rejects(
    compileWidget({
      rootDir,
      html: '<link rel=stylesheet href="https://a.example/a.css">',
      fetchResource: fixture({
        "https://a.example/a.css": ["text/css", '@import "a.css";'],
      }),
    }),
    /cycle/,
  );
  await assert.rejects(
    compileWidget({ rootDir, html: "<style>p{</style>" }),
    /Unclosed block/,
  );
});
test("public-only IP and URL checks need no public requests", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicIP(ip), false, ip);
  assert.equal(isPublicIP("8.8.8.8"), true);
  for (const url of [
    "https://127.0.0.1/a",
    "http://[::1]/",
    "https://a.example:444/",
    "https://user:pass@a.example/",
  ])
    assert.throws(() => validateResourceURL(url));
  await assert.rejects(safeFetch("http://169.254.169.254/latest"), /SSRF/);
});
test("SVG images inline markup and recursively resolve nested image assets", async () => {
  const r = await compileWidget({
    rootDir,
    html: '<img src="https://a.example/icon.svg" alt="icon">',
    fetchResource: fixture({
      "https://a.example/icon.svg": [
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="small.png" /></svg>',
      ],
      "https://a.example/small.png": ["image/png", "small"],
    }),
  });
  assert.match(r.html, /<svg/);
  assert.match(r.html, /aria-label="icon"/);
  assert.match(r.html, /data:image\/png;base64/);
  assert.doesNotMatch(r.html, /__DSH_WIDGET/);
});
test("compile has a bounded timeout even with an uncooperative injected fetcher", async () => {
  await assert.rejects(
    compileWidget({
      rootDir,
      html: '<script src="https://a.example/x.js"></script>',
      limits: { timeoutMs: 20 },
      fetchResource: () => new Promise(() => {}),
    }),
    /time budget/,
  );
});
