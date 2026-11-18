/** The supported subset of Telegram entities; offsets and lengths are UTF-16. */
export interface AnswerEntity {
  type: "pre" | "code" | "bold" | "text_link";
  offset: number;
  length: number;
  language?: string;
  url?: string;
}

export interface AnswerPart {
  text: string;
  entities: AnswerEntity[];
}

/** Markdown subset -> Telegram entities. Raw HTML stays literal, never executable. */
export function formatAnswer(input: unknown): AnswerPart {
  let text = "";
  const entities: AnswerEntity[] = [];
  function append(
    value: string,
    type?: AnswerEntity["type"],
    extra: Pick<AnswerEntity, "language" | "url"> = {},
  ): void {
    const offset = text.length;
    text += value;
    if (type && value.length)
      entities.push({ type, offset, length: value.length, ...extra });
  }
  function inline(source: string): void {
    const token =
      /```([^\n`]*)\n([\s\S]*?)```|(`+)([^\n]*?)\3|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)|^ {0,3}#{1,6}[\t ]+([^\n]+?)(?:[\t ]+#+)?[\t ]*(?=\n|$)/gm;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = token.exec(source))) {
      append(source.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const language = (match[1] ?? "").trim();
        append(
          match[2].replace(/\n$/, ""),
          "pre",
          language ? { language } : {},
        );
      } else if (match[3]) {
        append(match[4] ?? "", "code");
      } else if (match[5] !== undefined || match[6] !== undefined) {
        const start = text.length;
        inline(match[5] ?? match[6] ?? "");
        entities.push({
          type: "bold",
          offset: start,
          length: text.length - start,
        });
      } else if (match[9] !== undefined) {
        const start = text.length;
        const entityStart = entities.length;
        inline(match[9]);
        for (let index = entities.length - 1; index >= entityStart; index--)
          if (entities[index]?.type === "bold") entities.splice(index, 1);
        // Telegram has no heading entity. Use bold on non-code spans only:
        // code/pre entities cannot overlap emphasis in Telegram's entity rules.
        const code = entities.filter(
          (entity) =>
            (entity.type === "code" || entity.type === "pre") &&
            entity.offset >= start,
        );
        let position = start;
        for (const entity of code) {
          if (position < entity.offset)
            entities.push({
              type: "bold",
              offset: position,
              length: entity.offset - position,
            });
          position = entity.offset + entity.length;
        }
        if (position < text.length)
          entities.push({
            type: "bold",
            offset: position,
            length: text.length - position,
          });
      } else {
        const target = (match[8] ?? "").replace(/^<|>$/g, "");
        const external = /^https?:\/\//i.test(target);
        append(
          match[7] ?? "",
          external ? "text_link" : "code",
          external ? { url: target } : {},
        );
      }
      cursor = token.lastIndex;
    }
    append(source.slice(cursor));
  }
  inline(String(input ?? ""));
  return {
    text,
    entities: entities.sort(
      (a, b) => a.offset - b.offset || b.length - a.length,
    ),
  };
}

export function answerParts(input: unknown, max = 4096): AnswerPart[] {
  const value = formatAnswer(input);
  const parts: AnswerPart[] = [];
  let offset = 0;
  while (offset < value.text.length) {
    let end = Math.min(offset + max, value.text.length);
    if (
      end < value.text.length &&
      /[\uD800-\uDBFF]/.test(value.text.charAt(end - 1))
    )
      end--;
    const entities = value.entities.flatMap((entity) => {
      const start = Math.max(offset, entity.offset);
      const stop = Math.min(end, entity.offset + entity.length);
      return stop > start
        ? [{ ...entity, offset: start - offset, length: stop - start }]
        : [];
    });
    parts.push({ text: value.text.slice(offset, end), entities });
    offset = end;
  }
  return parts.length ? parts : [{ text: "", entities: [] }];
}
