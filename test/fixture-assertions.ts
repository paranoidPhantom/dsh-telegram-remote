export function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Expected fixture value to be initialized");
  return value;
}
