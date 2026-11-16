import { spawnSync } from "node:child_process";
import { rm, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = process.argv[2] ?? "unit";
if (suite !== "unit" && suite !== "isolation")
  throw Error("Unknown test suite");
const buildOnly = process.argv.includes("--build-only");
const output = resolve(root, ".build", suite);
if (
  dirname(output) !== resolve(root, ".build") ||
  !["unit", "isolation"].includes(suite)
)
  throw Error("Unexpected test output");
// A compiler does not remove stale output for renamed tests. Delete only this
// verified suite-owned generated directory before every build.
await rm(output, { recursive: true, force: true });
const config =
  suite === "unit" ? "tsconfig.test.json" : "tsconfig.isolation.json";
const compile = spawnSync(
  process.execPath,
  [resolve(root, "node_modules/typescript/bin/tsc"), "--project", config],
  { cwd: root, stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);
if (!buildOnly) {
  const directory = resolve(
    output,
    "test",
    ...(suite === "isolation" ? ["isolation"] : []),
  );
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => resolve(directory, name));
  if (!files.length) throw Error("No compiled tests found");
  const tests = spawnSync(
    process.execPath,
    ["--test", "--test-timeout=15000", ...files],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(tests.status ?? 1);
}
