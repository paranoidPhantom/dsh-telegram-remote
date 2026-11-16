import {
  encodeJson,
  jsonObject,
  ProtocolError,
  type JsonValue,
} from "./json.js";

/** Convert optional application properties to JSON explicitly. Functions, live
 * objects and non-finite numbers remain errors rather than JSON coercions. */
export function wireValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(wireValue);
  if (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const output: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const [key, entry] of Object.entries(value))
      if (entry !== undefined) output[key] = wireValue(entry);
    encodeJson(output);
    return output;
  }
  encodeJson(value);
  return value as JsonValue;
}
export function object(value: JsonValue): Record<string, JsonValue> {
  if (!jsonObject(value))
    throw new ProtocolError("INVALID_PARAMS", "Expected object parameters");
  return value;
}
export function string(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value || value.length > 16384)
    throw new ProtocolError("INVALID_PARAMS", `Invalid ${name}`);
  return value;
}
export function integer(value: JsonValue | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new ProtocolError("INVALID_PARAMS", `Invalid ${name}`);
  return value;
}
