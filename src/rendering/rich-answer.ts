/** Native Telegram Rich Markdown. Model text never supplies HTML or media capabilities. */
export interface RichAnswerPart {
  markdown: string;
}
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const html = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (text: string) =>
  text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
function code(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const delimiter = "`".repeat(
    Math.max(1, ...runs.map((run) => run.length + 1)),
  );
  return `${delimiter} ${text.replace(/\r?\n/g, " ")} ${delimiter}`;
}
function external(target: string): boolean {
  if (!/^https?:\/\//i.test(target) || /[\s<>\x00-\x1f]/.test(target))
    return false;
  try {
    const value = new URL(target);
    return !!value.hostname && !value.username && !value.password;
  } catch {
    return false;
  }
}
function bracket(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === open) depth++;
    if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}
function destination(source: string): string {
  const value = source.trim();
  if (value.startsWith("<"))
    return unescape(value.slice(1, value.indexOf(">")));
  // Whitespace starts an optional Markdown title, not part of the address.
  return unescape(value.split(/\s/)[0] ?? "");
}
type References = Map<string, string>;
const refKey = (text: string) =>
  unescape(text).replace(/\s+/g, " ").trim().toLowerCase();

/** Protect code spans before interpreting brackets; nested labels and destination
 * parentheses are balanced, escaped punctuation never becomes an active image. */
function inline(source: string, references: References, depth = 0): string {
  if (depth > 8) return code(unescape(source));
  let result = "";
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "\\" && index + 1 < source.length) {
      const next = source[index + 1]!;
      result += /[<>&]/.test(next) ? html(next) : `\\${next}`;
      index += 2;
      continue;
    }
    if (character === "`") {
      const run = source.slice(index).match(/^`+/)![0];
      let end = source.indexOf(run, index + run.length);
      while (
        end >= 0 &&
        (source[end - 1] === "`" || source[end + run.length] === "`")
      )
        end = source.indexOf(run, end + run.length);
      if (end >= 0) {
        result += source.slice(index, end + run.length);
        index = end + run.length;
        continue;
      }
      result += "\\`".repeat(run.length);
      index += run.length;
      continue;
    }
    const image = character === "!" && source[index + 1] === "[";
    const start = image ? index + 1 : index;
    if (source[start] === "[") {
      const end = bracket(source, start, "[", "]");
      if (end >= 0) {
        const label = source.slice(start + 1, end);
        let target: string | undefined;
        let stop = end + 1;
        if (source[stop] === "(") {
          const close = bracket(source, stop, "(", ")");
          if (close >= 0) {
            target = destination(source.slice(stop + 1, close));
            stop = close + 1;
          }
        } else if (source[stop] === "[") {
          const close = bracket(source, stop, "[", "]");
          if (close >= 0) {
            target = references.get(
              refKey(source.slice(stop + 1, close) || label),
            );
            stop = close + 1;
          }
        } else target = references.get(refKey(label));
        if (target !== undefined) {
          result += external(target)
            ? `[${inline(label, references, depth + 1)}](${html(target).replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`
            : code(unescape(label));
          index = stop;
          continue;
        }
        if (image) {
          // Unknown/malformed reference images can never become media after a
          // later definition or when a streaming suffix arrives.
          result += "\\!";
          index++;
          continue;
        }
      }
    }
    if (character === "!" && source[index + 1] === "[") {
      result += "\\!";
      index++;
      continue;
    }
    if (source.slice(index).match(/^tg:\/\//i)) {
      const value = source.slice(index).match(/^\S+/)![0];
      result += code(value);
      index += value.length;
      continue;
    }
    result += html(character);
    index++;
  }
  return result;
}
function longest(text: string, character: string): number {
  return Math.max(
    0,
    ...(text.match(character === "`" ? /`+/g : /~+/g) ?? []).map(
      (run) => run.length,
    ),
  );
}
function fenceFor(text: string): string {
  const ticks = longest(text, "`"),
    tildes = longest(text, "~");
  return ticks <= tildes
    ? "`".repeat(Math.max(3, ticks + 1))
    : "~".repeat(Math.max(3, tildes + 1));
}
function splitBytes(text: string, limit: number): string[] {
  const result: string[] = [];
  let value = "",
    size = 0;
  for (const character of text) {
    const length = bytes(character);
    if (size + length > limit && value) {
      result.push(value);
      value = "";
      size = 0;
    }
    value += character;
    size += length;
  }
  if (value) result.push(value);
  return result;
}

/** Default 16,000 source-byte ceiling is deliberately below Telegram's 32,768
 * text-character/500-block limits. A conservative 250 block-unit ceiling counts
 * every source line plus list/quote/table punctuation. Code is reopened across
 * chunks; pathological oversized lines/deep formatting are shown literally as
 * code instead of discarded. No fetch, media uploads, or authority-bearing HTML. */
export function richAnswerParts(input: unknown, max = 16000): RichAnswerPart[] {
  const limit = Math.min(16000, Math.floor(max));
  if (!Number.isFinite(limit) || limit < 256)
    throw new RangeError("Rich answer budget must be at least 256 bytes");
  const source = String(input ?? "").toWellFormed();
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const references: References = new Map();
  for (const line of lines) {
    const definition = line.match(/^ {0,3}\[([^\]^]+)\]:\s*(.+)/);
    if (definition)
      references.set(refKey(definition[1]!), destination(definition[2]!));
  }
  const parts: RichAnswerPart[] = [];
  let current = "",
    blocks = 0;
  const flush = () => {
    if (current) parts.push({ markdown: current });
    current = "";
    blocks = 0;
  };
  const add = (value: string, cost = 1) => {
    if (
      current &&
      (bytes(current) + bytes(value) > limit || blocks + cost > 250)
    )
      flush();
    current += value;
    blocks += cost;
  };
  const literal = (value: string, language = "") => {
    const delimiter = fenceFor(value);
    // Choose a delimiter absent from the code; if both delimiter alphabets have
    // enormous runs, splitting still uses safe inline escaped plain source.
    if (delimiter.length > 64) {
      for (const chunk of splitBytes(value, Math.floor((limit - 16) / 12)))
        add(
          `${html(chunk.replace(/[!\[\]*_`~|$=#>+().{}:\\-]/g, "\\$&"))}\n`,
          1,
        );
      return;
    }
    const open = `${delimiter}${language}\n`,
      close = `\n${delimiter}\n`;
    for (const chunk of splitBytes(value, limit - bytes(open) - bytes(close)))
      add(open + chunk + close);
  };
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!;
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)\n?$/);
    if (opening && !opening[2]!.includes(opening[1]![0]!)) {
      const marker = opening[1]!;
      const language = opening[2]!.trim().match(/^[\w+.-]{0,40}$/)?.[0] ?? "";
      let content = "";
      for (index++; index < lines.length; index++) {
        const candidate = lines[index]!;
        if (
          new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\n?$`).test(
            candidate,
          )
        )
          break;
        content += candidate;
      }
      literal(content.replace(/\n$/, ""), language);
      continue;
    }
    // Reference definitions are resolved above, retained safely as literal text
    // so they cannot enable a separately parsed shortcut image or tg:// link.
    if (/^ {0,3}\[[^\]^]+\]:/.test(line)) {
      literal(line.replace(/\n$/, ""));
      continue;
    }
    // CommonMark code spans may cross line boundaries. Pull through their exact
    // closing run before sanitizing, so HTML/media-looking code stays literal.
    const unclosedSpan = (value: string): string | undefined => {
      const runs = [...value.matchAll(/\\.|`+/gs)];
      for (let position = 0; position < runs.length; position++) {
        const run = runs[position]![0];
        if (!run.startsWith("`")) continue;
        const close = runs.findIndex(
          (candidate, candidateIndex) =>
            candidateIndex > position && candidate[0] === run,
        );
        if (close < 0) return run;
        position = close;
      }
      return undefined;
    };
    const span = unclosedSpan(line);
    if (span) {
      let following = "",
        close = -1;
      for (let next = index + 1; next < lines.length; next++) {
        following += lines[next]!;
        if ([...following.matchAll(/`+/g)].some((run) => run[0] === span)) {
          close = next;
          break;
        }
        // Do not swallow a later block fence in search of an unmatched inline tick.
        if (/^ {0,3}(?:`{3,}|~{3,})/.test(lines[next]!)) break;
      }
      if (close >= 0) {
        line += following;
        index = close;
      }
    }
    const prefix = line.match(/^ {0,3}(?:>[ \t]?)+/)?.[0] ?? "";
    const nesting =
      (prefix.match(/>/g) ?? []).length +
      Math.floor(
        (line.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0) / 2,
      );
    const emphasis = (line.match(/\*+|_+|~~|\|\||==/g) ?? []).length;
    const columns = (line.match(/\|/g) ?? []).length;
    const links = (line.match(/\[/g) ?? []).length;
    // Treat every delimiter as an opening nesting level; deliberately overcount
    // sequential spans rather than risk Telegram's 16-level parser limit.
    if (nesting > 8 || nesting + emphasis + links > 14 || columns > 21) {
      literal(line.replace(/\n$/, ""));
      continue;
    }
    const value = prefix + inline(line.slice(prefix.length), references);
    const cost = 1 + (line.match(/>|\||(?:^|\s)[*+-] |\d+\. /g) ?? []).length;
    if (bytes(value) > limit || cost > 250) literal(line.replace(/\n$/, ""));
    else add(value, cost);
  }
  flush();
  return parts.length ? parts : [{ markdown: "" }];
}
