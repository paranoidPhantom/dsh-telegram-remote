import { z } from "zod";
import { defaultToolIcon, DEFAULT_TOOL_EMOJI } from "./tool-icons.js";
export {
  DEFAULT_TOOL_ICONS,
  DEFAULT_TOOL_EMOJI,
  DEFAULT_TOOL_CUSTOM_EMOJI_ID,
} from "./tool-icons.js";

/** Ordered, case-insensitive glob rules; '*' matches any sequence of characters. */
export const toolNameRulesSchema = z
  .array(
    z.object({
      pattern: z.string().min(1).max(200),
      emoji: z
        .string()
        .min(1)
        .max(32)
        .refine((value) => value.length <= 32, "At most 32 UTF-16 units")
        .optional(),
      customEmojiId: z
        .string()
        .regex(/^[0-9]{1,32}$/)
        .optional(),
    }),
  )
  .max(100);
export type ToolNameRule = z.infer<typeof toolNameRulesSchema>[number];

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
  const builtin = defaultToolIcon(full, normalized);
  return {
    normalized,
    emoji: rule ? (rule.emoji ?? DEFAULT_TOOL_EMOJI) : builtin.emoji,
    // Any explicit rule opts out of built-ins, including plain/catch-all rules.
    customEmojiId: rule ? rule.customEmojiId : builtin.customEmojiId,
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
