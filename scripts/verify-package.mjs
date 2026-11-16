import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${program} failed (${result.status}): ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout;
}

/** Reject traversal, private/generated inputs and all legacy root implementations. */
export function validateArchivePaths(entries) {
  const seen = new Set();
  for (const entry of entries) {
    assert(
      entry.startsWith("package/") && !entry.includes("\\"),
      `Unsafe archive path: ${entry}`,
    );
    const name = entry.slice("package/".length).replace(/\/$/, "");
    if (!name) continue;
    const parts = name.split("/");
    assert(
      parts.every((part) => part && part !== "." && part !== ".."),
      `Unsafe archive path: ${entry}`,
    );
    assert(!seen.has(name), `Duplicate archive path: ${entry}`);
    seen.add(name);
    assert(
      !parts.some(
        (part) =>
          /^(?:src|test|tests|node_modules|\.cache|cache|\.git|\.build|logs?|credentials?)$/i.test(
            part,
          ) ||
          /^\.env(?:\.|$)/i.test(part) ||
          /credentials|\.log$|\.tgz$|\.tar(?:\.gz)?$|^\.runtime-status/i.test(
            part,
          ),
      ),
      `Private or generated archive input: ${entry}`,
    );
    const allowedRoot =
      /^(?:index\.js|client\.js|package\.json|cordis\.patch\.yml|icon\.svg|README(?:\.[\w-]+)?\.md|WIDGETS\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/;
    assert(
      (parts[0] === "dist" &&
        (name.endsWith(".js") || name.endsWith(".d.ts"))) ||
        (parts[0] === "locale" &&
          parts.length === 2 &&
          name.endsWith(".json")) ||
        (parts.length === 1 && allowedRoot.test(name)),
      `Unexpected/legacy implementation: ${entry}`,
    );
  }
  return seen;
}

/** Match literal credentials, not source regex descriptions such as \\d{8,}. */
export function assertSafeText(text, name) {
  assert(
    !/(?:\/Users\/|\/home\/)[A-Za-z0-9_.-]+(?:\/|\b)|[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9_.-]+/i.test(
      text,
    ),
    `Personal absolute home path in ${name}`,
  );
  assert(
    !/(?<![\w-])\d{6,12}:[A-Za-z0-9_-]{30,50}(?![\w-])/.test(text),
    `Possible Telegram bot credential in ${name}`,
  );
}

async function verifiedDirectory(parent, name) {
  const target = resolve(parent, name);
  assert.equal(dirname(target), parent);
  try {
    const info = await lstat(target);
    assert(
      info.isDirectory() && !info.isSymbolicLink(),
      `Refusing non-directory/symlink: ${target}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(target);
  }
  assert.equal(
    await realpath(target),
    target,
    `Refusing redirected directory: ${target}`,
  );
  return target;
}

function verifyClient(source) {
  let registration;
  let networkCalls = 0;
  const denyNetwork = () => {
    networkCalls++;
    throw new Error("Client performed HTTP before mounting Settings");
  };
  runInNewContext(
    source,
    {
      window: {
        __ModuleLoader__: {
          load(value) {
            assert.equal(registration, undefined);
            registration = value;
          },
        },
      },
      fetch: denyNetwork,
      XMLHttpRequest: denyNetwork,
      WebSocket: denyNetwork,
    },
    { timeout: 1000 },
  );
  assert.equal(registration?.id, "dsh-telegram-remote");
  const plugin = registration.factory((name) => {
    assert.equal(name, "react");
    return {
      createElement() {
        throw new Error("Settings rendered during registration");
      },
    };
  });
  assert.deepEqual(Array.from(plugin.inject), ["slots"]);
  let injected = 0;
  let registered = 0;
  plugin.apply({
    slots: {
      inject(name, register) {
        assert.equal(name, "settings.section");
        injected++;
        register();
      },
      register(section, component) {
        assert.equal(section.id, "telegram-console");
        assert.equal(typeof section.label(), "string");
        assert.equal(typeof component, "function");
        registered++;
      },
    },
  });
  assert.equal(injected, 1);
  assert.equal(registered, 1);
  assert.equal(networkCalls, 0);
}

export async function verifyPackage() {
  // Keep extraction nested below the repository so ordinary Node resolution can
  // use its existing node_modules. No install, symlink or NODE_PATH is needed.
  const canonicalRoot = await realpath(root);
  const cache = await verifiedDirectory(canonicalRoot, ".cache");
  const check = await verifiedDirectory(cache, "package-check");
  const npmCache = await verifiedDirectory(check, "npm-cache");
  const unpacked = await verifiedDirectory(check, "unpacked");
  // Verify the exact fixed target and all ancestors immediately before removal.
  assert.equal(
    unpacked,
    resolve(canonicalRoot, ".cache/package-check/unpacked"),
  );
  assert.equal(await realpath(unpacked), unpacked);
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked);
  const packed = JSON.parse(
    command("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--offline",
      "--cache",
      npmCache,
      "--pack-destination",
      check,
    ]),
  );
  assert.equal(packed.length, 1);
  const filename = packed[0].filename;
  assert.equal(typeof filename, "string");
  assert.equal(basename(filename), filename);
  assert(filename.endsWith(".tgz"));
  const archive = resolve(check, filename);
  assert.equal(dirname(archive), check);
  const entries = command("tar", ["-tzf", archive]).trim().split("\n");
  const files = validateArchivePaths(entries);
  // Disallow links/devices before extraction; path checks alone do not prevent
  // archive symlink attacks. npm produces only regular files here.
  const listing = command("tar", ["-tvzf", archive]).trim().split("\n");
  assert(
    listing.every((line) => line.startsWith("-")),
    "Archive contains a link or non-regular entry",
  );
  command("tar", ["-xzf", archive, "-C", unpacked]);
  const packageRoot = resolve(unpacked, "package");
  const required = [
    "index.js",
    "client.js",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/child/index.js",
    "dist/child/index.d.ts",
    "dist/host/supervisor.js",
    "package.json",
    "cordis.patch.yml",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "README.zh-CN.md",
    "README.ru.md",
    "locale/en.json",
    "locale/zh.json",
    "locale/ru.json",
    "icon.svg",
  ];
  for (const name of required)
    assert(files.has(name), `Missing package resource: ${name}`);
  for (const name of files) {
    const full = resolve(packageRoot, name);
    assert.equal(await realpath(full), full);
    assert((await lstat(full)).isFile());
    const text = await readFile(full, "utf8");
    assertSafeText(text, name);
    if (name.endsWith(".d.ts")) {
      // Includes imports, re-exports, import() types and triple-slash references.
      const imports = [
        ...text.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\breference\s+path=)["']([^"']+)["']/g,
        ),
      ];
      for (const [, specifier] of imports) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(full), specifier);
        const rel = relative(packageRoot, target);
        assert(
          !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`),
          `Declaration escapes package: ${name}`,
        );
        const declaration = target.endsWith(".js")
          ? target.slice(0, -3) + ".d.ts"
          : target;
        assert(
          files.has(relative(packageRoot, declaration).split(sep).join("/")),
          `Missing declaration import ${specifier} in ${name}`,
        );
      }
    }
  }
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "dsh-telegram-remote");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["."].default, "./index.js");
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  function validateExports(value) {
    if (typeof value === "string") {
      assert(value.startsWith("./"), `Non-local package export: ${value}`);
      const pattern = value.slice(2);
      assert(
        !pattern.split("/").includes(".."),
        `Escaping package export: ${value}`,
      );
      if (pattern.includes("*")) {
        const expression = new RegExp(
          "^" +
            pattern
              .split("*")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".*") +
            "$",
        );
        assert(
          [...files].some((name) => expression.test(name)),
          `Empty package export: ${value}`,
        );
      } else assert(files.has(pattern), `Missing package export: ${value}`);
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) validateExports(item);
    } else assert.equal(value, null, "Invalid package export");
  }
  validateExports(manifest.exports);
  const entry = await readFile(resolve(packageRoot, "index.js"), "utf8");
  assert(
    entry.length < 512 &&
      /export\s*\{\s*apply,\s*inject\s*\}\s*from\s*["']\.\/dist\/index\.js["']/.test(
        entry,
      ),
    "Root Host entry must only forward to compiled implementation",
  );
  const patch = await readFile(
    resolve(packageRoot, "cordis.patch.yml"),
    "utf8",
  );
  assert(/name:\s*['"]?dsh-telegram-remote['"]?\s*$/m.test(patch));
  assert.equal([...patch.matchAll(/^\s*ownerId:\s*(.*?)\s*$/gm)].length, 1);
  assert(/^\s*ownerId:\s*0\s*$/m.test(patch), "Shipped patch is not locked");
  assert(!/^\s*(?:botToken|token|statusPath):/m.test(patch));
  assert(
    (await readFile(resolve(packageRoot, "LICENSE"), "utf8")).includes(
      "MIT License",
    ),
  );
  assert(
    (
      await readFile(resolve(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf8")
    ).trim().length > 0,
  );
  for (const locale of ["en", "zh", "ru"]) {
    const metadata = JSON.parse(
      await readFile(resolve(packageRoot, `locale/${locale}.json`), "utf8"),
    );
    assert.equal(typeof metadata.meta.title, "string");
    assert(metadata.meta.title.trim().length > 0);
    assert.equal(typeof metadata.meta.description, "string");
    assert(metadata.meta.description.trim().length > 0);
  }
  for (const name of ["README.md", "README.zh-CN.md", "README.ru.md"]) {
    assert(
      (await readFile(resolve(packageRoot, name), "utf8")).includes(
        "dsh-telegram-remote",
      ),
      `README missing package identity: ${name}`,
    );
  }
  const host = await import(
    pathToFileURL(resolve(packageRoot, "index.js")).href
  );
  assert.equal(typeof host.apply, "function");
  assert(Array.isArray(host.inject));
  verifyClient(await readFile(resolve(packageRoot, "client.js"), "utf8"));
  const { ChildSupervisor } = await import(
    pathToFileURL(resolve(packageRoot, "dist/host/supervisor.js")).href
  );
  const supervisor = new ChildSupervisor({
    entry: pathToFileURL(resolve(packageRoot, "dist/child/index.js")),
    build: manifest.version,
    maxRestarts: 0,
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 3000,
  });
  try {
    // Handshake only: deliberately never send runtime.initialize or credentials.
    await supervisor.start();
    assert.equal(supervisor.state, "running");
    assert(
      Number.isSafeInteger(supervisor.pid) && supervisor.pid !== process.pid,
    );
  } finally {
    await supervisor.close();
  }
  assert.equal(supervisor.state, "closed");
  assert.equal(supervisor.pid, undefined);
  console.log(
    `Verified ${filename}: ${files.size} archived files; extracted Host import, child handshake/shutdown, declarations and Client registration passed (no Telegram initialization).`,
  );
  return { archive, files: files.size };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await verifyPackage();
}
