import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { registerSettingsRoute } from "../src/host/settings-host.js";
import { required } from "./fixture-assertions.js";

import type {
  SettingsHandler,
  SettingsRouteContext,
} from "../src/host/dsh-contracts.js";

test("Desktop origin accepted by Harness is not rejected by an HTTP-origin comparison", async () => {
  let handler: SettingsHandler | undefined,
    saved: Record<string, unknown> | undefined;
  const ctx: SettingsRouteContext = {
    effect: (fn) => fn(),
    webServer: {
      register: (r) => {
        handler = r.handler;
        return () => {};
      },
      getOrigin: () => "http://127.0.0.1:1234",
    },
    connection: {
      requestRejection: () => undefined,
      admit: () => ({ peer: { principal: { kind: "owner" } } }),
    },
  };
  registerSettingsRoute(ctx, {
    read: async () => ({ adminUserId: 1, tokenConfigured: true }),
    save: async (body) => {
      assert.ok(body && typeof body === "object" && !Array.isArray(body));
      saved = { ...body };
      return { adminUserId: 1, tokenConfigured: true };
    },
  });
  const req = Readable.from([
    Buffer.from(JSON.stringify({ adminUserId: 1, botToken: "test-only" })),
  ]);
  const request = Object.assign(req, {
    method: "POST",
    url: "/telegram-console/settings",
    headers: {
      origin: "dsh-desktop://app",
      "content-type": "application/json",
    },
  });
  let status: number | undefined, body: string | undefined;
  await required(handler)(request, {
    writeHead: (s) => (status = s),
    end: (b) => (body = b),
  });
  assert.equal(status, 200);
  assert.equal(required(saved).botToken, "test-only");
  assert.ok(!required(body).includes("test-only"));
});
test("Harness rejected origins never reach save", async () => {
  let handler: SettingsHandler | undefined;
  registerSettingsRoute(
    {
      effect: (fn) => fn(),
      webServer: {
        register: (r) => {
          handler = r.handler;
        },
        getOrigin: () => "http://127.0.0.1:1234",
      },
      connection: {
        requestRejection: () => 403,
        admit: () => {
          throw Error("unreachable");
        },
      },
    },
    {
      read: async () => {
        throw Error("unreachable");
      },
      save: async () => {
        throw Error("unreachable");
      },
    },
  );
  let code: number | undefined;
  await required(handler)(Object.assign(Readable.from([]), { headers: {} }), {
    writeHead: (s) => (code = s),
    end: () => {},
  });
  assert.equal(code, 403);
});
