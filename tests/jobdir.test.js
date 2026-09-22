import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeJobDir } from '../src/jobdir.js';

test('crea qa-<fecha> con img/ y añade sufijo si ya existe', () => {
  const audits = mkdtempSync(path.join(tmpdir(), 'audits-'));
  const date = new Date(2026, 8, 21, 10, 0, 0);
  const first = makeJobDir(audits, 'tienda-demo', date);
  assert.equal(first, path.join(audits, 'tienda-demo', 'results', 'qa-2026-09-21'));
  assert.ok(existsSync(path.join(first, 'img')));
  const second = makeJobDir(audits, 'tienda-demo', date);
  assert.equal(second, `${first}-2`);
  const third = makeJobDir(audits, 'tienda-demo', date);
  assert.equal(third, `${first}-3`);
});
