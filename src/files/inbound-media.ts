import type { TelegramMessage } from "../bot/contracts.js";

export interface InboundMedia {
  fileId: string;
  /** Display name only. Host must generate its own confined storage basename. */
  name: string;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
function fileId(value: unknown): string | undefined {
  const id = object(value).file_id;
  return typeof id === "string" && id.length > 0 && id.length <= 4096
    ? id
    : undefined;
}
function filename(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // Telegram filenames are untrusted: retain the basename and its extension,
  // never directories, controls or bidi overrides. Storage is not derived here.
  const name = value
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return name && name !== "." && name !== ".." ? name : fallback;
}
const extensions: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/plain": "txt",
};

/** Select the full inbound payload, never a media thumbnail. Pure and defensive
 * because persisted Telegram updates can outlive the SDK's current type shape. */
export function inboundMedia(
  message: TelegramMessage,
): InboundMedia | undefined {
  const input = object(message);
  if (Array.isArray(input.photo)) {
    const photos = input.photo.filter((photo) => fileId(photo));
    const score = (photo: unknown) => {
      const p = object(photo);
      return typeof p.width === "number" &&
        typeof p.height === "number" &&
        Number.isFinite(p.width * p.height) &&
        p.width > 0 &&
        p.height > 0
        ? p.width * p.height
        : 0;
    };
    const largest = photos.reduce<unknown>(
      (best, photo) => (score(photo) >= score(best) ? photo : best),
      undefined,
    );
    const id = fileId(largest);
    if (id) return { fileId: id, name: "photo.jpg" };
  }
  const sticker = object(input.sticker);
  const stickerId = fileId(sticker);
  if (stickerId)
    return {
      fileId: stickerId,
      name: `sticker.${sticker.is_video ? "webm" : sticker.is_animated ? "tgs" : "webp"}`,
    };
  const kinds = [
    ["audio", "mp3"],
    ["voice", "ogg"],
    ["document", "bin"],
    ["video", "mp4"],
    ["animation", "mp4"],
    ["video_note", "mp4"],
  ] as const;
  for (const [kind, defaultExtension] of kinds) {
    const media = object(input[kind]);
    const id = fileId(media);
    if (!id) continue;
    const mime =
      typeof media.mime_type === "string" ? media.mime_type.toLowerCase() : "";
    const ext = extensions[mime] ?? defaultExtension;
    return { fileId: id, name: filename(media.file_name, `${kind}.${ext}`) };
  }
  return undefined;
}
