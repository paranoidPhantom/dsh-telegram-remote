import { normalizeToolName } from "./tool-name.js";

const compact = (value: string, limit = 120) => {
  const text = value.toWellFormed().replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : text;
};
function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Only small, intentional argument fields: never dump a tool's full payload. */
export function namedCallSummary(
  name: string,
  raw: unknown,
): string | undefined {
  const args = object(raw);
  if (!args) return undefined;
  switch (normalizeToolName(name)) {
    case "plugin_manager":
      return [
        typeof args.action === "string" ? args.action.replaceAll("_", " ") : "",
        typeof args.target === "string" ? args.target : "",
      ]
        .filter(Boolean)
        .map((part) => compact(part))
        .join(" · ");
    case "job_output":
    case "job_kill":
      return typeof args.job_id === "string" ? compact(args.job_id) : "";
    default:
      return undefined;
  }
}
/** Bounded job status + last output line. No generic tool-result dumping. */
export function jobResultSummary(
  name: string,
  text: string,
  prior: string,
): string | undefined {
  if (normalizeToolName(name) !== "job_output") return undefined;
  const data = object(text);
  const status =
    typeof data?.status === "string"
      ? data.status
      : text.match(/\[status:\s*([^\],]+)(?:,|\])/i)?.[1];
  const exit =
    data?.exitCode ??
    data?.exit_code ??
    text.match(/\[(?:status:[^\]]*?,\s*)?exit code:\s*(-?\d+)\]/i)?.[1];
  const output =
    typeof data?.output === "string" ? data.output : data ? "" : text;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[(?:status|exit code):/i.test(line));
  const tail = lines.at(-1);
  return [
    prior,
    status && compact(status, 40),
    typeof exit === "number" || typeof exit === "string" ? `exit ${exit}` : "",
    tail && compact(tail),
  ]
    .filter(Boolean)
    .join(" · ");
}
