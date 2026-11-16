import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProtocolError } from "../protocol/json.js";

// This is an allowlist, not a secret-name denylist. In particular NODE_OPTIONS,
// NODE_PATH, loader/injection variables, proxies and credentials never survive.
const ENVIRONMENT_KEYS = [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const;

export function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  electron = typeof process.versions.electron === "string",
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  // fork uses the current executable. Desktop's executable is Electron, so its
  // Node mode must be selected explicitly rather than inherited from the Host.
  if (electron) environment.ELECTRON_RUN_AS_NODE = "1";
  return environment;
}

export interface LaunchOptions {
  entry: URL;
  generation: string;
  build: string;
  launch?: typeof fork;
}

export function launchChild(options: LaunchOptions): ChildProcess {
  if (
    options.entry.protocol !== "file:" ||
    options.entry.search ||
    options.entry.hash
  ) {
    throw new ProtocolError(
      "INVALID_ENTRY",
      "Worker entry must be an absolute file URL",
    );
  }
  const entry = fileURLToPath(options.entry);
  return (options.launch ?? fork)(
    entry,
    [
      `--telegram-generation=${options.generation}`,
      `--telegram-build=${options.build}`,
    ],
    {
      execPath: process.execPath,
      execArgv: [],
      env: childEnvironment(),
      serialization: "json",
      detached: false,
      // No inherited console or secret-bearing output. The sole IPC channel is
      // private to this owned parent/child pair; never unref either endpoint.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
}
