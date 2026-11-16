import { parseChildArguments } from "../../../src/child/index.js";
import { createProcessTransport } from "../../../src/protocol/process.js";
import { RpcPeer } from "../../../src/protocol/rpc.js";

// A timer/poll surrogate, NOT Telegram polling or an initialized ChildRuntime.
const { generation, build } = parseChildArguments(process.argv.slice(2));
const transport = createProcessTransport(process);
let timer: ReturnType<typeof setInterval> | undefined;
const peer = new RpcPeer({
  transport,
  generation,
  handlers: {
    "fixture.begin": async () => {
      if (timer) throw new Error("Surrogate already started");
      const ticks: number[] = [];
      timer = setInterval(() => {
        ticks.push(performance.timeOrigin + performance.now());
        if (ticks.length !== 5) return;
        clearInterval(timer);
        timer = undefined;
        void peer
          .request("fixture.progress", {
            pid: process.pid,
            ppid: process.ppid,
            runtime: process.release.name,
            electron: process.versions.electron ?? null,
            electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
            browserWindow: "BrowserWindow" in globalThis,
            ticks,
          })
          .catch(() => {});
      }, 5);
      return null;
    },
    "runtime.shutdown": async () => {
      setImmediate(() => transport.close());
      return null;
    },
  },
});
transport.onClose(() => {
  if (timer) clearInterval(timer);
  process.exit(0);
});
await peer.request("runtime.hello", {
  version: 1,
  build,
  runtime: "node",
  pid: process.pid,
});
