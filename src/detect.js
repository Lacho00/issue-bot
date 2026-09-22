import { normalizeHost } from './site-index.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+|\bwww\.[^\s<>"'()[\]{}]+/gi;
const TRAIL = /[.,;:!?¿¡»«"'"')\]]+$/;

export function extractHosts(text, entities) {
  const s = String(text ?? '');
  const raw = [];
  for (const e of entities ?? []) {
    if (e.type === 'url') raw.push(s.slice(e.offset, e.offset + e.length));
    else if (e.type === 'text_link' && e.url) raw.push(e.url);
  }
  for (const m of s.matchAll(URL_RE)) raw.push(m[0].replace(TRAIL, ''));
  return [...new Set(raw.map(normalizeHost).filter(Boolean))];
}

export function matchSite(hosts, index) {
  const sites = [];
  let host = null;
  for (const h of hosts) {
    const site = index.get(h);
    if (!site) continue;
    if (!sites.includes(site)) sites.push(site);
    host ??= h;
  }
  if (sites.length === 1) return { kind: 'one', site: sites[0], host };
  if (sites.length > 1) return { kind: 'many', sites };
  return { kind: 'none' };
}

export function siteQuery(host) {
  const labels = String(host).split('.');
  const pool = (labels.length > 1 ? labels.slice(0, -1) : labels).filter((l) => l !== 'www');
  return pool.reduce((best, l) => (l.length > best.length ? l : best), '');
}
