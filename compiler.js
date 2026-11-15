import { parse, parseFragment, serialize } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { realpath, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeFetch, validateResourceURL } from './safe-fetch.js';

export const COMPILER_LIMITS = Object.freeze({ maxRawBytes: 32768, maxCompressedBytes: 4096, maxResourceBytes: 524288, maxTotalBytes: 2097152, maxDepth: 12, maxResources: 128, timeoutMs: 15000 });
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const attr = (n, key) => n.attrs?.find(a => a.name === key)?.value;
function set(n, key, val) { n.attrs = (n.attrs || []).filter(a => a.name !== key); if (val !== undefined) n.attrs.push({ name: key, value: val }); }
function text(n, value) { n.childNodes = [{ nodeName: '#text', value, parentNode: n }]; }
const content = n => (n.childNodes || []).map(c => c.value || '').join('');
function remove(n) { if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter(c => c !== n); }
function unescapeCSS(s) { return s.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : ch); }
function netWarnings(code, warn) { if (/\b(fetch\s*\(|XMLHttpRequest\b|WebSocket\b|EventSource\b|sendBeacon\s*\(|import\s*(?:\(|[{'"*]))/i.test(code)) warn('JavaScript network calls/imports detected; static imports are bundled, runtime network calls cannot work in the widget sandbox'); }

/** fetchResource(url, {signal,maxBytes,timeoutMs}) -> {body:Buffer|string,mime,url?}.
 * An injected fetcher is trusted test/host infrastructure; production defaults to DNS-pinned safeFetch.
 * Optional scripts are NEVER dropped: all scripts/styles are required by the failure contract.
 */
export async function compileWidget(options = {}) {
  const limits = { ...COMPILER_LIMITS, ...options.limits };
  limits.maxRawBytes = Math.min(32768, limits.maxRawBytes);
  limits.maxCompressedBytes = Math.min(4096, limits.maxCompressedBytes);
  if (typeof options.html !== 'string' || !options.html.length) throw new Error('Widget HTML must be a non-empty string');
  if (Buffer.byteLength(options.html) > limits.maxRawBytes) throw new Error(`Original HTML exceeds ${limits.maxRawBytes} raw bytes`);
  const root = await realpath(options.rootDir || path.dirname(options.filePath || process.cwd()));
  const requestedSource = path.resolve(options.filePath || path.join(root, 'telegram_widget.html'));
  // Canonicalize the parent even when a file-write event precedes file visibility.
  const source = path.join(await realpath(path.dirname(requestedSource)), path.basename(requestedSource));
  const sourceRelative = path.relative(root, source);
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) throw new Error('HTML source escapes source workspace root');
  const base = pathToFileURL(source).href;
  const warnings = []; const warn = s => { if (!warnings.includes(s)) warnings.push(s); };
  const deadline = Date.now() + limits.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Widget compile time budget exceeded')), limits.timeoutMs);
  const resources = new Map(); const assets = []; let total = 0;
  function check(depth = 0) { controller.signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error('Widget compile time budget exceeded'); if (depth > limits.maxDepth) throw new Error(`Resource recursion exceeds depth ${limits.maxDepth}`); }
  function resolve(ref, from) {
    ref = unescapeCSS(ref.trim());
    const url = new URL(ref, from);
    if (url.protocol === 'file:') { if (new URL(from).protocol !== 'file:') throw new Error('Remote resources cannot access local files'); if (url.host) throw new Error('Local file host forbidden'); }
    else validateResourceURL(url);
    url.hash = ''; return url.href;
  }
  async function load(url, kind, depth) {
    check(depth);
    if (!resources.has(url)) {
      if (resources.size >= limits.maxResources) throw new Error('Resource count limit exceeded');
      resources.set(url, (async () => {
        let result;
        if (url.startsWith('file:')) {
          const actual = await realpath(fileURLToPath(url));
          const rel = path.relative(root, actual);
          if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Local resource escapes source workspace root');
          const handle = await open(actual, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            const stat = await handle.stat(); if (!stat.isFile() || stat.size > limits.maxResourceBytes) throw new Error('Local resource is not a bounded regular file');
            // Read at most limit+1 even if a concurrently edited file grows after stat.
            const buffer = Buffer.alloc(limits.maxResourceBytes + 1); let size = 0;
            while (size < buffer.length) { const read = await handle.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
            if (size > limits.maxResourceBytes) throw new Error('Local resource exceeds byte limit');
            result = { body: buffer.subarray(0, size), mime: MIME[path.extname(actual).toLowerCase()] || '', url };
          } finally { await handle.close(); }
        } else {
          const operation = (options.fetchResource || safeFetch)(url, { signal: controller.signal, maxBytes: limits.maxResourceBytes, timeoutMs: Math.min(5000, deadline - Date.now()), cache: options.cache });
          let stop;
          try { result = await Promise.race([operation, new Promise((_, reject) => { stop = setTimeout(() => reject(new Error('Resource fetch time budget exceeded')), Math.max(1, deadline - Date.now())); })]); } finally { clearTimeout(stop); }
        }
        check(depth);
        result = { ...result, body: Buffer.from(result.body), mime: String(result.mime || result.contentType || '').split(';')[0].toLowerCase(), url: result.url || url };
        if (result.body.length > limits.maxResourceBytes) throw new Error('Resource exceeds byte limit');
        total += result.body.length; if (total > limits.maxTotalBytes) throw new Error('Build total resource byte budget exceeded');
        return result;
      })());
    }
    const r = await resources.get(url);
    const allowed = kind === 'css' ? /^text\/css$/ : kind === 'js' ? /^(text|application)\/(javascript|ecmascript|x-javascript)$/ : /^(image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd.microsoft.icon)|font\/(woff2?|ttf|otf)|application\/(font-woff|vnd.ms-fontobject|x-font-ttf))$/;
    if (!allowed.test(r.mime)) throw new Error(`Unsafe or incorrect ${kind} MIME: ${r.mime || '(missing)'}`);
    return r;
  }
  async function asset(ref, from, depth, font = false) {
    if (!ref || ref.startsWith('#') || /^__DSH_WIDGET_ASSET_\d+__$/.test(ref)) return ref;
    try {
      let r;
      if (/^data:/i.test(ref)) {
        const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(ref);
        if (!m) throw new Error('Malformed data URI');
        r = { mime: m[1].toLowerCase(), body: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
        if (!/^(image\/(png|jpeg|gif|webp|svg\+xml|x-icon)|font\/(woff2?|ttf|otf))$/.test(r.mime)) throw new Error('Unsafe data URI MIME');
        if (r.body.length > limits.maxResourceBytes) throw new Error('Data asset exceeds byte limit');
      } else r = await load(resolve(ref, from), 'asset', depth);
      if (r.mime === 'image/svg+xml') {
        const svg = parseFragment(r.body.toString('utf8'));
        await walk(svg, r.url || from, depth + 1);
        let markup = serialize(svg);
        for (const nested of assets) markup = markup.split(nested.token).join(nested.data);
        r.body = Buffer.from(markup);
      }
      const token = `__DSH_WIDGET_ASSET_${assets.length}__`;
      assets.push({ token, data: `data:${r.mime};base64,${r.body.toString('base64')}`, svgMarkup: r.mime === 'image/svg+xml' ? r.body.toString('utf8') : null, size: r.body.length, font: font || r.mime.startsWith('font/'), omitted: false });
      return token;
    } catch (e) { warn(`Optional resource omitted: ${ref.slice(0, 120)} (${e.message})`); return ''; }
  }
  async function css(input, from, depth, stack = []) {
    check(depth);
    const tree = postcss.parse(input, { from: undefined });
    const imports = []; tree.walkAtRules(n => { n.name = unescapeCSS(n.name); if (n.name.toLowerCase() === 'charset') n.remove(); else if (n.name.toLowerCase() === 'import') imports.push(n); });
    for (const n of imports) {
      const parsed = valueParser(n.params); const first = parsed.nodes.find(x => x.type !== 'space' && x.type !== 'comment');
      let ref;
      if (first?.type === 'string') ref = first.value;
      else if (first?.type === 'function' && first.value.toLowerCase() === 'url') ref = valueParser.stringify(first.nodes).replace(/^['"]|['"]$/g, '');
      if (!ref) throw new Error('Unsupported CSS @import: expected literal URL');
      const url = resolve(ref, from); if (stack.includes(url)) throw new Error('CSS @import cycle detected');
      const r = await load(url, 'css', depth + 1);
      const nested = await css(r.body.toString('utf8'), r.url, depth + 1, [...stack, url]);
      const rest = valueParser.stringify(parsed.nodes.slice(parsed.nodes.indexOf(first) + 1)).trim();
      if (/\b(layer|supports)\b/i.test(rest)) throw new Error('CSS @import layer()/supports() qualifiers are not supported; inline this import explicitly');
      n.replaceWith(...postcss.parse(rest ? `@media ${rest}{${nested}}` : nested).nodes);
    }
    const declarations = []; tree.walkDecls(d => declarations.push(d));
    for (const d of declarations) {
      const p = valueParser(d.value); const urls = [];
      p.walk(n => { if (n.type === 'function' && unescapeCSS(n.value).toLowerCase() === 'url') { urls.push(n); return false; } if (n.type === 'function' && /image-set$/i.test(n.value)) { for (const child of n.nodes) if (child.type === 'string') urls.push(child); } });
      const font = d.parent?.type === 'atrule' && d.parent.name.toLowerCase() === 'font-face';
      for (const n of urls) {
        const ref = n.type === 'string' ? n.value : valueParser.stringify(n.nodes).trim().replace(/^['"]|['"]$/g, '');
        const data = await asset(ref, from, depth + 1, font);
        if (n.type === 'string') n.value = data; else n.nodes = [{ type: 'string', quote: '"', value: data }];
      }
      d.value = p.toString();
    }
    // Reject unhandled at-rule URL mechanisms rather than leak a runtime URL.
    tree.walkAtRules(n => { if (/url\s*\(/i.test(n.params)) throw new Error(`Unsupported resource URL in @${n.name}`); });
    return tree.toString();
  }
  async function bundle(code, from, depth) {
    netWarnings(code, warn);
    const modules = new Map([['widget-entry', { code, from, depth }]]);
    const result = await esbuild.build({ entryPoints: ['widget-entry'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020', minify: true, legalComments: 'none', logLevel: 'silent', plugins: [{ name: 'guarded-widget-resources', setup(build) {
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.path === 'widget-entry' && !args.importer) return { path: args.path, namespace: 'widget' };
        const parent = modules.get(args.importer);
        if (!parent) throw new Error('Unknown module importer');
        if (!/^(\.{0,2}\/|https?:\/\/|file:)/.test(args.path)) throw new Error(`Unresolved bare module "${args.path}"; import maps/packages unsupported, use explicit relative or public HTTP(S) URL`);
        const url = resolve(args.path, parent.from); check(parent.depth + 1);
        if (!modules.has(url)) { const r = await load(url, 'js', parent.depth + 1); const code = r.body.toString('utf8'); netWarnings(code, warn); modules.set(url, { code, from: r.url, depth: parent.depth + 1 }); }
        return { path: url, namespace: 'widget' };
      });
      build.onLoad({ filter: /.*/, namespace: 'widget' }, args => ({ contents: modules.get(args.path).code, loader: 'js' }));
    } }] });
    const unsafe = result.warnings.filter(w => /import|require|glob/i.test(w.text));
    if (unsafe.length) throw new Error(`Unresolved module dependency: ${unsafe.map(w => w.text).join('; ')}`);
    const output = result.outputFiles[0].text;
    if (/\bimport\s*\(/.test(output) || /\brequire\s*\(/.test(output)) throw new Error('Unresolved runtime module import/require; use literal statically resolvable imports');
    return output;
  }
  async function walk(parent, from, depth) {
    check(depth);
    for (const n of [...(parent.childNodes || [])]) {
      if (n.nodeName === '#comment') { remove(n); continue; }
      if (!n.tagName) continue;
      const tag = n.tagName.toLowerCase();
      if (attr(n, 'srcdoc') !== undefined) throw new Error('Embedded srcdoc documents are unsupported');
      if (['base', 'iframe', 'frame', 'object', 'embed'].includes(tag)) throw new Error(`Unsupported network-capable <${tag}> element`);
      if (tag === 'meta' && /refresh/i.test(attr(n, 'http-equiv') || '')) throw new Error('Meta refresh/navigation is forbidden');
      if (tag === 'link') {
        if ((attr(n, 'rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) {
          const ref = attr(n, 'href'); if (!ref) throw new Error('Stylesheet missing href');
          const url = resolve(ref, from); const r = await load(url, 'css', depth + 1);
          n.nodeName = n.tagName = 'style'; const media = attr(n, 'media'); n.attrs = media ? [{ name: 'media', value: media }] : [];
          text(n, (await css(r.body.toString('utf8'), r.url, depth + 1, [url])).replace(/<\/style/gi, '<\\/style'));
        } else { remove(n); continue; }
      } else if (tag === 'style') text(n, (await css(content(n), from, depth + 1)).replace(/<\/style/gi, '<\\/style'));
      else if (tag === 'script') {
        const type = (attr(n, 'type') || '').toLowerCase();
        if (type === 'importmap') throw new Error('Import maps unsupported; use explicit relative or public HTTP(S) module imports');
        const ref = attr(n, 'src'); let code = content(n); let scriptBase = from;
        if (ref) { const r = await load(resolve(ref, from), 'js', depth + 1); code = r.body.toString('utf8'); scriptBase = r.url; }
        if (!type || /^(module|text\/javascript|application\/javascript)$/.test(type)) {
          netWarnings(code, warn);
          // Bundle modules AND any classic script containing import() so no imports escape.
          if (type === 'module' || /\bimport\s*\(/.test(code)) { code = await bundle(code, scriptBase, depth + 1); set(n, 'type', undefined); }
          else if (/\b(import|export)\s/.test(code) || /\brequire\s*\(/.test(code)) throw new Error('Unresolved module syntax in classic script; mark it type="module"');
          text(n, code.replace(/<\/script/gi, '<\\/script'));
        } else if (ref) throw new Error(`Unsupported external script type: ${type}`);
        for (const key of ['src', 'integrity', 'crossorigin', 'async', 'defer']) set(n, key, undefined);
      }
      if (attr(n, 'style') !== undefined) {
        const rule = await css(`x{${attr(n, 'style')}}`, from, depth + 1); set(n, 'style', rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')));
      }
      for (const a of [...(n.attrs || [])]) {
        if (/^on/i.test(a.name)) netWarnings(a.value, warn);
        if (['srcset', 'imagesrcset'].includes(a.name)) {
          // HTML srcset uses commas inside data URLs. Refuse ambiguous lists instead of misresolving them.
          if (/data:/i.test(a.value)) { set(n, a.name, undefined); warn('Optional data-URI srcset omitted; use src instead'); continue; }
          const candidates = a.value.split(',').map(s => s.trim()).filter(Boolean); const out = [];
          for (const candidate of candidates) { const m = /^(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?$/.exec(candidate); if (!m) throw new Error('Malformed srcset candidate'); const data = await asset(m[1], from, depth + 1); if (data) out.push(data + (m[2] ? ` ${m[2]}` : '')); }
          set(n, a.name, out.length ? out.join(', ') : undefined);
        } else if (['src', 'poster', 'background'].includes(a.name) || ((a.name === 'href' || a.name === 'xlink:href') && !['a', 'link'].includes(tag))) {
          if (tag === 'script') continue;
          const data = await asset(a.value, from, depth + 1); set(n, a.name, data || undefined);
        } else if (['action', 'formaction', 'ping', 'manifest', 'codebase', 'archive', 'profile', 'longdesc'].includes(a.name) || (tag === 'a' && a.name === 'href' && !a.value.startsWith('#'))) {
          set(n, a.name, undefined); warn('Navigation/network attributes removed');
        }
      }
      if (tag === 'img' && !attr(n, 'srcset')) {
        const a = assets.find(a => a.token === attr(n, 'src') && a.svgMarkup);
        if (a) {
          const svg = parseFragment(a.svgMarkup).childNodes.find(c => c.tagName === 'svg');
          if (!svg) throw new Error('SVG resource has no root <svg>');
          for (const key of ['class', 'id', 'width', 'height', 'style', 'role']) if (attr(n, key) !== undefined) set(svg, key, attr(n, key));
          if (attr(n, 'alt')) set(svg, 'aria-label', attr(n, 'alt'));
          a.inlineSVGToken = `__DSH_WIDGET_SVG_${assets.indexOf(a)}__`;
          a.svgMarkup = serialize({ nodeName: '#document-fragment', childNodes: [svg] });
          n.parentNode.childNodes[n.parentNode.childNodes.indexOf(n)] = { nodeName: '#text', value: a.inlineSVGToken, parentNode: n.parentNode };
        }
      }
      if (n.content) await walk(n.content, from, depth);
      if (tag !== 'script' && tag !== 'style' && tag !== 'link') await walk(n, from, depth);
    }
  }
  try {
    const doc = parse(options.html);
    await walk(doc, base, 0);
    function render() {
      let html = serialize(doc);
      for (const a of assets) if (a.inlineSVGToken) html = html.split(a.inlineSVGToken).join(a.omitted ? '' : a.svgMarkup);
      // SVGs can refer to nested asset tokens; replace in reverse discovery order repeatedly.
      for (let round = 0; round <= limits.maxDepth; round++) {
        let changed = false;
        for (const a of assets) if (html.includes(a.token)) { html = html.split(a.token).join(a.omitted ? '' : a.data); changed = true; }
        if (!changed) break;
      }
      return { html, rawBytes: Buffer.byteLength(html), compressedBytes: deflateSync(html, { level: 9 }).length };
    }
    let result = render();
    const over = () => result.rawBytes > limits.maxRawBytes || result.compressedBytes > limits.maxCompressedBytes;
    for (const a of [...assets].sort((a, b) => Number(b.font) - Number(a.font) || b.size - a.size || assets.indexOf(a) - assets.indexOf(b))) {
      if (!over()) break; a.omitted = true; warn(`Optional ${a.font ? 'font' : 'image'} omitted to fit widget budget`); result = render();
    }
    if (over()) throw new Error(`Compiled widget exceeds budget: ${result.rawBytes}/${limits.maxRawBytes} raw bytes, ${result.compressedBytes}/${limits.maxCompressedBytes} zlib-9 bytes; required CSS/JS cannot be omitted`);
    check();
    return { ...result, hash: createHash('sha256').update(result.html).digest('hex'), warnings };
  } catch (e) { throw new Error(`Widget compilation failed: ${e.message}`, { cause: e }); }
  finally { clearTimeout(timer); controller.abort(); }
}
