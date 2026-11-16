import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
if (output !== resolve(root, "dist") || dirname(output) !== root)
  throw Error("Unexpected build output");
// Only the verified generated directory is removed, never a user supplied path.
await rm(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    resolve(root, "tsconfig.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const clientCheck = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    resolve(root, "tsconfig.client.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
if (clientCheck.status !== 0) process.exit(clientCheck.status ?? 1);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/client/index.ts")],
  outfile: resolve(root, "client.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  legalComments: "none",
});
await writeFile(
  resolve(root, "index.js"),
  '// Generated package entry; implementation lives in TypeScript.\nexport { apply, inject } from "./dist/index.js";\n',
);
