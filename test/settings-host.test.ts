import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsController } from "../src/host/settings-host.js";
import type { ApiKeyCredential } from "../src/host/dsh-contracts.js";
import type { JsonValue } from "../src/protocol/json.js";
import { required } from "./fixture-assertions.js";
test("token writes only credentials and read response never includes token", async () => {
  let admin = 1;
  let record: ApiKeyCredential | undefined;
  const data = new Map<string, JsonValue>();
  const controller = createSettingsController({
    credentialKey: "telegram-console/bot",
    credentials: {
      describeRecord: async () => ({ configured: !!record }),
      readRecord: async () => record,
      modifyRecord: async (k, fn) => {
        assert.equal(k, "telegram-console/bot");
        record = await fn();
      },
    },
    store: {
      set: async (k, v) => data.set(k, v),
      entries: async () => [...data],
    },
    getAdmin: () => admin,
    setAdmin: (v) => (admin = v),
  });
  const token = "123:" + "a".repeat(30);
  const result = await controller.save({ adminUserId: "2", botToken: token });
  assert.equal(required(record).key, token);
  assert.deepEqual(result, { adminUserId: 2, tokenConfigured: true });
  assert.ok(!JSON.stringify([...data]).includes(token));
  assert.ok(!JSON.stringify(result).includes(token));
  await controller.save({ adminUserId: 2, botToken: "" });
  assert.equal(required(record).key, token);
});
test("invalid admin/token is rejected before credentials persistence", async () => {
  let writes = 0;
  const c = createSettingsController({
    credentialKey: "telegram-console/bot",
    credentials: {
      modifyRecord: async () => writes++,
      describeRecord: async () => ({ configured: false }),
      readRecord: async () => undefined,
    },
    getAdmin: () => 1,
    store: { entries: async () => [], set: async () => {} },
    setAdmin: () => {},
  });
  await assert.rejects(c.save({ adminUserId: 0, botToken: "x" }));
  await assert.rejects(c.save({ adminUserId: 2, botToken: "invalid" }));
  assert.equal(writes, 0);
});
