import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function makeJobDir(auditsRoot, site, date = new Date()) {
  const base = path.join(auditsRoot, site, 'results', `qa-${localDate(date)}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  mkdirSync(path.join(dir, 'img'), { recursive: true });
  return dir;
}
