export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MAX_ENVELOPE_BYTES = 256 * 1024;
export const MAX_JSON_DEPTH = 32;

export class ProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function inspect(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH)
    throw new ProtocolError("DEPTH_LIMIT", "JSON nesting limit exceeded");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object")
    throw new ProtocolError(
      "INVALID_JSON_VALUE",
      "Only finite plain JSON values are allowed",
    );
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new ProtocolError(
      "INVALID_JSON_VALUE",
      "Live objects cannot cross this boundary",
    );
  }
  if (ancestors.has(value))
    throw new ProtocolError("JSON_CYCLE", "Cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        prototype !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        throw new ProtocolError(
          "INVALID_JSON_VALUE",
          "Only plain dense arrays are allowed",
        );
      }
      for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !("value" in property) || !property.enumerable) {
          throw new ProtocolError(
            "INVALID_JSON_VALUE",
            "Only dense array data entries are allowed",
          );
        }
        inspect(property.value, depth + 1, ancestors);
      }
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string")
          throw new ProtocolError(
            "INVALID_JSON_VALUE",
            "Symbol keys cannot cross this boundary",
          );
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !("value" in property) || !property.enumerable) {
          throw new ProtocolError(
            "INVALID_JSON_VALUE",
            "Only enumerable data properties are allowed",
          );
        }
        inspect(property.value, depth + 1, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function checkSize(text: string, limit: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    Buffer.byteLength(text, "utf8") > limit
  ) {
    throw new ProtocolError("BYTE_LIMIT", "JSON byte budget exceeded");
  }
}

export function encodeJson(
  value: unknown,
  maxBytes = MAX_ENVELOPE_BYTES,
): string {
  inspect(value, 0, new Set());
  const text = JSON.stringify(value);
  checkSize(text, maxBytes);
  return text;
}

export function decodeJson(
  text: string,
  maxBytes = MAX_ENVELOPE_BYTES,
): JsonValue {
  checkSize(text, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("INVALID_JSON", "Malformed JSON");
  }
  inspect(value, 0, new Set());
  return value;
}

export function jsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
