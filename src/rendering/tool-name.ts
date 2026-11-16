import { z } from "zod";

/** Ordered, case-insensitive glob rules; '*' matches any sequence of characters. */
export const toolNameRulesSchema = z
  .array(
    z.object({
      pattern: z.string().min(1).max(200),
      emoji: z.string().min(1).max(32).optional(),
      customEmojiId: z
        .string()
        .regex(/^[0-9]{1,32}$/)
        .optional(),
    }),
  )
  .max(100);
export type ToolNameRule = z.infer<typeof toolNameRulesSchema>[number];
export const DEFAULT_TOOL_EMOJI = "🔧";
export const DEFAULT_TOOL_CUSTOM_EMOJI_ID = "5220046725493828505";

export const normalizeToolName = (name: unknown): string =>
  String(name ?? "")
    .split(/[.:/]/)
    .pop()
    ?.replace(/^.*__/, "")
    .toLowerCase() ?? "";

export function matchToolName(
  name: unknown,
  rules: readonly ToolNameRule[] = [],
) {
  const full = String(name ?? "").toLowerCase();
  const normalized = normalizeToolName(name);
  const rule = rules.find(({ pattern }) => {
    const expression = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
      "i",
    );
    return expression.test(full) || expression.test(normalized);
  });
  return {
    normalized,
    emoji: rule?.emoji ?? DEFAULT_TOOL_EMOJI,
    // A plain replacement emoji intentionally opts out of the compatibility ID.
    customEmojiId: rule ? rule.customEmojiId : DEFAULT_TOOL_CUSTOM_EMOJI_ID,
    isChange: /^(write|edit|apply_patch|write_file|edit_file)$/.test(
      normalized,
    ),
  };
}

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
export function toolEmojiHtml(
  name: unknown,
  rules?: readonly ToolNameRule[],
): string {
  const icon = matchToolName(name, rules);
  return icon.customEmojiId
    ? `<tg-emoji emoji-id="${escape(icon.customEmojiId)}">${escape(icon.emoji)}</tg-emoji>`
    : escape(icon.emoji);
}
