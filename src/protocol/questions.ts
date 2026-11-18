import { z } from "zod";

/** Bounded presentation DTOs; resolvers and live agents never cross IPC. */
export const questionItemSchema = z.object({
  id: z.string().min(1).max(256),
  question: z.string().min(1).max(8000),
  detail: z.string().max(24000).optional(),
  header: z.string().max(256).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(1000),
        description: z.string().max(4000).optional(),
      }),
    )
    .max(30)
    .optional(),
  multiSelect: z.boolean().optional(),
});
export const questionItemsSchema = z
  .array(questionItemSchema)
  .min(1)
  .max(12)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
  )
  .refine((items) =>
    items.every(
      (item) =>
        new Set(item.options?.map((option) => option.label)).size ===
        (item.options?.length ?? 0),
    ),
  );
export const questionAnswerSchema = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        selected: z.array(z.string().min(1).max(1000)).max(30),
        custom: z.string().min(1).max(8000).optional(),
      }),
    )
    .min(1)
    .max(12),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export function validQuestionAnswer(
  questions: readonly QuestionItem[],
  value: unknown,
): QuestionAnswer | undefined {
  const parsed = questionAnswerSchema.safeParse(value);
  if (!parsed.success || parsed.data.answers.length !== questions.length)
    return;
  const ids = new Set<string>();
  for (const answer of parsed.data.answers) {
    const question = questions.find((question) => question.id === answer.id);
    if (
      !question ||
      ids.has(answer.id) ||
      new Set(answer.selected).size !== answer.selected.length
    )
      return;
    ids.add(answer.id);
    if (
      answer.selected.some(
        (label) => !question.options?.some((option) => option.label === label),
      )
    )
      return;
    if (
      !question.multiSelect &&
      (answer.selected.length > 1 || (answer.custom && answer.selected.length))
    )
      return;
  }
  return parsed.data;
}
