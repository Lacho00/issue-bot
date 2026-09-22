import { readdirSync } from 'node:fs';
import path from 'node:path';

const VALID = /^[a-z0-9][a-z0-9._-]*$/i;

function listSites(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function suggest(query, sites) {
  const q = query.toLowerCase();
  return sites
    .map((s) => {
      const l = s.toLowerCase();
      const bonus = l.includes(q) || q.includes(l) ? -100 : 0;
      return { s, score: distance(q, l) + bonus };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((x) => x.s);
}

export function resolveSite(name, root) {
  const clean = String(name ?? '').trim();
  const sites = listSites(root);
  if (VALID.test(clean) && sites.includes(clean)) {
    return { ok: true, name: clean, path: path.join(root, clean) };
  }
  return { ok: false, suggestions: clean ? suggest(clean, sites) : sites.slice(0, 5) };
}
