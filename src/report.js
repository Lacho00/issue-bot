import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMG = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi;
const isInline = (src) => /^(data:|https?:)/i.test(src);

export function inlineImages(html, baseDir) {
  const root = path.resolve(baseDir);
  return html.replace(IMG, (m, before, src, after) => {
    if (isInline(src)) return m;
    let file;
    try {
      file = path.resolve(root, decodeURI(src));
    } catch {
      return m;
    }
    if (!file.startsWith(root + path.sep)) return m;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) return m;
    return `${before}data:${mime};base64,${readFileSync(file).toString('base64')}${after}`;
  });
}

export function unembeddedRefs(html) {
  return [...html.matchAll(IMG)].map((m) => m[2]).filter((s) => !isInline(s));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const wrapTables = (html) => html.replace(/<table>[\s\S]*?<\/table>/g, (m) => `<div class="table-wrap">${m}</div>`);

export function renderReport(md, { title } = {}) {
  const body = wrapTables(marked.parse(md ?? ''));
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title ?? 'Informe')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 48rem; margin: 0 auto; padding: 1rem; line-height: 1.5; color: #1a1a1a; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  .table-wrap { overflow-x: auto; }
  code, pre { background: #f4f4f4; border-radius: 4px; }
  pre { overflow-x: auto; padding: 0.6rem; }
  code { padding: 0.1rem 0.3rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function summaryFromMarkdown(md, max = 3500) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return '';
  const table = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) table.push(lines[i].trim());
  return table.join('\n').slice(0, max);
}
