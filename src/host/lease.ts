import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ProtocolError } from "../protocol/json.js";

interface LeaseRecord {
  pid: number;
  generation: string;
  nonce: string;
}
interface OwnedFile {
  identity: LeaseRecord;
  inode: number;
  device: number;
}
/** Windows mode/uid are synthetic, not ACLs. POSIX checks apply only on POSIX.
 * Windows access is enforced by the inherited ACL of the user's temp directory;
 * exclusive creation and owner identity checks remain mandatory on all platforms.
 */
export function leasePermissionsValid(
  info: { mode: number; uid: number },
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = typeof process.getuid === "function"
    ? process.getuid()
    : undefined,
): boolean {
  return (
    platform === "win32" ||
    ((info.mode & 0o077) === 0 && (uid === undefined || info.uid === uid))
  );
}

function record(value: unknown): value is LeaseRecord {
  if (!value || typeof value !== "object") return false;
  return (
    "pid" in value &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    "generation" in value &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    "nonce" in value &&
    typeof value.nonce === "string" &&
    value.nonce.length > 0
  );
}
function code(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}
function ambiguous(path: string): ProtocolError {
  return new ProtocolError(
    "LEASE_ACTIVE",
    `Bot lease ownership is ambiguous at ${path}; inspect and manually remove the file only after confirming no activation owns it`,
  );
}
function same(left: OwnedFile, right: OwnedFile): boolean {
  return (
    left.inode === right.inode &&
    left.device === right.device &&
    left.identity.nonce === right.identity.nonce &&
    left.identity.pid === right.identity.pid &&
    left.identity.generation === right.identity.generation
  );
}
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return code(error) === "ESRCH";
  }
}

async function inspect(path: string): Promise<OwnedFile> {
  try {
    // Read metadata and bytes from the same no-follow descriptor. Never read a
    // symlink target, device or FIFO, or accept a hardlink into another file.
    // O_NOFOLLOW is not available on every Windows runtime. Reject links before
    // opening and compare the opened descriptor with the pathname afterwards.
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw ambiguous(path);
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        !leasePermissionsValid(info) ||
        info.ino !== before.ino ||
        info.dev !== before.dev
      )
        throw ambiguous(path);
      const current = await lstat(path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== info.ino ||
        current.dev !== info.dev
      )
        throw ambiguous(path);
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!record(value)) throw ambiguous(path);
      return { identity: value, inode: info.ino, device: info.dev };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (code(error) === "ENOENT") throw error;
    throw ambiguous(path);
  }
}

async function create(path: string, identity: LeaseRecord): Promise<OwnedFile> {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(identity));
    await file.sync();
    const info = await file.stat();
    return { identity, inode: info.ino, device: info.dev };
  } finally {
    await file.close();
  }
}

async function removeOwned(path: string, owner: OwnedFile): Promise<boolean> {
  try {
    if (!same(owner, await inspect(path))) return false;
    // Validate the name again after reading the owner bytes; a replacement
    // inode must not be removed by a delayed close or stale reclaimer.
    const current = await lstat(path);
    if (
      current.ino !== owner.inode ||
      current.dev !== owner.device ||
      !current.isFile()
    )
      return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function recoveryLock(
  path: string,
  identity: LeaseRecord,
): Promise<OwnedFile> {
  try {
    return await create(path, identity);
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  const previous = await inspect(path);
  if (!dead(previous.identity.pid))
    throw new ProtocolError(
      "LEASE_ACTIVE",
      "Bot lease recovery is owned by an active or uninspectable supervisor",
    );
  if (!(await removeOwned(path, previous)))
    throw new ProtocolError(
      "LEASE_ACTIVE",
      "Bot lease recovery ownership changed",
    );
  try {
    return await create(path, identity);
  } catch (error) {
    if (code(error) === "EEXIST")
      throw new ProtocolError(
        "LEASE_ACTIVE",
        "Bot lease recovery is owned by another activation",
      );
    throw error;
  }
}

/** Local-machine exclusion. This does not prevent another machine or arbitrary
 * software running as the same user from polling the same bot. Ambiguous
 * ownership (including a crash before an owner record is written) fails closed. */
export class BotLease {
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly path: string,
    private readonly owner: OwnedFile,
  ) {}

  static async acquire(options: {
    directory: string;
    botId: number;
    generation: string;
  }): Promise<BotLease> {
    if (
      !Number.isSafeInteger(options.botId) ||
      options.botId <= 0 ||
      !options.generation
    )
      throw new ProtocolError("LEASE_IDENTITY", "Invalid bot lease identity");
    const requested = resolve(options.directory);
    // Reject a symlink as the selected directory, but permit canonical parent
    // aliases such as macOS /tmp. All subsequent paths use the canonical parent.
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(requested);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !leasePermissionsValid(directoryInfo)
    ) {
      throw new ProtocolError(
        "LEASE_DIRECTORY",
        "Bot lease directory must be a real directory with valid platform permissions",
      );
    }
    const directory = await realpath(requested);
    const canonicalInfo = await lstat(directory);
    if (
      canonicalInfo.ino !== directoryInfo.ino ||
      canonicalInfo.dev !== directoryInfo.dev
    )
      throw new ProtocolError("LEASE_DIRECTORY", "Bot lease directory changed");
    const path = join(directory, `${options.botId}.lock`);
    const identity: LeaseRecord = {
      pid: process.pid,
      generation: options.generation,
      nonce: randomBytes(24).toString("hex"),
    };
    // Every acquisition participates, including first acquisition: a new main
    // lease cannot be installed while another activation is reclaiming it.
    const recoveryPath = `${path}.recover`;
    const recovery = await recoveryLock(recoveryPath, identity);
    try {
      try {
        return new BotLease(path, await create(path, identity));
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      const previous = await inspect(path);
      if (!dead(previous.identity.pid))
        throw new ProtocolError(
          "LEASE_ACTIVE",
          "Bot lease is owned by an active or uninspectable supervisor",
        );
      if (!same(recovery, await inspect(recoveryPath)))
        throw new ProtocolError(
          "LEASE_ACTIVE",
          "Bot lease recovery ownership changed",
        );
      if (!(await removeOwned(path, previous)))
        throw new ProtocolError("LEASE_ACTIVE", "Bot lease ownership changed");
      return new BotLease(path, await create(path, identity));
    } finally {
      await removeOwned(recoveryPath, recovery);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.release();
    return this.closing;
  }
  private async release(): Promise<void> {
    await removeOwned(this.path, this.owner);
  }
}
