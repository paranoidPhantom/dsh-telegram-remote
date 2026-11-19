import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_RECEIVED_BYTES = 10 * 1024 * 1024;
const DIRECTORY = ".dsh-telegram-remote";

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

/** Host-only persistence: untrusted names contribute only a short final extension.
 * Like Host lease files, identity checks detect directory/path replacement; native
 * Node path APIs cannot exclude every concurrent rename by a same-user attacker.
 */
export async function saveReceivedFile(
  cwd: string,
  name: string,
  content: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!(content instanceof Uint8Array))
    throw new TypeError("Received content must be a Uint8Array.");
  if (content.byteLength > MAX_RECEIVED_BYTES)
    throw new Error("Received file exceeds the 10 MiB limit.");
  const root = await realpath(cwd);
  signal?.throwIfAborted();
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory())
    throw new Error("Workspace must be a directory.");
  const directory = path.join(root, DIRECTORY);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(
      "Received file directory must be a real directory, not a symlink.",
    );

  async function checkDirectory(): Promise<void> {
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFile(current, directoryInfo) ||
      !sameFile(await lstat(root), rootInfo) ||
      (await realpath(directory)) !== directory ||
      !contained(root, directory)
    )
      throw new Error(
        "Received file directory changed or escaped the workspace.",
      );
  }

  await checkDirectory();
  signal?.throwIfAborted();
  // Treat both slash styles as separators; never retain any original basename.
  const basename = name.split(/[\\/]/).pop() ?? "";
  const extension =
    /\.([a-zA-Z0-9]{1,10})$/.exec(basename)?.[1]?.toLowerCase() ?? "bin";
  const target = path.join(directory, `${randomUUID()}.${extension}`);
  if (!contained(root, target) || path.dirname(target) !== directory)
    throw new Error("Received file must be inside the workspace.");
  const file = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let identity: Stats | undefined;
  let complete = false;
  try {
    identity = await file.stat();
    if (!identity.isFile() || identity.nlink !== 1)
      throw new Error("Received file must be a regular, exclusive file.");
    await checkDirectory();
    const before = await lstat(target);
    if (!before.isFile() || !sameFile(before, identity))
      throw new Error("Received file identity changed.");
    signal?.throwIfAborted();
    await file.writeFile(content, { signal });
    signal?.throwIfAborted();
    await checkDirectory();
    const after = await lstat(target);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      !sameFile(after, identity) ||
      after.size !== content.byteLength ||
      (await realpath(target)) !== target
    )
      throw new Error("Received file identity or contents changed.");
    await file.close();
    signal?.throwIfAborted();
    complete = true;
    return target;
  } finally {
    try {
      await file.close();
    } finally {
      if (!complete && identity) {
        // Never unlink a replacement file or follow a replacement directory.
        try {
          await checkDirectory();
          const current = await lstat(target);
          if (current.isFile() && sameFile(current, identity))
            await unlink(target);
        } catch {
          // A moved/replaced path is no longer ours to clean up safely.
        }
      }
    }
  }
}
