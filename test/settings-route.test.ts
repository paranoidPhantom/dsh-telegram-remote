import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  registerSettingsRoute,
  type SettingsRouteOptions,
} from "../src/host/settings-host.js";
import { required } from "./fixture-assertions.js";

import type {
  SettingsHandler,
  SettingsRouteContext,
} from "../src/host/dsh-contracts.js";

function debugRoute(
  options: SettingsRouteOptions = {},
  access: "owner" | "guest" | "rejected" = "owner",
) {
  let handler: SettingsHandler | undefined;
  let disposed = false;
  let registrations = 0;
  let reads = 0;
  const unregister = () => {
    disposed = true;
  };
  const effect = registerSettingsRoute(
    {
      effect: (fn) => fn(),
      webServer: {
        register: (route) => {
          registrations++;
          assert.equal(route.kind, "exact");
          assert.equal(route.path, "/telegram-console/settings");
          handler = route.handler;
          return unregister;
        },
        getOrigin: () => "http://127.0.0.1:1234",
      },
      connection: {
        requestRejection: () => (access === "rejected" ? 403 : undefined),
        admit: () =>
          access === "guest"
            ? { rejection: 403 }
            : { peer: { principal: { kind: "owner" } } },
      },
    },
    {
      read: async () => {
        reads++;
        return { adminUserId: 1, tokenConfigured: true };
      },
      save: async () => {
        throw Error("unreachable");
      },
    },
    options,
  );
  return {
    get reads() {
      return reads;
    },
    dispose() {
      assert.equal(effect, unregister);
      unregister();
      assert.ok(disposed);
      assert.equal(registrations, 1);
    },
    async request(url = "/telegram-console/settings?debug=1") {
      let status = 0;
      let headers: unknown;
      let body: string | undefined;
      await required(handler)(
        Object.assign(Readable.from([]), {
          method: "GET",
          url,
          headers: { origin: "dsh-desktop://app" },
        }),
        {
          writeHead: (value, valueHeaders) => {
            status = value;
            headers = valueHeaders;
          },
          end: (value) => {
            body = value;
          },
        },
      );
      return { status, headers, body };
    },
  };
}

test("debug export shares authenticated exact route, no-store and lifecycle cleanup", async () => {
  const debugLog = JSON.stringify({ status: "safe" });
  let exports = 0;
  const route = debugRoute({
    getDebugLog: async () => {
      exports++;
      return debugLog;
    },
  });
  const response = await route.request();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(required(response.body)), { debugLog });
  assert.deepEqual(response.headers, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  assert.equal(route.reads, 0);
  await route.request("/telegram-console/settings");
  await route.request("/telegram-console/settings?debug=0");
  assert.equal(route.reads, 2);
  assert.equal(exports, 1);
  route.dispose();
});

test("debug export rejects untrusted or non-owner requests before callback", async () => {
  for (const access of ["guest", "rejected"] as const) {
    let called = false;
    const route = debugRoute(
      {
        getDebugLog: () => {
          called = true;
          return "{}";
        },
      },
      access,
    );
    const response = await route.request();
    assert.equal(response.status, 403);
    assert.equal(called, false);
    assert.equal(route.reads, 0);
  }
});

test("debug export accepts byte limit and safely rejects unavailable, oversized or failed exports", async () => {
  const allowed = "界".repeat(33_333) + "a";
  assert.equal(Buffer.byteLength(allowed), 100_000);
  assert.equal(
    (await debugRoute({ getDebugLog: () => allowed }).request()).status,
    200,
  );
  for (const options of [
    {},
    { getDebugLog: () => allowed + "a" },
    {
      getDebugLog: () => {
        throw Error("secret internal detail");
      },
    },
    {
      getDebugLog: async () => {
        throw Error("secret internal detail");
      },
    },
  ]) {
    const response = await debugRoute(options).request();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(required(response.body)), {
      error: "Unable to export debug log.",
    });
    assert.equal(required(response.body).includes("secret"), false);
  }
});

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
