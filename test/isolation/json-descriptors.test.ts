import test from "node:test";
import assert from "node:assert/strict";
import { encodeJson, ProtocolError } from "../../src/protocol/json.js";

test("JSON arrays cannot execute toJSON or getter hooks during serialization", () => {
  let executed = false;
  const withHook = Object.assign([1], {
    toJSON() {
      executed = true;
      return "hidden";
    },
  });
  assert.throws(() => encodeJson(withHook), ProtocolError);
  const getter: unknown[] = [];
  Object.defineProperty(getter, "0", {
    enumerable: true,
    get() {
      executed = true;
      return 1;
    },
  });
  assert.throws(() => encodeJson(getter), ProtocolError);
  assert.equal(executed, false);
});

test("JSON arrays reject subclasses and invisible properties rather than silently dropping them", () => {
  class LiveArray extends Array<number> {}
  assert.throws(() => encodeJson(new LiveArray(1)), ProtocolError);
  const symbol = [1];
  Object.defineProperty(symbol, Symbol("authority"), { value: true });
  assert.throws(() => encodeJson(symbol), ProtocolError);
  const extra = Object.assign([1], { authority: true });
  assert.throws(() => encodeJson(extra), ProtocolError);
});
