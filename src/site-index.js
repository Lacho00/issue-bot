import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function normalizeHost(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.slice(s.lastIndexOf('@') + 1);
  s = s.replace(/:\d*$/, '').replace(/\.+$/, '').replace(/^www\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function jsonHosts(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const wp = data?.wordpress ?? {};
  const origins = Array.isArray(wp.url_origin) ? wp.url_origin : String(wp.url_origin ?? '').split(/\s+/);
  return [data?.project?.domain, wp.url, ...origins]
    .filter((x) => typeof x === 'string')
    .map(normalizeHost)
    .filter(Boolean);
}

function parseVhosts(text) {
  const blocks = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^<VirtualHost\b/i.test(line)) {
      cur = { hosts: [], docRoot: null };
      continue;
    }
    if (/^<\/VirtualHost>/i.test(line)) {
      if (cur) blocks.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^(ServerName|ServerAlias|DocumentRoot)\s+(.+)$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === 'documentroot') cur.docRoot = m[2].trim().replace(/^"(.*)"$/, '$1');
    else cur.hosts.push(...m[2].trim().split(/\s+/));
  }
  return blocks;
}

function siteFromDocRoot(docRoot, sitesRoot, sites) {
  const rel = path.relative(path.resolve(sitesRoot), path.resolve(docRoot));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const name = rel.split(path.sep)[0];
  return sites.includes(name) ? name : null;
}

export function buildSiteIndex({ sitesRoot, vhostDir }) {
  const index = new Map();
  const add = (host, site) => {
    if (host && !index.has(host)) index.set(host, site);
  };
  const sites = listDirs(sitesRoot);

  for (const site of sites) {
    for (const host of jsonHosts(path.join(sitesRoot, site, '.wp-create.json'))) add(host, site);
  }

  let files = [];
  try {
    files = readdirSync(vhostDir).filter((f) => /^httpd-.+\.conf$/.test(f)).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(path.join(vhostDir, file), 'utf8');
    } catch {
      continue;
    }
    // Un bloque sin DocumentRoot (los -redirect) se asocia al sitio del nombre del fichero.
    const byName = file.match(/^httpd-(.+?)(?:-redirect)?\.conf$/)?.[1];
    const fallback = sites.includes(byName) ? byName : null;
    for (const block of parseVhosts(text)) {
      const site = block.docRoot ? siteFromDocRoot(block.docRoot, sitesRoot, sites) : fallback;
      if (!site) continue;
      for (const h of block.hosts) add(normalizeHost(h), site);
    }
  }
  return index;
}
