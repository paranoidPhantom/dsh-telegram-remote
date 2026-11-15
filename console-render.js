import { relativePathText } from './path-display.js';
/** Pure Telegram text formatting and protocol error classification. */
export const TTL = 15 * 60_000;
export const PAGE = 8;
export const str = value => typeof value === 'string' ? value : value == null ? '—' : JSON.stringify(value);
export const cut = (value, max = 3900) => {
  const text = str(value);
  const end = text.length > max && /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
};
export const html = value => str(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const label = value => typeof value === 'string' ? value : value?.name || value?.model || value?.id || '';
export const chunks = (value, max = 4096) => {
  const result = [];
  let text = str(value);
  while (text.length) {
    let end = Math.min(max, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(0, end)); text = text.slice(end);
  }
  return result.length ? result : [''];
};
export const percent = value => {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value)) return value;
  const n = typeof value === 'number' ? value : value?.percent ?? value?.percentage ?? (Number.isFinite(value?.pressureTokens) && value?.contextWindow > 0 ? value.pressureTokens / value.contextWindow * 100 : undefined);
  return Number.isFinite(n) ? `${Math.round(n * 10) / 10}%` : '';
};
export const unsupportedDraft = error => /(?:method.*(?:not found|unsupported)|unknown method|not supported|sendMessageDraft.*not|404)/i.test(error?.message || '');
export const missingTopic = error => /(?:message thread|topic).*(?:not found|deleted)|TOPIC_DELETED/i.test(error?.message || String(error));
export const missingMessage = error => /message to edit not found|message_id_invalid/i.test(error?.message || String(error));
export const notModified = error => /not modified/i.test(error?.message || String(error));
export const gone = error => error?.status === 404 || error?.statusCode === 404 || /session.*(?:not found|deleted)|unknown session/i.test(error?.message || '');


export function compactSession(id, metadata, active = false) {
  if (!metadata) return '⚠ Session gone in DSH. Use /new or /sessions.';
  const model = label(metadata.model), current = label(metadata.activeModel), context = percent(metadata.context);
  return [metadata.title || id, model && `Model: ${model}`, current && current !== model && `Active: ${current}`,
    metadata.running || active ? '▶ Working' : 'Idle', context && `Context: ${context}`].filter(Boolean).join('\n');
}

/** Escape before measuring: every returned HTML message stays under Telegram's
 * limit even when tool output consists entirely of reserved HTML characters. */
export function toolLogPages(entries = [], final = false, cwd) {
  if (!entries.length) return [];
  const icons = { running: '▶', completed: '✓', failed: '✗', cancelled: '⏹' };
  const preview = (value, limit) => {
    const text = str(value);
    return html(text.length > limit ? `${cut(text, limit)}… [truncated]` : text);
  };
  const rows = entries.map((tool, index) => {
    const status = tool.status || 'running';
    const summary = tool.summary ? ` — <code>${preview(relativePathText(tool.summary,cwd), 120)}</code>` : '';
    const name = String(tool.name || '').split(/[.:/]/).pop().toLowerCase();
    const isChange = /^(write|edit|apply_patch|write_file|edit_file)$/.test(name);
    // Read/search/command payloads are deliberately absent from the chat log.
    const detail = isChange && tool.resultHtml && /Changes|diff|Replace|With/.test(tool.resultHtml)
      ? `\n${tool.resultHtml}` : '';
    return `${index + 1}. ${icons[status] || '•'} ${preview(tool.name || 'Tool', 70)} · ${html(status)}${summary}${detail}`;
  });
  const pages = []; let page = '';
  for (const row of rows) {
    if (page && page.length + row.length + 1 > 3700) { pages.push(page); page = ''; }
    page += `${page ? '\n' : ''}${row}`;
  }
  if (page) pages.push(page);
  return pages.map((body, index) => `<blockquote expandable>Tools · ${final ? 'finished' : 'working'}${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}\n${body}</blockquote>`);
}
