/** Presentation only: preserve canonical paths in callbacks and DSH state. */
export function relativePathText(text: unknown, cwd?: unknown): string {
  if (!cwd) return String(text ?? "");
  const root = String(cwd).replace(/[\\/]+$/, "");
  if (!root) return String(text ?? "");
  return String(text ?? "")
    .split(root + "/")
    .join("")
    .split(root + "\\")
    .join("");
}

export function fileButtonName(path: unknown): string {
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path);
}
