import { randomBytes } from "node:crypto";
import { ProtocolError } from "../protocol/json.js";

interface Scope {
  generation: string;
  ownerEpoch: number;
}
interface Resource extends Scope {
  name: string;
  bytes: Buffer;
  expires: number;
}
export interface ResourceDescriptor {
  id: string;
  name: string;
  size: number;
}

/** Bounded transfer capabilities, not filesystem path authority. The caller
 * must finish canonical Host filesystem authorization before registering bytes. */
export class ResourceRegistry {
  private readonly resources = new Map<string, Resource>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxResources: number;
  private bytes = 0;
  private closed = false;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      maxBytes?: number;
      maxResources?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.maxResources = options.maxResources ?? 64;
  }

  add(input: Scope & { name: string; bytes: Buffer }): ResourceDescriptor {
    if (this.closed)
      throw new ProtocolError("RESOURCE_CLOSED", "Resource registry is closed");
    this.sweep();
    if (
      input.bytes.length > 10 * 1024 * 1024 ||
      this.bytes + input.bytes.length > this.maxBytes ||
      this.resources.size >= this.maxResources
    ) {
      throw new ProtocolError(
        "RESOURCE_CAPACITY",
        "Resource transfer budget exceeded",
      );
    }
    const id = randomBytes(24).toString("base64url");
    this.resources.set(id, {
      ...input,
      bytes: Buffer.from(input.bytes),
      expires: this.now() + this.ttlMs,
    });
    this.bytes += input.bytes.length;
    return { id, name: input.name, size: input.bytes.length };
  }

  read(input: Scope & { id: string; offset: number; length: number }) {
    this.sweep();
    const resource = this.resources.get(input.id);
    if (
      !resource ||
      resource.generation !== input.generation ||
      resource.ownerEpoch !== input.ownerEpoch
    ) {
      throw new ProtocolError(
        "RESOURCE_UNAVAILABLE",
        "Resource is unavailable or expired",
      );
    }
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > resource.bytes.length ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > 65536
    ) {
      throw new ProtocolError(
        "RESOURCE_RANGE",
        "Invalid resource offset or chunk length",
      );
    }
    const end = Math.min(resource.bytes.length, input.offset + input.length);
    return {
      data: resource.bytes.subarray(input.offset, end).toString("base64"),
      offset: input.offset,
      total: resource.bytes.length,
      eof: end === resource.bytes.length,
    };
  }

  release(id: string) {
    const resource = this.resources.get(id);
    if (resource) this.bytes -= resource.bytes.length;
    this.resources.delete(id);
  }
  revokeGeneration(generation: string) {
    for (const [id, resource] of this.resources)
      if (resource.generation === generation) this.release(id);
  }
  close() {
    this.closed = true;
    this.resources.clear();
    this.bytes = 0;
  }
  private sweep() {
    for (const [id, resource] of this.resources)
      if (resource.expires <= this.now()) this.release(id);
  }
}
