import assert from "node:assert/strict";
import type { InlineMarkup, TelegramParams } from "../src/bot/contracts.js";
export function inlineMarkup(
  value: TelegramParams["reply_markup"],
): InlineMarkup {
  assert.ok(
    value && "inline_keyboard" in value,
    "Expected inline keyboard markup",
  );
  return value;
}
export function requiredField<T>(value: T | null | undefined): T {
  assert.notEqual(value, undefined, "Expected Telegram parameter field");
  assert.notEqual(value, null, "Expected Telegram parameter field");
  if (value == null) throw new Error("Expected Telegram parameter field");
  return value;
}
