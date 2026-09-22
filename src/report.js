import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const IMG = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi;
const isInline = (src) => /^(data:|https?:)/i.test(src);

export function inlineImages(html, baseDir) {
  return html.replace(IMG, (m, before, src, after) => {
    if (isInline(src)) return m;
    const file = path.resolve(baseDir, decodeURI(src));
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) return m;
    return `${before}data:${mime};base64,${readFileSync(file).toString('base64')}${after}`;
  });
}

export function unembeddedRefs(html) {
  return [...html.matchAll(IMG)].map((m) => m[2]).filter((s) => !isInline(s));
}

export function summaryFromMarkdown(md, max = 3500) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return '';
  const table = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) table.push(lines[i].trim());
  return table.join('\n').slice(0, max);
}
