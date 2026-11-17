import { writeFile, rename, unlink } from "node:fs/promises";
import { startupEventSchema, type StartupEvent } from "../protocol/startup.js";

export const RUNTIME_STATUS_MAX_BYTES = 100_000;
const MAX_EVENTS = 256;
type Entry = StartupEvent & {
  sequence: number;
  attempt: number;
  at: string;
  source: "host" | "child";
};

/** Single writer, coalesced snapshots and atomic replacement. No unbounded write queue. */
export class RuntimeStatusWriter {
  private events: Entry[] = [];
  private sequence = 0;
  private attempt = 0;
  private dropped = 0;
  private dirty = false;
  private writing?: Promise<void>;
  constructor(
    private readonly path: string,
    private readonly snapshot: () => Record<string, unknown>,
  ) {}
  record(source: "host" | "child", input: StartupEvent): Promise<void> {
    const event = startupEventSchema.parse(input);
    if (event.stage === "launch" && event.outcome === "begin") this.attempt++;
    this.events.push({
      ...event,
      source,
      sequence: ++this.sequence,
      attempt: this.attempt,
      at: new Date().toISOString(),
    });
    while (this.events.length > MAX_EVENTS) {
      this.events.shift();
      this.dropped++;
    }
    return this.flush();
  }
  /** Same bounded, allowlisted snapshot as the file; never read arbitrary disk bytes. */
  debugLog(): string {
    return this.serialize();
  }
  private serialize(): string {
    const snapshot = this.snapshot();
    const encode = () =>
      JSON.stringify(
        {
          ...snapshot,
          startupLog: this.events,
          startupLogDropped: this.dropped,
        },
        null,
        2,
      );
    let text = encode();
    while (
      Buffer.byteLength(text, "utf8") > RUNTIME_STATUS_MAX_BYTES &&
      this.events.length
    ) {
      this.events.shift();
      this.dropped++;
      text = encode();
    }
    // Diagnostics are secondary to the byte bound; normal snapshots are tiny.
    if (Buffer.byteLength(text, "utf8") > RUNTIME_STATUS_MAX_BYTES) {
      return JSON.stringify({
        state: "diagnostics-too-large",
        startupLog: [],
        startupLogDropped: this.dropped,
      });
    }
    return text;
  }
  flush(): Promise<void> {
    this.dirty = true;
    if (!this.writing) {
      this.writing = this.drain().finally(() => {
        this.writing = undefined;
      });
    }
    return this.writing;
  }
  private async drain(): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      while (this.dirty) {
        this.dirty = false;
        await writeFile(temporary, this.serialize(), { mode: 0o600 });
        await rename(temporary, this.path);
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
