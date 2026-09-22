# Bot de Telegram para issues — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un bot de Telegram que recibe issues de un sitio, acuerda un plan con el dueño, aplica el arreglo en local con Claude Code y devuelve un informe HTML de antes y después.

**Architecture:** Proceso Node (grammY) que guarda un único trabajo abierto en `state.json` y lanza `claude -p` como proceso hijo por turno, con `--session-id`/`--resume` para mantener la conversación. Los permisos que no cubre la lista blanca llegan a un servidor MCP stdio (`mcp__bot__aprobar`), que los reenvía al bot por un socket Unix; el bot los convierte en botones de Telegram.

**Tech Stack:** Node 24 (ESM), grammY 1.x, `@modelcontextprotocol/sdk` 1.x, zod, `node:test`. Claude Code 2.1.x ya instalado y autenticado.

**Spec:** `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md`

## Global Constraints

- Un solo usuario autorizado (`OWNER_ID`); cualquier otro remitente y cualquier mensaje reenviado se ignoran sin respuesta.
- Un trabajo abierto a la vez; un turno de Claude a la vez.
- Nunca `git commit`, `git push`, ni instalar Playwright o sus navegadores (`npx playwright install`, `npm i playwright`, `browser_install` del MCP).
- Fix local sin commitear en la rama activa del sitio.
- Carpeta del trabajo: `/home/lacho/audits/<sitio>/results/qa-<AAAA-MM-DD>[-N]/`, capturas en `img/qa-NN.<ext>`.
- Timeout de permiso: 30 min (deniega). Timeout de turno: 45 min (mata el proceso).
- Aviso de contexto a partir de 200 000 tokens.
- Límite de mensaje de Telegram: 4096 caracteres.
- Textos para el dueño en español.
- `.env`, `state.json`, `bot.sock`, `node_modules/` y `.codebase-memory/` fuera de git.
- Sin líneas de atribución a Claude en commits.
- Modo de permisos de Claude: `plan` en análisis, `manual` en implementación (la CLI 2.1.278 no tiene `default`; `manual` es su equivalente).

## Mapa de archivos

| Archivo | Responsabilidad |
|---------|-----------------|
| `package.json` | Dependencias y script `test` |
| `src/config.js` | Leer `.env`, rutas y constantes; escribir `OWNER_ID` |
| `src/telegram-util.js` | Partir mensajes largos |
| `src/auth.js` | Decidir si un mensaje o callback se atiende, se ignora o registra al dueño |
| `src/sites.js` | Resolver `/nuevo <sitio>` y sugerir nombres parecidos |
| `src/jobdir.js` | Crear la carpeta del trabajo |
| `src/state.js` | Máquina de estados del trabajo y persistencia en `state.json` |
| `src/policy.js` | Settings con lista blanca y deny; decisión previa a pedir botón |
| `src/prompts.js` | System prompt por fase y mensaje de usuario a partir de los items |
| `src/runner.js` | Lanzar `claude`, parsear `stream-json`, timeout y cancelación |
| `src/permission-bridge.js` | Socket Unix entre el MCP y el bot (servidor y cliente) |
| `src/mcp-permission.js` | Servidor MCP stdio con la herramienta `aprobar` |
| `src/report.js` | Embeber imágenes en base64 y extraer la tabla resumen |
| `src/bot.js` | Cableado grammY: comandos, contenido, botones, turnos |
| `systemd/issue-bot.service` | Unidad `systemd --user` |
| `tests/*.test.js` | Tests por módulo |
| `tests/fixtures/fake-claude.js` | Binario `claude` falso para el runner |

---

### Task 1: Andamiaje, configuración y partición de mensajes

**Files:**
- Create: `package.json`, `src/config.js`, `src/telegram-util.js`
- Modify: `.gitignore`
- Test: `tests/config.test.js`, `tests/telegram-util.test.js`

**Interfaces:**
- Produces: `parseEnv(text) -> object`, `setEnvValue(text, key, value) -> string`, `loadConfig(envPath?) -> Config` con `{envPath, token, ownerId, sitesRoot, auditsRoot, claudeBin, statePath, socketPath, turnTimeoutMs, permissionTimeoutMs, contextWarnTokens}`, `ROOT`; `splitMessage(text, max = 4096) -> string[]`.

- [ ] **Step 1: Crear `package.json` e instalar dependencias**

```json
{
  "name": "issue-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/bot.js",
    "test": "node --test tests/"
  },
  "engines": { "node": ">=22" }
}
```

Run: `cd /srv/http/issue-bot && npm install grammy@^1.46 @modelcontextprotocol/sdk@^1.30 zod@^4`
Expected: `added N packages`, sin errores.

- [ ] **Step 2: Añadir `bot.sock` al `.gitignore`**

`.gitignore` queda:

```
.env
state.json
bot.sock
node_modules/
.codebase-memory/
```

- [ ] **Step 3: Escribir los tests que fallan**

`tests/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv, setEnvValue, loadConfig } from '../src/config.js';

test('parseEnv lee claves y valores', () => {
  assert.deepEqual(parseEnv('TELEGRAM_TOKEN=abc:1\nOWNER_ID=\n# nota\n'), {
    TELEGRAM_TOKEN: 'abc:1',
    OWNER_ID: '',
  });
});

test('setEnvValue reemplaza una clave existente', () => {
  assert.equal(setEnvValue('A=1\nOWNER_ID=\n', 'OWNER_ID', '42'), 'A=1\nOWNER_ID=42\n');
});

test('setEnvValue añade una clave que falta', () => {
  assert.equal(setEnvValue('A=1\n', 'OWNER_ID', '42'), 'A=1\nOWNER_ID=42\n');
});

test('loadConfig: OWNER_ID vacío es null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=\n');
  const cfg = loadConfig(envPath);
  assert.equal(cfg.token, 't');
  assert.equal(cfg.ownerId, null);
  assert.equal(cfg.turnTimeoutMs, 45 * 60 * 1000);
  assert.equal(cfg.permissionTimeoutMs, 30 * 60 * 1000);
});

test('loadConfig: OWNER_ID numérico', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nOWNER_ID=123\n');
  assert.equal(loadConfig(envPath).ownerId, 123);
});
```

`tests/telegram-util.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from '../src/telegram-util.js';

test('texto corto queda en un trozo', () => {
  assert.deepEqual(splitMessage('hola'), ['hola']);
});

test('texto largo se parte por saltos de línea sin pasar del máximo', () => {
  const text = Array.from({ length: 50 }, (_, i) => `linea ${i}`).join('\n');
  const parts = splitMessage(text, 60);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 60);
  assert.equal(parts.join('\n'), text);
});

test('una línea más larga que el máximo se corta en seco', () => {
  const parts = splitMessage('x'.repeat(130), 50);
  assert.deepEqual(parts.map((p) => p.length), [50, 50, 30]);
});
```

- [ ] **Step 4: Ejecutar y ver que fallan**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/config.js'`.

- [ ] **Step 5: Implementar**

`src/config.js`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function setEnvValue(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  const base = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

export function loadConfig(envPath = path.join(ROOT, '.env')) {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return {
    envPath,
    token: env.TELEGRAM_TOKEN || '',
    ownerId: env.OWNER_ID ? Number(env.OWNER_ID) : null,
    sitesRoot: env.SITES_ROOT || '/srv/http',
    auditsRoot: env.AUDITS_ROOT || '/home/lacho/audits',
    claudeBin: env.CLAUDE_BIN || 'claude',
    statePath: path.join(ROOT, 'state.json'),
    socketPath: env.BOT_SOCKET || path.join(ROOT, 'bot.sock'),
    turnTimeoutMs: 45 * 60 * 1000,
    permissionTimeoutMs: 30 * 60 * 1000,
    contextWarnTokens: 200_000,
  };
}
```

`src/telegram-util.js`:

```js
export function splitMessage(text, max = 4096) {
  if (text.length <= max) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > max) {
      if (current) { parts.push(current); current = ''; }
      for (let i = 0; i < line.length; i += max) parts.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) { parts.push(current); current = line; }
    else current = candidate;
  }
  if (current) parts.push(current);
  return parts;
}
```

Nota: el test de "una línea más larga" pide `[50, 50, 30]`; con el código de arriba se cumple porque la línea se corta en seco sin unir.

- [ ] **Step 6: Ejecutar y ver que pasan**

Run: `npm test`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/config.js src/telegram-util.js tests/
git commit -m "feat: add config loader and message splitter"
```

---

### Task 2: Autorización y registro del dueño

**Files:**
- Create: `src/auth.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `authorizeMessage(msg, ownerId) -> 'allow' | 'ignore' | 'register'`, `authorizeCallback(from, ownerId) -> boolean`.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMessage, authorizeCallback } from '../src/auth.js';

const msg = (over = {}) => ({ from: { id: 7 }, chat: { type: 'private', id: 7 }, text: 'hola', ...over });

test('dueño en privado: allow', () => {
  assert.equal(authorizeMessage(msg(), 7), 'allow');
});

test('otro remitente: ignore', () => {
  assert.equal(authorizeMessage(msg({ from: { id: 8 } }), 7), 'ignore');
});

test('mensaje reenviado del dueño: ignore', () => {
  assert.equal(authorizeMessage(msg({ forward_origin: { type: 'user' } }), 7), 'ignore');
});

test('grupo: ignore aunque sea el dueño', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -1 } }), 7), 'ignore');
});

test('sin OWNER_ID: register en privado', () => {
  assert.equal(authorizeMessage(msg(), null), 'register');
});

test('sin OWNER_ID: un grupo no registra', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -1 } }), null), 'ignore');
});

test('callback: solo el dueño', () => {
  assert.equal(authorizeCallback({ id: 7 }, 7), true);
  assert.equal(authorizeCallback({ id: 8 }, 7), false);
  assert.equal(authorizeCallback({ id: 7 }, null), false);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/auth.test.js`
Expected: FAIL, `Cannot find module '../src/auth.js'`.

- [ ] **Step 3: Implementar**

`src/auth.js`:

```js
export function authorizeMessage(msg, ownerId) {
  if (!msg?.from || msg.chat?.type !== 'private') return 'ignore';
  if (msg.forward_origin || msg.forward_date) return 'ignore';
  if (ownerId == null) return 'register';
  return msg.from.id === ownerId ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId) {
  return ownerId != null && from?.id === ownerId;
}
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/auth.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth.js tests/auth.test.js
git commit -m "feat: add owner-only authorization"
```

---

### Task 3: Resolución del sitio y carpeta del trabajo

**Files:**
- Create: `src/sites.js`, `src/jobdir.js`
- Test: `tests/sites.test.js`, `tests/jobdir.test.js`

**Interfaces:**
- Produces: `resolveSite(name, root) -> {ok: true, name, path} | {ok: false, suggestions: string[]}`; `localDate(date?) -> 'AAAA-MM-DD'`; `makeJobDir(auditsRoot, site, date?) -> string` (ruta absoluta creada, con `img/` dentro).

- [ ] **Step 1: Escribir los tests que fallan**

`tests/sites.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSite } from '../src/sites.js';

function root() {
  const r = mkdtempSync(path.join(tmpdir(), 'sites-'));
  for (const d of ['tienda-demo', 'cien-pinos', 'consultoria-juridica', '.claude']) mkdirSync(path.join(r, d));
  return r;
}

test('nombre exacto resuelve la ruta', () => {
  const r = root();
  assert.deepEqual(resolveSite('tienda-demo', r), { ok: true, name: 'tienda-demo', path: path.join(r, 'tienda-demo') });
});

test('nombre parecido devuelve sugerencias con el más cercano primero', () => {
  const res = resolveSite('consultoria', root());
  assert.equal(res.ok, false);
  assert.equal(res.suggestions[0], 'consultoria-juridica');
});

test('rechaza rutas y carpetas ocultas', () => {
  const r = root();
  assert.equal(resolveSite('../etc', r).ok, false);
  assert.equal(resolveSite('.claude', r).ok, false);
  assert.equal(resolveSite('a/b', r).ok, false);
});
```

`tests/jobdir.test.js`:

```js
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
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/sites.test.js tests/jobdir.test.js`
Expected: FAIL, módulos no encontrados.

- [ ] **Step 3: Implementar**

`src/sites.js`:

```js
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
```

`src/jobdir.js`:

```js
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
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/sites.test.js tests/jobdir.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sites.js src/jobdir.js tests/sites.test.js tests/jobdir.test.js
git commit -m "feat: resolve site folder and create job directory"
```

---

### Task 4: Máquina de estados y persistencia

**Files:**
- Create: `src/state.js`
- Test: `tests/state.test.js`

**Interfaces:**
- Produces: clase `Store(file)` con:
  - `job` (objeto o `null`): `{site, sitePath, jobDir, sessionId, phase, started, pending, imageCount, contextTokens}`; `phase ∈ 'collecting' | 'plan' | 'implement' | 'reported'`; `pending` es un array de items `{type: 'text', text}` o `{type: 'image', path}`.
  - `load() -> job|null`, `save()`
  - `open({site, sitePath, jobDir, sessionId})`
  - `addPending(item)`, `takePending() -> item[]`
  - `startPlan()` (desde `collecting` o `reported`; exige `pending` no vacío)
  - `approve()` (solo desde `plan`)
  - `finishImplement()` (solo desde `implement`)
  - `markStarted()`, `setContextTokens(n)`
  - `nextImageName(ext) -> 'qa-01.jpg'`
  - `close()`
- Produces: clase `StateError` con `code`: `'no-job' | 'job-open' | 'bad-phase' | 'empty'`.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, StateError } from '../src/state.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'state-')), 'state.json');
const base = { site: 's', sitePath: '/srv/http/s', jobDir: '/tmp/j', sessionId: '00000000-0000-4000-8000-000000000000' };

test('recorrido completo', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.job.phase, 'collecting');
  st.addPending({ type: 'text', text: 'issue 1' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.deepEqual(st.takePending(), [{ type: 'text', text: 'issue 1' }]);
  assert.deepEqual(st.job.pending, []);
  st.approve();
  assert.equal(st.job.phase, 'implement');
  st.finishImplement();
  assert.equal(st.job.phase, 'reported');
  st.addPending({ type: 'text', text: 'corrige esto' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  st.close();
  assert.equal(st.job, null);
});

test('transiciones inválidas', () => {
  const st = new Store(file());
  assert.throws(() => st.startPlan(), (e) => e instanceof StateError && e.code === 'no-job');
  st.open(base);
  assert.throws(() => st.open(base), (e) => e.code === 'job-open');
  assert.throws(() => st.startPlan(), (e) => e.code === 'empty');
  assert.throws(() => st.approve(), (e) => e.code === 'bad-phase');
  assert.throws(() => st.finishImplement(), (e) => e.code === 'bad-phase');
});

test('persistencia: otro Store lee el mismo trabajo', () => {
  const f = file();
  const a = new Store(f);
  a.open(base);
  a.addPending({ type: 'text', text: 'x' });
  a.markStarted();
  const b = new Store(f);
  b.load();
  assert.equal(b.job.site, 's');
  assert.equal(b.job.started, true);
  assert.equal(b.job.pending.length, 1);
});

test('nombres de captura correlativos', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.nextImageName('jpg'), 'qa-01.jpg');
  assert.equal(st.nextImageName('png'), 'qa-02.png');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/state.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Implementar**

`src/state.js`:

```js
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export class StateError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.job = null;
  }

  load() {
    this.job = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')).job ?? null : null;
    return this.job;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ job: this.job }, null, 2));
    renameSync(tmp, this.file);
  }

  #require(...phases) {
    if (!this.job) throw new StateError('no-job');
    if (phases.length && !phases.includes(this.job.phase)) throw new StateError('bad-phase');
  }

  open({ site, sitePath, jobDir, sessionId }) {
    if (this.job) throw new StateError('job-open');
    this.job = { site, sitePath, jobDir, sessionId, phase: 'collecting', started: false, pending: [], imageCount: 0, contextTokens: 0 };
    this.save();
  }

  addPending(item) {
    this.#require();
    this.job.pending.push(item);
    this.save();
  }

  takePending() {
    this.#require();
    const items = this.job.pending;
    this.job.pending = [];
    this.save();
    return items;
  }

  startPlan() {
    this.#require('collecting', 'reported');
    if (this.job.pending.length === 0) throw new StateError('empty');
    this.job.phase = 'plan';
    this.save();
  }

  approve() {
    this.#require('plan');
    this.job.phase = 'implement';
    this.save();
  }

  finishImplement() {
    this.#require('implement');
    this.job.phase = 'reported';
    this.save();
  }

  markStarted() {
    this.#require();
    this.job.started = true;
    this.save();
  }

  setContextTokens(n) {
    this.#require();
    this.job.contextTokens = n;
    this.save();
  }

  nextImageName(ext) {
    this.#require();
    this.job.imageCount += 1;
    this.save();
    return `qa-${String(this.job.imageCount).padStart(2, '0')}.${ext}`;
  }

  close() {
    this.job = null;
    this.save();
  }
}
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/state.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state.js tests/state.test.js
git commit -m "feat: add job state machine with persistence"
```

---

### Task 5: Política de permisos

**Files:**
- Create: `src/policy.js`
- Test: `tests/policy.test.js`

**Interfaces:**
- Produces: `buildSettings({sitePath, jobDir}) -> {permissions: {allow: string[], deny: string[]}}`; `decidePermission(toolName, input) -> {action: 'ask'} | {action: 'deny', message}`; `describeRequest(toolName, input) -> string`.

Contexto: las reglas `allow` hacen que Claude no pregunte. Lo que no está en `allow` llega a la herramienta `mcp__bot__aprobar`. Las rutas absolutas en reglas de settings llevan doble barra (`//srv/http/...`). `decidePermission` es la segunda capa: deniega sin preguntar lo prohibido aunque se colara por una regla del usuario, y lo que Claude intenta usar para hablar con el dueño (`ExitPlanMode`, `AskUserQuestion`), porque el dueño responde por Telegram.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/policy.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings, decidePermission, describeRequest } from '../src/policy.js';

test('settings permiten editar solo en el sitio y en la carpeta del trabajo', () => {
  const s = buildSettings({ sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21' });
  assert.ok(s.permissions.allow.includes('Edit(//srv/http/tienda-demo/**)'));
  assert.ok(s.permissions.allow.includes('Write(//home/lacho/audits/tienda-demo/results/qa-2026-09-21/**)'));
  assert.ok(!s.permissions.allow.some((r) => r.startsWith('Edit(//srv/http/**')));
  assert.ok(s.permissions.allow.includes('Bash(npm run build)'));
  assert.ok(s.permissions.deny.includes('Bash(git commit:*)'));
  assert.ok(s.permissions.deny.includes('Bash(git push:*)'));
  assert.ok(s.permissions.deny.includes('Bash(npx playwright install:*)'));
});

test('segunda capa deniega commit, push e instalación de Playwright', () => {
  for (const command of ['git commit -m x', 'cd a && git push', 'npx playwright install chromium', 'npm i -D playwright', 'npm install @playwright/test']) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
  assert.equal(decidePermission('mcp__playwright__browser_install', {}).action, 'deny');
});

test('ExitPlanMode y AskUserQuestion se deniegan con instrucción', () => {
  const a = decidePermission('ExitPlanMode', { plan: 'x' });
  assert.equal(a.action, 'deny');
  assert.match(a.message, /Telegram/);
  assert.equal(decidePermission('AskUserQuestion', {}).action, 'deny');
});

test('lo demás se pregunta', () => {
  assert.deepEqual(decidePermission('Bash', { command: 'wp option update blogname x' }), { action: 'ask' });
  assert.deepEqual(decidePermission('Edit', { file_path: '/etc/hosts' }), { action: 'ask' });
});

test('describeRequest resume comando o ruta', () => {
  assert.equal(describeRequest('Bash', { command: 'npm install' }), 'Bash: npm install');
  assert.equal(describeRequest('Edit', { file_path: '/etc/hosts' }), 'Edit: /etc/hosts');
  assert.ok(describeRequest('Otro', { a: 'x'.repeat(2000) }).length <= 700);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/policy.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Implementar**

`src/policy.js`:

```js
const abs = (p) => `/${p}`;

export function buildSettings({ sitePath, jobDir }) {
  const dirs = [sitePath, jobDir];
  return {
    permissions: {
      allow: [
        'Read',
        'Glob',
        'Grep',
        ...dirs.flatMap((d) => [`Edit(${abs(d)}/**)`, `Write(${abs(d)}/**)`, `MultiEdit(${abs(d)}/**)`]),
        'Bash(npm run build)',
        'Bash(npm run build:*)',
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(wp option get:*)',
        'Bash(wp option list:*)',
        'Bash(wp post list:*)',
        'Bash(wp post get:*)',
        'Bash(wp post meta get:*)',
        'Bash(wp post meta list:*)',
        'Bash(wp theme list:*)',
        'Bash(wp plugin list:*)',
        'Bash(chromium --headless:*)',
        'mcp__playwright',
        'mcp__codebase-memory-mcp',
      ],
      deny: [
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(npx playwright install:*)',
        'Bash(npm i playwright:*)',
        'Bash(npm install playwright:*)',
        'mcp__playwright__browser_install',
      ],
    },
  };
}

const FORBIDDEN = [
  /\bgit\s+(commit|push)\b/,
  /\bplaywright\s+install\b/,
  /\bnpm\s+(i|install|add)\b[^&|;]*playwright/,
];

export function decidePermission(toolName, input = {}) {
  if (toolName === 'ExitPlanMode' || toolName === 'AskUserQuestion') {
    return { action: 'deny', message: 'El dueño responde por Telegram. Termina tu respuesta con el plan o la pregunta en texto.' };
  }
  if (toolName === 'mcp__playwright__browser_install') {
    return { action: 'deny', message: 'Prohibido instalar navegadores. Usa el chromium existente.' };
  }
  if (toolName === 'Bash' && FORBIDDEN.some((re) => re.test(input.command ?? ''))) {
    return { action: 'deny', message: 'Comando prohibido en este bot: sin commit, sin push, sin instalar Playwright.' };
  }
  return { action: 'ask' };
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'Bash') return `Bash: ${input.command ?? ''}`.slice(0, 700);
  if (input.file_path) return `${toolName}: ${input.file_path}`;
  return `${toolName}: ${JSON.stringify(input)}`.slice(0, 700);
}
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/policy.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/policy.js tests/policy.test.js
git commit -m "feat: add permission allowlist and deny rules"
```

---

### Task 6: Prompts por fase

**Files:**
- Create: `src/prompts.js`
- Test: `tests/prompts.test.js`

**Interfaces:**
- Produces: `systemPrompt({phase, site, sitePath, jobDir}) -> string` (`phase ∈ 'plan' | 'implement'`); `userMessage(items) -> string`.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/prompts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, userMessage } from '../src/prompts.js';

const ctx = { site: 'tienda-demo', sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21' };

test('plan: solo lectura, formato de plan y valores medidos', () => {
  const p = systemPrompt({ ...ctx, phase: 'plan' });
  assert.match(p, /no edites/i);
  assert.match(p, /Causa/);
  assert.match(p, /getComputedStyle/);
  assert.match(p, /tienda-demo/);
});

test('implement: solo lo aprobado, informe en la carpeta del trabajo', () => {
  const p = systemPrompt({ ...ctx, phase: 'implement' });
  assert.match(p, /solo lo aprobado/i);
  assert.match(p, /informe\.html/);
  assert.match(p, /qa-2026-09-21/);
  assert.match(p, /sin commitear/i);
});

test('userMessage junta textos y rutas de capturas', () => {
  const m = userMessage([
    { type: 'text', text: '1. flechas pixeladas' },
    { type: 'image', path: '/x/img/qa-01.jpg' },
  ]);
  assert.match(m, /1\. flechas pixeladas/);
  assert.match(m, /\/x\/img\/qa-01\.jpg/);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/prompts.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Implementar**

`src/prompts.js`:

```js
const COMMON = ({ site, sitePath, jobDir }) => `
Trabajas en modo desatendido para un bot de Telegram. El dueño solo te lee por Telegram.
Sitio: ${site} (${sitePath}). Carpeta del trabajo: ${jobDir}. Capturas del dueño: ${jobDir}/img/.
Escribe en español, frases cortas, sin tablas decorativas. Telegram no renderiza Markdown complejo:
usa listas simples y bloques de código cortos.
Nunca hagas git commit ni git push. Nunca instales Playwright ni navegadores.
Si necesitas algo del dueño, pregúntalo en texto al final de tu respuesta.`;

const PLAN = `
FASE: PLAN (solo lectura). No edites ni crees archivos.
Lee las capturas con Read. Investiga el código (usa el grafo codebase-memory antes de grep) y,
si hace falta, abre el sitio local en el navegador y mide.
Responde con un plan numerado, un bloque por issue:
N. <título corto>
Causa: <causa probable>
Arreglo: <qué vas a cambiar>
Archivos: <rutas>
En todo cambio visual incluye los valores medidos con getComputedStyle y getBoundingClientRect
(escritorio y móvil) y el valor que propones.
Si un issue no es de código, dilo y explica qué hay que revisar.
El dueño aprueba con un botón; no llames a ExitPlanMode.`;

const IMPLEMENT = ({ jobDir }) => `
FASE: IMPLEMENTACIÓN. Aplica solo lo aprobado en el plan de esta conversación.
Deja los cambios sin commitear en la rama activa. Si el tema tiene build (npm run build), ejecútalo.
En cada cambio visual mide antes y después con getComputedStyle y getBoundingClientRect en
escritorio y móvil, en todos los elementos que compartan la clase. Si no coincide con lo esperado,
para y pregunta.
Haz capturas del «Después» en ${jobDir}/img/ con nombres NN-descripcion.png.
Al terminar escribe ${jobDir}/informe.md e ${jobDir}/informe.html:
- Título «QA <fecha>: correcciones», párrafo de contexto (dónde y cómo se probó, estado de git).
- Tabla resumen: #, Issue, Estado (Corregido / Mitigado / No es de código / Pendiente).
- Por issue: Antes (captura qa-NN), Causa, Arreglo, Después (captura nueva).
- En el HTML, imágenes con rutas relativas img/..., CSS inline, legible en móvil.
Termina tu respuesta con un resumen de 3 a 6 líneas.`;

export function systemPrompt({ phase, ...ctx }) {
  const body = phase === 'implement' ? IMPLEMENT(ctx) : PLAN;
  return `${COMMON(ctx)}\n${body}`.trim();
}

export function userMessage(items) {
  return items
    .map((it) => (it.type === 'image' ? `[Captura: ${it.path}]` : it.text))
    .join('\n\n');
}
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/prompts.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/prompts.js tests/prompts.test.js
git commit -m "feat: add per-phase prompts"
```

---

### Task 7: Runner de `claude`

**Files:**
- Create: `src/runner.js`, `tests/fixtures/fake-claude.js`
- Test: `tests/runner.test.js`

**Interfaces:**
- Consumes: nada de tareas previas (recibe settings, prompt y config ya construidos).
- Produces:
  - `buildArgs({sessionId, resume, mode, systemPrompt, settings, mcpConfig}) -> string[]`
  - `startTurn({bin, cwd, args, prompt, timeoutMs, env, onEvent}) -> {promise, kill}`; `promise` resuelve `{ok, text, isError, timedOut, killed, sessionSeen, contextTokens, exitCode, stderr}`. `onEvent(event)` recibe cada objeto JSON del stream.
  - `statusFromEvent(event) -> string | null` (texto corto para el mensaje de estado).

- [ ] **Step 1: Crear el binario falso**

`tests/fixtures/fake-claude.js`:

```js
#!/usr/bin/env node
const mode = process.env.FAKE_MODE || 'ok';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (mode === 'crash') { process.stderr.write('boom\n'); process.exit(2); }
  emit({ type: 'system', subtype: 'init', session_id: 'abc' });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/functions.php' } }] } });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'error') {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Usage limit reached', usage: {} });
    return;
  }
  emit({
    type: 'result', subtype: 'success', is_error: false, result: `eco: ${input}`,
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 50 },
  });
});
```

Run: `chmod +x tests/fixtures/fake-claude.js`

- [ ] **Step 2: Escribir los tests que fallan**

`tests/runner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildArgs, startTurn, statusFromEvent } from '../src/runner.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
const run = (mode, extra = {}) => startTurn({
  bin: FAKE, cwd: process.cwd(), args: [], prompt: 'hola', timeoutMs: 2000,
  env: { FAKE_MODE: mode }, onEvent: () => {}, ...extra,
});

test('buildArgs: primer turno usa --session-id, luego --resume', () => {
  const common = { sessionId: 'u', mode: 'plan', systemPrompt: 'sp', settings: { a: 1 }, mcpConfig: { mcpServers: {} } };
  const first = buildArgs({ ...common, resume: false });
  assert.deepEqual(first.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'u']);
  assert.ok(first.includes('--permission-prompt-tool'));
  assert.equal(first[first.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(first[first.indexOf('--settings') + 1], '{"a":1}');
  const next = buildArgs({ ...common, resume: true });
  assert.equal(next[next.indexOf('--resume') + 1], 'u');
  assert.ok(!next.includes('--session-id'));
});

test('turno correcto devuelve texto, sesión y tokens de contexto', async () => {
  const events = [];
  const r = await run('ok', { onEvent: (e) => events.push(e.type) }).promise;
  assert.equal(r.ok, true);
  assert.equal(r.text, 'eco: hola');
  assert.equal(r.sessionSeen, true);
  assert.equal(r.contextTokens, 1015);
  assert.deepEqual(events, ['system', 'assistant', 'result']);
});

test('error del resultado se marca isError', async () => {
  const r = await run('error').promise;
  assert.equal(r.ok, false);
  assert.equal(r.isError, true);
  assert.match(r.text, /limit/);
});

test('crash sin resultado', async () => {
  const r = await run('crash').promise;
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /boom/);
  assert.equal(r.sessionSeen, false);
});

test('timeout mata el proceso', async () => {
  const r = await run('hang', { timeoutMs: 300 }).promise;
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
});

test('kill cancela el turno', async () => {
  const t = run('hang', { timeoutMs: 5000 });
  setTimeout(() => t.kill(), 200);
  const r = await t.promise;
  assert.equal(r.killed, true);
});

test('statusFromEvent describe herramientas', () => {
  const e = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/functions.php' } }] } };
  assert.equal(statusFromEvent(e), 'Read functions.php');
  assert.equal(statusFromEvent({ type: 'system' }), null);
});
```

- [ ] **Step 3: Ejecutar y ver que fallan**

Run: `node --test tests/runner.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 4: Implementar**

`src/runner.js`:

```js
import { spawn } from 'node:child_process';
import path from 'node:path';

export function buildArgs({ sessionId, resume, mode, systemPrompt, settings, mcpConfig }) {
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    resume ? '--resume' : '--session-id', sessionId,
    '--permission-mode', mode,
    '--append-system-prompt', systemPrompt,
    '--settings', JSON.stringify(settings),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--permission-prompt-tool', 'mcp__bot__aprobar',
  ];
}

export function statusFromEvent(event) {
  if (event?.type !== 'assistant') return null;
  const tool = event.message?.content?.find((c) => c.type === 'tool_use');
  if (!tool) return null;
  const i = tool.input ?? {};
  const detail = i.file_path ? path.basename(i.file_path) : (i.command ?? i.pattern ?? '').slice(0, 60);
  return `${tool.name} ${detail}`.trim();
}

export function startTurn({ bin, cwd, args, prompt, timeoutMs, env = {}, onEvent = () => {} }) {
  const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let killed = false;
  let timedOut = false;
  let result = null;
  let sessionSeen = false;
  let stderr = '';
  let buf = '';

  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);

  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'system' && event.subtype === 'init') sessionSeen = true;
      if (event.type === 'result') result = event;
      onEvent(event);
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(prompt);

  const promise = new Promise((resolve) => {
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const u = result?.usage ?? {};
      resolve({
        ok: !!result && !result.is_error && !timedOut && !killed,
        text: result?.result ?? '',
        isError: !!result?.is_error,
        timedOut,
        killed,
        sessionSeen,
        contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        exitCode,
        stderr: stderr.slice(-2000),
      });
    });
  });

  return { promise, kill: () => { killed = true; child.kill('SIGTERM'); } };
}
```

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `node --test tests/runner.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/runner.js tests/runner.test.js tests/fixtures/fake-claude.js
git commit -m "feat: add claude runner with stream-json parsing and timeout"
```

---

### Task 8: Puente de permisos y servidor MCP

**Files:**
- Create: `src/permission-bridge.js`, `src/mcp-permission.js`
- Test: `tests/permission.test.js`

**Interfaces:**
- Produces:
  - `startBridge(socketPath, handler) -> Promise<net.Server>`; `handler({tool_name, input}) -> Promise<{behavior: 'allow' | 'deny', message?}>`.
  - `requestPermission(socketPath, {tool_name, input}) -> Promise<{behavior, message?}>`.
  - `src/mcp-permission.js`: servidor MCP stdio llamado `bot` con la herramienta `aprobar`. Lee `BOT_SOCKET` del entorno. Devuelve texto JSON `{"behavior":"allow","updatedInput":<input>}` o `{"behavior":"deny","message":"..."}`, que es el formato que espera `--permission-prompt-tool`.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/permission.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startBridge, requestPermission } from '../src/permission-bridge.js';

const sock = () => path.join(mkdtempSync(path.join(tmpdir(), 'sock-')), 'b.sock');
const MCP = fileURLToPath(new URL('../src/mcp-permission.js', import.meta.url));

test('puente: la respuesta del handler vuelve al cliente', async () => {
  const s = sock();
  const server = await startBridge(s, async (req) => (req.tool_name === 'Bash' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' }));
  assert.deepEqual(await requestPermission(s, { tool_name: 'Bash', input: {} }), { behavior: 'allow' });
  assert.deepEqual(await requestPermission(s, { tool_name: 'Edit', input: {} }), { behavior: 'deny', message: 'no' });
  server.close();
});

test('puente: un handler que lanza error deniega', async () => {
  const s = sock();
  const server = await startBridge(s, async () => { throw new Error('fallo'); });
  const r = await requestPermission(s, { tool_name: 'Bash', input: {} });
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /fallo/);
  server.close();
});

async function callMcp(socketPath, args) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, BOT_SOCKET: socketPath } }));
  const tools = await client.listTools();
  const res = await client.callTool({ name: 'aprobar', arguments: args });
  await client.close();
  return { tools: tools.tools.map((t) => t.name), payload: JSON.parse(res.content[0].text) };
}

test('MCP: allow devuelve updatedInput', async () => {
  const s = sock();
  const server = await startBridge(s, async () => ({ behavior: 'allow' }));
  const { tools, payload } = await callMcp(s, { tool_name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(tools, ['aprobar']);
  assert.deepEqual(payload, { behavior: 'allow', updatedInput: { command: 'ls' } });
  server.close();
});

test('MCP: sin bot escuchando deniega', async () => {
  const { payload } = await callMcp(sock(), { tool_name: 'Bash', input: { command: 'ls' } });
  assert.equal(payload.behavior, 'deny');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/permission.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Implementar el puente**

`src/permission-bridge.js`:

```js
import net from 'node:net';
import { rmSync, chmodSync } from 'node:fs';

export function startBridge(socketPath, handler) {
  rmSync(socketPath, { force: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        Promise.resolve()
          .then(() => handler(req))
          .catch((e) => ({ behavior: 'deny', message: `Error del bot: ${e.message}` }))
          .then((res) => { if (!sock.destroyed) sock.write(`${JSON.stringify(res)}\n`); });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}

export function requestPermission(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
  });
}
```

- [ ] **Step 4: Implementar el servidor MCP**

`src/mcp-permission.js`:

```js
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { requestPermission } from './permission-bridge.js';

const server = new McpServer({ name: 'bot', version: '0.1.0' });

server.registerTool(
  'aprobar',
  {
    description: 'Pide permiso al dueño por Telegram para usar una herramienta.',
    inputSchema: {
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      tool_use_id: z.string().optional(),
    },
  },
  async ({ tool_name, input }) => {
    let res;
    try {
      res = await requestPermission(process.env.BOT_SOCKET, { tool_name, input });
    } catch (e) {
      res = { behavior: 'deny', message: `Sin respuesta del bot: ${e.message}` };
    }
    const payload = res.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: res.message || 'Denegado por el dueño.' };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `node --test tests/permission.test.js`
Expected: PASS, 4 tests. Si `registerTool` rechaza el esquema zod 4, instalar `zod@^3.25` y repetir; anotar la versión usada en el commit.

- [ ] **Step 6: Commit**

```bash
git add src/permission-bridge.js src/mcp-permission.js tests/permission.test.js
git commit -m "feat: add MCP permission prompt tool bridged over a unix socket"
```

---

### Task 9: Informe autocontenido

**Files:**
- Create: `src/report.js`
- Test: `tests/report.test.js`

**Interfaces:**
- Produces: `inlineImages(html, baseDir) -> string`; `unembeddedRefs(html) -> string[]`; `summaryFromMarkdown(md, max = 3500) -> string`.

- [ ] **Step 1: Escribir los tests que fallan**

`tests/report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inlineImages, unembeddedRefs, summaryFromMarkdown } from '../src/report.js';

test('embebe imágenes locales y deja las externas', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  mkdirSync(path.join(dir, 'img'));
  writeFileSync(path.join(dir, 'img', 'a.png'), Buffer.from([1, 2, 3]));
  const html = '<img src="img/a.png" alt=""><img alt="x" src="https://e.com/b.png">';
  const out = inlineImages(html, dir);
  assert.match(out, /src="data:image\/png;base64,AQID"/);
  assert.match(out, /https:\/\/e\.com\/b\.png/);
  assert.deepEqual(unembeddedRefs(out), []);
});

test('una imagen que no existe queda como referencia sin embeber', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rep-'));
  const out = inlineImages('<img src="img/falta.jpg">', dir);
  assert.deepEqual(unembeddedRefs(out), ['img/falta.jpg']);
});

test('summaryFromMarkdown extrae la primera tabla', () => {
  const md = '# QA\n\ntexto\n\n| # | Issue | Estado |\n|---|---|---|\n| 1 | Flechas | Corregido |\n\n## 1. Flechas\n';
  assert.equal(summaryFromMarkdown(md), '| # | Issue | Estado |\n|---|---|---|\n| 1 | Flechas | Corregido |');
});

test('summaryFromMarkdown sin tabla devuelve cadena vacía', () => {
  assert.equal(summaryFromMarkdown('# QA\n\nnada'), '');
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `node --test tests/report.test.js`
Expected: FAIL, módulo no encontrado.

- [ ] **Step 3: Implementar**

`src/report.js`:

```js
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
```

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `node --test tests/report.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/report.js tests/report.test.js
git commit -m "feat: inline report images and extract summary table"
```

---

### Task 10: Cableado del bot

**Files:**
- Create: `src/bot.js`
- Test: comprobación de arranque manual (el cableado de grammY no lleva test unitario; la lógica ya está probada en los módulos).

**Interfaces:**
- Consumes: todo lo anterior: `loadConfig`, `setEnvValue`, `splitMessage`, `authorizeMessage`, `authorizeCallback`, `resolveSite`, `makeJobDir`, `localDate`, `Store`, `StateError`, `buildSettings`, `decidePermission`, `describeRequest`, `systemPrompt`, `userMessage`, `buildArgs`, `startTurn`, `statusFromEvent`, `startBridge`, `inlineImages`, `unembeddedRefs`, `summaryFromMarkdown`.
- Produces: proceso ejecutable con `node src/bot.js`.

- [ ] **Step 1: Implementar `src/bot.js`**

```js
import { readFileSync, writeFileSync, existsSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { run } from '@grammyjs/runner';
import { ROOT, loadConfig, setEnvValue } from './config.js';
import { splitMessage } from './telegram-util.js';
import { authorizeMessage, authorizeCallback } from './auth.js';
import { resolveSite } from './sites.js';
import { makeJobDir, localDate } from './jobdir.js';
import { Store, StateError } from './state.js';
import { buildSettings, decidePermission, describeRequest } from './policy.js';
import { systemPrompt, userMessage } from './prompts.js';
import { buildArgs, startTurn, statusFromEvent } from './runner.js';
import { startBridge } from './permission-bridge.js';
import { inlineImages, unembeddedRefs, summaryFromMarkdown } from './report.js';

const cfg = loadConfig();
if (!cfg.token) {
  console.error('Falta TELEGRAM_TOKEN en .env');
  process.exit(1);
}

const bot = new Bot(cfg.token);
const store = new Store(cfg.statePath);
store.load();

let busy = false;
let killCurrent = null;
const orphans = [];
const permissions = new Map();

const PHASE_LABEL = { collecting: 'recogida', plan: 'plan', implement: 'implementación', reported: 'informe entregado' };

async function say(text, extra = {}) {
  const parts = splitMessage(text);
  let last;
  for (let i = 0; i < parts.length; i++) {
    last = await bot.api.sendMessage(cfg.ownerId, parts[i], i === parts.length - 1 ? extra : {});
  }
  return last;
}

// --- Autorización -----------------------------------------------------------

bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    if (!authorizeCallback(ctx.callbackQuery.from, cfg.ownerId)) return;
    return next();
  }
  const msg = ctx.message;
  if (!msg) return;
  const verdict = authorizeMessage(msg, cfg.ownerId);
  if (verdict === 'ignore') return;
  if (verdict === 'register') {
    cfg.ownerId = msg.from.id;
    const text = existsSync(cfg.envPath) ? readFileSync(cfg.envPath, 'utf8') : '';
    writeFileSync(cfg.envPath, setEnvValue(text, 'OWNER_ID', String(cfg.ownerId)), { mode: 0o600 });
    console.log(`OWNER_ID registrado: ${cfg.ownerId}`);
    await ctx.reply(`Registrado como dueño (ID ${cfg.ownerId}). No aceptaré mensajes de nadie más.`);
    return;
  }
  return next();
});

// --- Comandos ---------------------------------------------------------------

bot.command('start', (ctx) => ctx.reply('Comandos: /nuevo <sitio>, /plan, /estado, /cancelar, /cerrar'));

bot.command('nuevo', async (ctx) => {
  if (store.job) return ctx.reply(`Ya hay un trabajo abierto en ${store.job.site}. Ciérralo con /cerrar.`);
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio>.');
  const site = resolveSite(name, cfg.sitesRoot);
  if (!site.ok) {
    const list = site.suggestions.length ? `\n¿Quizá: ${site.suggestions.join(', ')}?` : '';
    return ctx.reply(`No existe ${cfg.sitesRoot}/${name}.${list}`);
  }
  const jobDir = makeJobDir(cfg.auditsRoot, site.name);
  store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  for (const item of orphans.splice(0)) store.addPending(item);

  let dirty = '';
  try { dirty = execFileSync('git', ['-C', site.path, 'status', '--short'], { encoding: 'utf8' }).trim(); } catch { dirty = ''; }
  if (dirty) {
    const kb = new InlineKeyboard().text('Seguir', 'dirty:go').text('Cancelar', 'dirty:cancel');
    return say(`Trabajo abierto en ${site.name}, pero el repo tiene cambios sin commitear:\n${dirty.slice(0, 3000)}\n¿Sigo?`, { reply_markup: kb });
  }
  return ctx.reply(`Trabajo abierto en ${site.name}.\nCarpeta: ${jobDir}\nMándame los issues y termina con /plan.`);
});

bot.command('plan', (ctx) => requestPlan(ctx));

bot.command('estado', (ctx) => {
  const j = store.job;
  if (!j) return ctx.reply('No hay trabajo abierto.');
  return ctx.reply(`Sitio: ${j.site}\nFase: ${PHASE_LABEL[j.phase]}${busy ? ' (Claude trabajando)' : ''}\nPendientes: ${j.pending.length}\nContexto: ${j.contextTokens} tokens\nCarpeta: ${j.jobDir}`);
});

bot.command('cancelar', (ctx) => {
  if (!killCurrent) return ctx.reply('No hay ningún turno en curso.');
  killCurrent();
  return ctx.reply('Cortando el turno…');
});

bot.command('cerrar', async (ctx) => {
  if (!store.job) return ctx.reply('No hay trabajo abierto.');
  if (busy) return ctx.reply('Claude está trabajando. Usa /cancelar primero.');
  const site = store.job.site;
  store.close();
  return ctx.reply(`Trabajo en ${site} cerrado.`);
});

// --- Contenido --------------------------------------------------------------

async function downloadFile(fileId, fallbackExt) {
  const file = await bot.api.getFile(fileId);
  const ext = (path.extname(file.file_path || '').slice(1) || fallbackExt).toLowerCase();
  const name = store.nextImageName(ext);
  const dest = path.join(store.job.jobDir, 'img', name);
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`);
  if (!res.ok) throw new Error(`descarga ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

async function receive(ctx, item) {
  if (!store.job) {
    orphans.push(item);
    return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio> y lo añado al trabajo.');
  }
  store.addPending(item);
  if (store.job.phase === 'collecting') return;
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return ctx.reply('Comando desconocido. Usa /start para ver la lista.');
  if (store.job?.phase === 'collecting' && /^eso es todo\.?$/i.test(text.trim())) return requestPlan(ctx);
  return receive(ctx, { type: 'text', text });
});

bot.on('message:photo', async (ctx) => {
  if (!store.job) return receive(ctx, { type: 'text', text: '(captura enviada antes de /nuevo: reenvíala)' });
  const photo = ctx.message.photo.at(-1);
  const dest = await downloadFile(photo.file_id, 'jpg');
  await receive(ctx, { type: 'image', path: dest });
  if (ctx.message.caption) await receive(ctx, { type: 'text', text: ctx.message.caption });
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) return ctx.reply('Solo acepto imágenes como archivo.');
  if (!store.job) return receive(ctx, { type: 'text', text: '(captura enviada antes de /nuevo: reenvíala)' });
  const dest = await downloadFile(doc.file_id, doc.mime_type.split('/')[1]);
  await receive(ctx, { type: 'image', path: dest });
  if (ctx.message.caption) await receive(ctx, { type: 'text', text: ctx.message.caption });
});

async function requestPlan(ctx) {
  try {
    store.startPlan();
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    const msg = { 'no-job': 'No hay trabajo abierto. Usa /nuevo <sitio>.', empty: 'Aún no me has mandado ningún issue.', 'bad-phase': 'El plan ya está en marcha.' };
    return ctx.reply(msg[e.code] ?? e.message);
  }
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  return runTurn();
}

// --- Botones ----------------------------------------------------------------

bot.callbackQuery('dirty:go', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup();
  return say('Sigo. Mándame los issues y termina con /plan.');
});

bot.callbackQuery('dirty:cancel', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup();
  if (store.job && !busy) store.close();
  return say('Trabajo cancelado.');
});

bot.callbackQuery('approve', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (busy) return say('Claude sigue trabajando; espera a que termine.');
  try { store.approve(); } catch { return say('No hay ningún plan pendiente de aprobar.'); }
  await ctx.editMessageReplyMarkup();
  store.addPending({ type: 'text', text: 'Plan aprobado. Implementa lo aprobado y escribe el informe.' });
  return runTurn();
});

bot.callbackQuery(/^perm:(.+):(allow|deny)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, id, choice] = ctx.match;
  const p = permissions.get(id);
  if (!p) return;
  p.resolve(choice === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denegado por el dueño.' });
  await ctx.editMessageText(`${p.text}\n→ ${choice === 'allow' ? 'Permitido' : 'Denegado'}`);
});

// --- Permisos ---------------------------------------------------------------

async function onPermission({ tool_name, input }) {
  const decision = decidePermission(tool_name, input);
  if (decision.action === 'deny') return { behavior: 'deny', message: decision.message };
  const id = randomUUID().slice(0, 8);
  const text = `Permiso: ${describeRequest(tool_name, input)}`;
  const kb = new InlineKeyboard().text('Permitir', `perm:${id}:allow`).text('Denegar', `perm:${id}:deny`);
  const msg = await say(text, { reply_markup: kb });
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      permissions.delete(id);
      resolve({ behavior: 'deny', message: 'Sin respuesta del dueño en 30 minutos.' });
      await bot.api.editMessageText(cfg.ownerId, msg.message_id, `${text}\n→ Denegado por tiempo`).catch(() => {});
    }, cfg.permissionTimeoutMs);
    permissions.set(id, {
      text,
      resolve: (r) => { clearTimeout(timer); permissions.delete(id); resolve(r); },
    });
  });
}

// --- Turnos -----------------------------------------------------------------

async function runTurn() {
  const job = store.job;
  if (!job || busy) return;
  busy = true;
  const phase = job.phase === 'implement' ? 'implement' : 'plan';
  const items = store.takePending();
  const status = await say(phase === 'plan' ? 'Analizando…' : 'Implementando…');
  let lastEdit = 0;

  const args = buildArgs({
    sessionId: job.sessionId,
    resume: job.started,
    mode: phase === 'plan' ? 'plan' : 'manual',
    systemPrompt: systemPrompt({ phase, site: job.site, sitePath: job.sitePath, jobDir: job.jobDir }),
    settings: buildSettings({ sitePath: job.sitePath, jobDir: job.jobDir }),
    mcpConfig: { mcpServers: { bot: { command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-permission.js')], env: { BOT_SOCKET: cfg.socketPath } } } },
  });

  const turn = startTurn({
    bin: cfg.claudeBin,
    cwd: job.sitePath,
    args,
    prompt: userMessage(items),
    timeoutMs: cfg.turnTimeoutMs,
    env: { MCP_TOOL_TIMEOUT: String(cfg.permissionTimeoutMs + 60_000) },
    onEvent: (e) => {
      const s = statusFromEvent(e);
      if (!s || Date.now() - lastEdit < 4000) return;
      lastEdit = Date.now();
      bot.api.editMessageText(cfg.ownerId, status.message_id, `${phase === 'plan' ? 'Analizando' : 'Implementando'}… ${s}`).catch(() => {});
    },
  });
  killCurrent = turn.kill;
  const r = await turn.promise;
  killCurrent = null;
  busy = false;

  if (r.sessionSeen && !job.started) store.markStarted();
  if (r.contextTokens) store.setContextTokens(r.contextTokens);
  await bot.api.deleteMessage(cfg.ownerId, status.message_id).catch(() => {});

  if (r.timedOut) await say('Turno cortado a los 45 minutos. Escribe «sigue» para retomarlo.');
  else if (r.killed) await say('Turno cancelado. Escribe «sigue» para retomarlo.');
  else if (r.isError) {
    const limit = /limit/i.test(r.text) ? 'Límite de uso alcanzado. ' : '';
    await say(`${limit}Error de Claude: ${r.text || r.stderr}\nCuando puedas, escribe «sigue».`);
  } else if (!r.ok) await say(`Claude terminó sin respuesta (código ${r.exitCode}).\n${r.stderr}\nEscribe «sigue» para reintentar.`);
  else if (phase === 'plan') {
    await say(r.text || '(respuesta vacía)', { reply_markup: new InlineKeyboard().text('Aprobar plan', 'approve') });
  } else {
    await say(r.text || 'Implementación terminada.');
    await deliverReport();
  }

  if (store.job && store.job.contextTokens > cfg.contextWarnTokens) {
    await say(`El contexto va por ${store.job.contextTokens} tokens. Conviene /cerrar y abrir otro trabajo.`);
  }
  if (store.job?.pending.length && store.job.phase !== 'collecting') {
    if (store.job.phase === 'reported') store.startPlan();
    return runTurn();
  }
}

async function deliverReport() {
  const job = store.job;
  const htmlPath = path.join(job.jobDir, 'informe.html');
  if (!existsSync(htmlPath)) {
    return say(`Claude terminó sin escribir ${htmlPath}. Escribe «sigue» para pedírselo.`);
  }
  store.finishImplement();
  const html = inlineImages(readFileSync(htmlPath, 'utf8'), job.jobDir);
  const missing = unembeddedRefs(html);
  const mdPath = path.join(job.jobDir, 'informe.md');
  const summary = existsSync(mdPath) ? summaryFromMarkdown(readFileSync(mdPath, 'utf8')) : '';
  await bot.api.sendDocument(cfg.ownerId, new InputFile(Buffer.from(html), `informe-${job.site}-${localDate()}.html`));
  if (summary) await say(summary);
  if (missing.length) await say(`Imágenes que no encontré: ${missing.join(', ')}`);
  return say('Revisa el diff en el repo. Si hay correcciones, escríbelas; si no, /cerrar.');
}

// --- Arranque ---------------------------------------------------------------

bot.catch((err) => console.error('Error del bot:', err.error ?? err));

await startBridge(cfg.socketPath, onPermission);

if (cfg.ownerId && store.job) {
  await say(`Bot reiniciado. Trabajo abierto en ${store.job.site}, fase ${PHASE_LABEL[store.job.phase]}. Escribe «sigue» para continuar o /cerrar.`).catch(() => {});
}

run(bot);
console.log('issue-bot escuchando');
```

Notas del flujo:
- En la fase `plan`, cualquier mensaje dispara otro turno de plan. En `implement`, «sigue» dispara otro turno de implementación. En `reported`, un mensaje vuelve a `plan`.
- Se usa `run(bot)` de `@grammyjs/runner` y no `bot.start()`: grammY en serie no entregaría el clic de «Permitir» mientras un turno espera ese mismo clic.

- [ ] **Step 2: Instalar el runner concurrente**

Run: `npm install @grammyjs/runner@^2`
Expected: `added 1 package`.

- [ ] **Step 3: Comprobación estática**

Run: `node --check src/bot.js && npm test`
Expected: sin errores de sintaxis; todos los tests PASS.

- [ ] **Step 4: Arranque sin token**

Run: `mv .env .env.bak 2>/dev/null; node src/bot.js; echo "exit=$?"; mv .env.bak .env 2>/dev/null`
Expected: `Falta TELEGRAM_TOKEN en .env` y `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add src/bot.js package.json package-lock.json
git commit -m "feat: wire telegram bot commands, turns, permissions and report delivery"
```

---

### Task 11: Servicio systemd, prueba real y README

**Files:**
- Create: `systemd/issue-bot.service`, `README.md`

**Interfaces:**
- Consumes: `src/bot.js`.
- Produces: servicio `issue-bot` en `systemd --user`.

- [ ] **Step 1: Unidad systemd**

`systemd/issue-bot.service`:

```ini
[Unit]
Description=Bot de Telegram para issues de sitios
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/srv/http/issue-bot
ExecStart=/home/lacho/.config/nvm/versions/node/v24.18.0/bin/node src/bot.js
Environment=PATH=/home/lacho/.local/bin:/home/lacho/.config/nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

- [ ] **Step 2: README**

`README.md`:

````markdown
# issue-bot

Bot de Telegram que recibe issues de un sitio de `/srv/http`, acuerda un plan por chat,
aplica el arreglo en local con Claude Code y devuelve un informe HTML de antes y después.

## Instalación

1. `npm install`
2. Crear `.env` (permisos 600):

   ```
   TELEGRAM_TOKEN=<token de BotFather>
   OWNER_ID=
   ```

3. Escribir al bot en privado. El primer mensaje registra tu user ID en `OWNER_ID`.
4. Servicio:

   ```
   ln -sf /srv/http/issue-bot/systemd/issue-bot.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now issue-bot
   loginctl enable-linger "$USER"   # para que arranque sin sesión abierta
   ```

## Uso

- `/nuevo <sitio>`: abre un trabajo sobre `/srv/http/<sitio>`.
- Manda textos y capturas. Termina con `/plan` o «eso es todo».
- Discute el plan por chat y pulsa **Aprobar plan**.
- Recibes `informe-<sitio>-<fecha>.html`. Correcciones: escríbelas. Si no, `/cerrar`.
- `/estado`, `/cancelar`.

Diseño: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md`.
Logs: `journalctl --user -u issue-bot -f`.
````

- [ ] **Step 3: Commit**

```bash
git add systemd/issue-bot.service README.md
git commit -m "docs: add systemd unit and README"
```

- [ ] **Step 4: Prueba real en primer plano (con el dueño)**

Requiere `.env` con el token. Run: `node src/bot.js` en una terminal aparte.
Pasos con el dueño en el móvil:
1. Mandar «hola»: el bot responde «Registrado como dueño (ID …)». Comprobar que `.env` tiene `OWNER_ID`.
2. `/nuevo tienda` (sin el nombre exacto): responde con sugerencias que incluyen `tienda-demo`.
3. `/nuevo tienda-demo`: abre el trabajo (o pregunta por el repo sucio).
4. Mandar un issue trivial con captura y `/plan`: llega un plan con botón **Aprobar plan**; en el log no hay edición de archivos.
5. Pedir un cambio en el chat: llega un plan revisado.
6. Aprobar: si aparece un botón de permiso, pulsarlo y ver que continúa.
7. Llega `informe-tienda-demo-<fecha>.html`; abrirlo en el móvil y comprobar que las imágenes se ven.
8. `git -C /srv/http/tienda-demo status --short` muestra el cambio sin commitear.
9. `/cerrar`.

Expected: los 9 pasos se cumplen. Anotar cualquier fallo y corregirlo antes del paso 5.

- [ ] **Step 5: Activar el servicio**

Run:

```bash
mkdir -p ~/.config/systemd/user
ln -sf /srv/http/issue-bot/systemd/issue-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now issue-bot
systemctl --user status issue-bot --no-pager | head -5
```

Expected: `active (running)`. Mandar `/estado` al bot y recibir «No hay trabajo abierto».
