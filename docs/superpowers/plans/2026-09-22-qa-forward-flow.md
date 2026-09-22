# Flujo de reenvío de QA — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el dueño reenvíe al chat los mensajes de la QA y el bot detecte el sitio por las URLs, agrupe el lote con un temporizador de inactividad, proponga un plan, lo implemente tras **Aprobar plan** y trate cada reenvío posterior al informe como un lote nuevo.

**Architecture:** Tres módulos puros nuevos (`site-index.js` construye `Map<host, sitio>` desde `.wp-create.json` y vhosts de Apache; `detect.js` saca hosts de un mensaje y los cruza con el índice; `batch.js` es un temporizador con rebote). `auth.js` acepta reenvíos del dueño y `state.js` añade `forwarded`, `round` y una cola `nextBatch` persistida fuera del trabajo. `bot.js` enruta cada mensaje según fase, turno y sitio detectado; las capturas viajan como `fileId` hasta que hay trabajo y se descargan al entrar en él.

**Tech Stack:** Node 24 (ESM), grammY 1.x + `@grammyjs/runner`, `node:test` con `mock.timers`. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-09-22-qa-forward-flow-design.md` (manda). Fondo: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md`.

## Global Constraints

- Rama `feat/telegram-issue-bot` en `/srv/http/issue-bot`. No cambiar de rama.
- Solo el dueño (`OWNER_ID`) en el chat registrado (`CHAT_ID`, o el privado si no hay grupo). Los reenvíos del dueño en ese chat se aceptan; el autor original no importa. Cualquier otro remitente o chat se ignora sin respuesta.
- Un trabajo abierto a la vez; un turno de Claude a la vez.
- Las sesiones de Claude que lanza el bot nunca hacen `git commit`, `git push`, `git add`, `git reset --hard`, `git checkout --`, `git clean`, `wp db drop/reset/import`, ni instalan Playwright o sus navegadores. Se mantienen todos los deny actuales.
- El bot nunca crea sitios: solo carpetas que ya existen en `SITES_ROOT`. Nunca adivina un sitio: sin coincidencia única se pregunta.
- `BATCH_IDLE_MS` por defecto `120000`. `VHOST_DIR` por defecto `/etc/httpd/conf/extra`.
- Textos para el dueño en español. Límite de mensaje de Telegram: 4096 caracteres (`say()` ya parte con `splitMessage`).
- Carpeta del trabajo: `makeJobDir` (`qa-<AAAA-MM-DD>[-N]`); sesión nueva (`randomUUID()`) en cada trabajo.
- El bot corre en vivo desde este árbol: **ninguna tarea ejecuta `node src/bot.js` ni `npm start`**. `bot.js` no tiene tests unitarios; se verifica con `node --check src/bot.js` y `npm test`. El dueño reinicia el servicio y prueba en vivo.
- `npm test` = `node --test tests/*.test.js`. Antes de empezar: 71 tests en verde. Todos los existentes siguen pasando (salvo los que este plan reescribe explícitamente).
- Tests y prosa con nombres ficticios (`tienda-demo`, `pinar-demo`, `bot-sandbox`, `example.com`). Nunca dominios ni nombres de sitios reales.
- Commits sin líneas de atribución a Claude. `git add` solo de los ficheros de la tarea, nunca `git add -A`.

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `src/site-index.js` | Crear | `normalizeHost`, `buildSiteIndex({sitesRoot, vhostDir})` |
| `src/detect.js` | Crear | `extractHosts`, `matchSite`, `siteQuery` |
| `src/batch.js` | Crear | `createBatchTimer(ms, onFire)` |
| `src/auth.js` | Modificar | Reenvíos del dueño → `allow`; `isForwarded` |
| `src/state.js` | Modificar | `forwarded`, `round`, `nextBatch` persistido |
| `src/policy.js` | Modificar | Deny nuevos en settings y en `decidePermission` |
| `src/runner.js` | Modificar | `--setting-sources user,project,local` |
| `src/prompts.js` | Modificar | Quitar «lee el CLAUDE.md del sitio» |
| `src/config.js` | Modificar | `batchIdleMs`, `vhostDir` |
| `src/bot.js` | Modificar | Enrutado de reenvíos, lote, `nextBatch`, detección, botones |
| `README.md` | Modificar | Flujo de reenvío, claves nuevas de `.env`, permisos |
| `tests/site-index.test.js`, `tests/detect.test.js`, `tests/batch.test.js` | Crear | Tests de los módulos nuevos |
| `tests/auth.test.js`, `tests/state.test.js`, `tests/policy.test.js`, `tests/runner.test.js`, `tests/prompts.test.js`, `tests/config.test.js` | Modificar | Expectativas nuevas |
| `/srv/http/bot-sandbox/.wp-create.json` | Crear (otro repo) | Dominio de prueba `bot-sandbox.test` |

Recuento esperado de tests tras cada tarea: T1 75, T2 85, T3 89, T4 98, T5 101, T6 101, T7 103, T8 104.

---

### Task 1: Índice de sitios (`site-index.js`)

**Files:**
- Create: `src/site-index.js`
- Test: `tests/site-index.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `normalizeHost(raw: string) -> string` — URL o host a host en minúsculas, sin esquema, usuario, ruta, puerto, punto final ni `www.`; `''` si no es un host con al menos un punto (comodines `*`, `localhost`, vacío).
  - `buildSiteIndex({ sitesRoot: string, vhostDir: string }) -> Map<string, string>` (host normalizado → nombre de carpeta). Nunca lanza. Precedencia: `.wp-create.json` antes que vhosts; dentro de cada fuente, orden alfabético (sitio o fichero); el primero que reclama un host se lo queda.

- [ ] **Step 1: Escribir el test que falla**

`tests/site-index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeHost, buildSiteIndex } from '../src/site-index.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'idx-'));
  const sites = path.join(root, 'sites');
  const vhosts = path.join(root, 'vhosts');
  mkdirSync(vhosts, { recursive: true });
  for (const d of ['tienda-demo', 'pinar-demo', 'bot-sandbox', 'roto', '.oculto']) mkdirSync(path.join(sites, d), { recursive: true });
  writeFileSync(path.join(sites, 'tienda-demo', '.wp-create.json'), JSON.stringify({
    project: { domain: 'www.tienda-demo.com' },
    wordpress: { url: 'http://tienda-demo.local:8080', url_origin: ' https://tienda-demo-dev.host.com  https://dev.tienda-demo.uy/ ' },
  }));
  writeFileSync(path.join(sites, 'bot-sandbox', '.wp-create.json'), JSON.stringify({ project: {} }));
  writeFileSync(path.join(sites, 'roto', '.wp-create.json'), '{ no es json');
  writeFileSync(path.join(sites, '.oculto', '.wp-create.json'), JSON.stringify({ project: { domain: 'oculto.example.com' } }));
  writeFileSync(path.join(vhosts, 'httpd-pinar-demo.conf'), [
    '<VirtualHost *:80>',
    '    ServerName pinar-demo.example.com',
    '    ServerAlias www.pinar-demo.example.com alias-pinar.example.net',
    `    DocumentRoot "${sites}/pinar-demo"`,
    '    # ServerAlias comentado.example.com',
    '</VirtualHost>',
    '<VirtualHost *:443>',
    '    ServerName Secure-Pinar.Example.org:443',
    `    DocumentRoot ${sites}/pinar-demo/wp`,
    '</VirtualHost>',
    '',
  ].join('\n'));
  writeFileSync(path.join(vhosts, 'httpd-pinar-demo-redirect.conf'), [
    '<VirtualHost *:80>',
    '    ServerName viejo-pinar.example.com',
    '    Redirect permanent / http://pinar-demo.example.com/',
    '</VirtualHost>',
    '',
  ].join('\n'));
  writeFileSync(path.join(vhosts, 'httpd-ajeno.conf'), '<VirtualHost *:80>\n  ServerName ajeno.example.com\n  DocumentRoot /var/www/ajeno\n</VirtualHost>\n');
  writeFileSync(path.join(vhosts, 'httpd-tienda-demo.conf'), `<VirtualHost *:80>\n  ServerName tienda-demo.local\n  ServerAlias *.tienda-demo.local\n  DocumentRoot "${sites}/tienda-demo"\n</VirtualHost>\n`);
  mkdirSync(path.join(vhosts, 'httpd-carpeta.conf'));
  writeFileSync(path.join(vhosts, 'otro.conf'), `<VirtualHost *:80>\n  ServerName fuera.example.com\n  DocumentRoot "${sites}/tienda-demo"\n</VirtualHost>\n`);
  return { sites, vhosts };
}

test('normalizeHost: minúsculas, sin esquema, www, puerto, ruta ni punto final', () => {
  assert.equal(normalizeHost('HTTPS://WWW.Example.com:8443/ruta?x=1'), 'example.com');
  assert.equal(normalizeHost('www.example.com'), 'example.com');
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('http://user:pw@example.com/'), 'example.com');
  assert.equal(normalizeHost('tienda-demo.local:8080'), 'tienda-demo.local');
  assert.equal(normalizeHost('*.example.com'), '');
  assert.equal(normalizeHost('localhost'), '');
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost(undefined), '');
});

test('buildSiteIndex: .wp-create.json y vhosts, con alias, url_origin múltiple y redirect', () => {
  const { sites, vhosts } = fixture();
  const idx = buildSiteIndex({ sitesRoot: sites, vhostDir: vhosts });
  assert.deepEqual(Object.fromEntries(idx), {
    'tienda-demo.com': 'tienda-demo',
    'tienda-demo.local': 'tienda-demo',
    'tienda-demo-dev.host.com': 'tienda-demo',
    'dev.tienda-demo.uy': 'tienda-demo',
    'pinar-demo.example.com': 'pinar-demo',
    'alias-pinar.example.net': 'pinar-demo',
    'secure-pinar.example.org': 'pinar-demo',
    'viejo-pinar.example.com': 'pinar-demo',
  });
});

test('buildSiteIndex: carpetas que faltan no lanzan', () => {
  assert.equal(buildSiteIndex({ sitesRoot: '/nonexistent-sites-xyz', vhostDir: '/nonexistent-vhosts-xyz' }).size, 0);
  const { sites } = fixture();
  const idx = buildSiteIndex({ sitesRoot: sites, vhostDir: '/nonexistent-vhosts-xyz' });
  assert.equal(idx.get('tienda-demo.com'), 'tienda-demo');
  assert.equal(idx.has('pinar-demo.example.com'), false);
});

test('buildSiteIndex: .wp-create.json gana a vhosts y el orden alfabético desempata', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'idx-'));
  const sites = path.join(root, 'sites');
  const vhosts = path.join(root, 'vhosts');
  mkdirSync(vhosts, { recursive: true });
  for (const d of ['a-sitio', 'b-sitio']) mkdirSync(path.join(sites, d), { recursive: true });
  writeFileSync(path.join(sites, 'a-sitio', '.wp-create.json'), JSON.stringify({ project: { domain: 'compartido.example.com' }, wordpress: { url_origin: 'https://solo-a.example.com' } }));
  writeFileSync(path.join(sites, 'b-sitio', '.wp-create.json'), JSON.stringify({ wordpress: { url: 'https://compartido.example.com' } }));
  writeFileSync(path.join(vhosts, 'httpd-b-sitio.conf'), `<VirtualHost *:80>\n  ServerName solo-a.example.com\n  DocumentRoot ${sites}/b-sitio\n</VirtualHost>\n`);
  const idx = buildSiteIndex({ sitesRoot: sites, vhostDir: vhosts });
  assert.equal(idx.get('compartido.example.com'), 'a-sitio');
  assert.equal(idx.get('solo-a.example.com'), 'a-sitio');
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `cd /srv/http/issue-bot && node --test tests/site-index.test.js`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` para `src/site-index.js` (`ℹ fail 1`).

- [ ] **Step 3: Implementar `src/site-index.js`**

```js
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
```

- [ ] **Step 4: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/site-index.test.js`
Expected: `ℹ pass 4`, `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 75`, `ℹ pass 75`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /srv/http/issue-bot
git add src/site-index.js tests/site-index.test.js
git commit -m "feat: add site index from .wp-create.json and Apache vhosts"
```

---

### Task 2: Detección de sitio en un mensaje (`detect.js`)

**Files:**
- Create: `src/detect.js`
- Test: `tests/detect.test.js`

**Interfaces:**
- Consumes: `normalizeHost(raw) -> string` de `src/site-index.js` (Task 1).
- Produces:
  - `extractHosts(text?: string, entities?: MessageEntity[]) -> string[]` — hosts normalizados y sin repetir: primero los de entidades `url` (subcadena por `offset`/`length`, en unidades UTF-16 como Telegram) y `text_link` (`entity.url`), luego los de URLs `http(s)://…` y `www.…` del texto. No detecta nombres de fichero sueltos (`style.css`).
  - `matchSite(hosts: string[], index: Map<string,string>) -> { kind: 'one', site, host } | { kind: 'many', sites: string[] } | { kind: 'none' }` — solo coincidencia exacta de host; `host` es el primer host que coincidió; `sites` en orden de aparición.
  - `siteQuery(host: string) -> string` — la etiqueta más larga del host sin contar el TLD ni `www`, para buscar carpetas parecidas con `resolveSite`.

- [ ] **Step 1: Escribir el test que falla**

`tests/detect.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHosts, matchSite, siteQuery } from '../src/detect.js';

test('URL en una frase: quita puntuación final, www y repetidos', () => {
  assert.deepEqual(
    extractHosts('Mira https://www.tienda-demo.com/producto/1, y también https://tienda-demo.com.'),
    ['tienda-demo.com'],
  );
});

test('URLs entre paréntesis y www suelto en una frase en español', () => {
  assert.deepEqual(
    extractHosts('¿Por qué en (https://dev.tienda-demo.uy/carrito) sale mal? Y en www.pinar-demo.example.com.'),
    ['dev.tienda-demo.uy', 'pinar-demo.example.com'],
  );
});

test('entidad url: el texto enlazado sin esquema', () => {
  assert.deepEqual(extractHosts('ver tienda-demo.com ahora', [{ type: 'url', offset: 4, length: 15 }]), ['tienda-demo.com']);
});

test('entidad text_link: usa la URL oculta', () => {
  assert.deepEqual(
    extractHosts('este enlace', [{ type: 'text_link', offset: 0, length: 11, url: 'https://Pinar-Demo.example.com:8080/x' }]),
    ['pinar-demo.example.com'],
  );
});

test('offsets UTF-16: un emoji delante no descuadra la entidad', () => {
  assert.deepEqual(extractHosts('👉 tienda-demo.com', [{ type: 'url', offset: 3, length: 15 }]), ['tienda-demo.com']);
});

test('sin URLs: nada, ni nombres de fichero ni argumentos vacíos', () => {
  assert.deepEqual(extractHosts('el menú se ve mal en móvil'), []);
  assert.deepEqual(extractHosts('falla style.css en index.php'), []);
  assert.deepEqual(extractHosts(undefined, undefined), []);
});

const index = new Map([
  ['tienda-demo.com', 'tienda-demo'],
  ['dev.tienda-demo.uy', 'tienda-demo'],
  ['pinar-demo.example.com', 'pinar-demo'],
]);

test('matchSite: cero sitios', () => {
  assert.deepEqual(matchSite([], index), { kind: 'none' });
  assert.deepEqual(matchSite(['otro.example.com'], index), { kind: 'none' });
});

test('matchSite: un sitio aunque haya varios hosts suyos o hosts ajenos', () => {
  assert.deepEqual(matchSite(['tienda-demo.com', 'dev.tienda-demo.uy'], index), { kind: 'one', site: 'tienda-demo', host: 'tienda-demo.com' });
  assert.deepEqual(matchSite(['otro.example.com', 'pinar-demo.example.com'], index), { kind: 'one', site: 'pinar-demo', host: 'pinar-demo.example.com' });
});

test('matchSite: varios sitios en orden de aparición', () => {
  assert.deepEqual(matchSite(['pinar-demo.example.com', 'tienda-demo.com'], index), { kind: 'many', sites: ['pinar-demo', 'tienda-demo'] });
});

test('siteQuery: etiqueta más larga sin TLD ni www', () => {
  assert.equal(siteQuery('dev.tienda-demo.uy'), 'tienda-demo');
  assert.equal(siteQuery('tienda-demo.com'), 'tienda-demo');
  assert.equal(siteQuery('shop.pinar-demo.example.com'), 'pinar-demo');
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `cd /srv/http/issue-bot && node --test tests/detect.test.js`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` para `src/detect.js`.

- [ ] **Step 3: Implementar `src/detect.js`**

```js
import { normalizeHost } from './site-index.js';

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+|\bwww\.[^\s<>"'()[\]{}]+/gi;
const TRAIL = /[.,;:!?¿¡»«"'”’)\]]+$/;

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
```

- [ ] **Step 4: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/detect.test.js`
Expected: `ℹ pass 10`, `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 85`, `ℹ pass 85`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /srv/http/issue-bot
git add src/detect.js tests/detect.test.js
git commit -m "feat: detect site hosts in forwarded messages"
```

---

### Task 3: Temporizador de lote (`batch.js`)

**Files:**
- Create: `src/batch.js`
- Test: `tests/batch.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createBatchTimer(ms: number, onFire: () => any) -> { touch(): void, flush(): any, cancel(): void, readonly pending: boolean }`.
  - `touch()` (re)arranca la espera de `ms`; al vencer llama `onFire()` una vez.
  - `flush()` anula la espera y llama `onFire()` ya, haya o no espera pendiente; devuelve lo que devuelva `onFire()`.
  - `cancel()` anula la espera sin llamar.
  - `pending` es `true` mientras hay una espera armada.

- [ ] **Step 1: Escribir el test que falla**

`tests/batch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBatchTimer } from '../src/batch.js';

test('touch rebota: solo dispara tras ms sin toques nuevos', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  assert.equal(b.pending, false);
  b.touch();
  assert.equal(b.pending, true);
  t.mock.timers.tick(119_999);
  assert.equal(fired, 0);
  b.touch();
  t.mock.timers.tick(119_999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  assert.equal(b.pending, false);
  t.mock.timers.tick(500_000);
  assert.equal(fired, 1);
});

test('flush dispara ya, devuelve el resultado y anula la espera', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; return 'hecho'; });
  b.touch();
  assert.equal(b.flush(), 'hecho');
  assert.equal(fired, 1);
  assert.equal(b.pending, false);
  t.mock.timers.tick(200_000);
  assert.equal(fired, 1);
});

test('flush sin espera pendiente también dispara', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  b.flush();
  assert.equal(fired, 1);
});

test('cancel anula sin disparar', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const b = createBatchTimer(120_000, () => { fired += 1; });
  b.touch();
  b.cancel();
  assert.equal(b.pending, false);
  t.mock.timers.tick(200_000);
  assert.equal(fired, 0);
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `cd /srv/http/issue-bot && node --test tests/batch.test.js`
Expected: FAIL, `ERR_MODULE_NOT_FOUND` para `src/batch.js`.

- [ ] **Step 3: Implementar `src/batch.js`**

```js
export function createBatchTimer(ms, onFire) {
  let timer = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    get pending() {
      return timer !== null;
    },
    touch() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        onFire();
      }, ms);
    },
    flush() {
      clear();
      return onFire();
    },
    cancel: clear,
  };
}
```

- [ ] **Step 4: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/batch.test.js`
Expected: `ℹ pass 4`, `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 89`, `ℹ pass 89`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /srv/http/issue-bot
git add src/batch.js tests/batch.test.js
git commit -m "feat: add idle batch timer"
```

---

### Task 4: Reenvíos autorizados y estado del lote (`auth.js`, `state.js`)

**Files:**
- Modify: `src/auth.js` (entero, 16 líneas)
- Modify: `src/state.js:10-25` (constructor, `load`, `save`), `:32-42` (`open`, `addPending`), `:52-57` (`startPlan`)
- Test: `tests/auth.test.js`, `tests/state.test.js`

**Interfaces:**
- Consumes: nada nuevo.
- Produces:
  - `isForwarded(msg) -> boolean` (`forward_origin` o `forward_date`).
  - `authorizeMessage(msg, ownerId, chatId)`: reenvío del dueño en el chat permitido → `'allow'`; reenvío con `ownerId == null` → `'ignore'` (un reenvío nunca registra).
  - `Store#nextBatch: item[]` (fuera del job, persistido en `state.json` como `{ job, nextBatch }`), `Store#addToNextBatch(item)`, `Store#takeNextBatch() -> item[]` (ambos funcionan sin trabajo abierto; `close()` no toca `nextBatch`).
  - `Store#addPending(item)` y `addToNextBatch(item)` guardan `forwarded: item.forwarded === true`.
  - `job.round`: `1` al abrir; `startPlan()` desde `reported` hace `round = (round ?? 1) + 1`.

- [ ] **Step 1: Actualizar y ampliar `tests/auth.test.js`**

Cambiar la línea del import:

```js
import { authorizeMessage, authorizeCallback } from '../src/auth.js';
```

por:

```js
import { authorizeMessage, authorizeCallback, isForwarded } from '../src/auth.js';
```

Reemplazar el test actual (el spec cambia su expectativa):

```js
test('mensaje reenviado del dueño: ignore', () => {
  assert.equal(authorizeMessage(msg({ forward_origin: { type: 'user' } }), 7, null), 'ignore');
});
```

por:

```js
test('reenvío del dueño en su chat privado: allow', () => {
  assert.equal(authorizeMessage(msg({ forward_origin: { type: 'user' } }), 7, null), 'allow');
});

test('reenvío del dueño en el grupo registrado: allow (el autor original no importa)', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'supergroup', id: -100 }, forward_origin: { type: 'hidden_user', sender_user_name: 'QA' } }), 7, -100), 'allow');
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -100 }, forward_date: 1758500000 }), 7, -100), 'allow');
});

test('reenvío de otro miembro del grupo: ignore', () => {
  assert.equal(authorizeMessage(msg({ from: { id: 8 }, chat: { type: 'group', id: -100 }, forward_origin: { type: 'user' } }), 7, -100), 'ignore');
});

test('reenvío del dueño en otro chat: ignore', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -200 }, forward_origin: { type: 'user' } }), 7, -100), 'ignore');
});

test('reenvío sin OWNER_ID: ignore (un reenvío no registra)', () => {
  assert.equal(authorizeMessage(msg({ forward_origin: { type: 'user' } }), null, null), 'ignore');
});

test('isForwarded: forward_origin o forward_date', () => {
  assert.equal(isForwarded(msg({ forward_origin: { type: 'user' } })), true);
  assert.equal(isForwarded(msg({ forward_date: 1758500000 })), true);
  assert.equal(isForwarded(msg()), false);
  assert.equal(isForwarded(undefined), false);
});
```

- [ ] **Step 2: Actualizar y ampliar `tests/state.test.js`**

Cambiar el import:

```js
import { mkdtempSync } from 'node:fs';
```

por:

```js
import { mkdtempSync, writeFileSync } from 'node:fs';
```

Reemplazar el test `recorrido completo` actual:

```js
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
```

por:

```js
test('recorrido completo', () => {
  const st = new Store(file());
  st.open(base);
  assert.equal(st.job.phase, 'collecting');
  assert.equal(st.job.round, 1);
  st.addPending({ type: 'text', text: 'issue 1' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.equal(st.job.round, 1);
  assert.deepEqual(st.takePending(), [{ type: 'text', text: 'issue 1', forwarded: false }]);
  assert.deepEqual(st.job.pending, []);
  st.approve();
  assert.equal(st.job.phase, 'implement');
  st.finishImplement();
  assert.equal(st.job.phase, 'reported');
  st.addPending({ type: 'text', text: 'corrige esto' });
  st.startPlan();
  assert.equal(st.job.phase, 'plan');
  assert.equal(st.job.round, 2);
  st.close();
  assert.equal(st.job, null);
});
```

Añadir al final del fichero:

```js
test('addPending guarda forwarded como booleano', () => {
  const st = new Store(file());
  st.open(base);
  st.addPending({ type: 'text', text: 'de la QA', forwarded: true });
  st.addPending({ type: 'text', text: 'mío' });
  st.addPending({ type: 'image', path: '/tmp/j/img/qa-01.jpg', forwarded: 'sí' });
  assert.deepEqual(st.job.pending.map((i) => i.forwarded), [true, false, false]);
});

test('round: empieza en 1 y sube solo en correcciones tras reported', () => {
  const st = new Store(file());
  st.open(base);
  st.addPending({ type: 'text', text: 'a' });
  st.startPlan();
  st.approve();
  st.finishImplement();
  assert.equal(st.job.round, 1);
  for (const expected of [2, 3]) {
    st.addPending({ type: 'text', text: 'corrige' });
    st.startPlan();
    assert.equal(st.job.round, expected);
    st.approve();
    st.finishImplement();
  }
});

test('nextBatch: vive fuera del trabajo, se persiste y sobrevive a close', () => {
  const f = file();
  const a = new Store(f);
  a.addToNextBatch({ type: 'text', text: 'sin trabajo', forwarded: true });
  a.open(base);
  a.addToNextBatch({ type: 'image', fileId: 'F1', ext: 'jpg' });
  a.close();
  const b = new Store(f);
  b.load();
  assert.equal(b.job, null);
  assert.deepEqual(b.nextBatch, [
    { type: 'text', text: 'sin trabajo', forwarded: true },
    { type: 'image', fileId: 'F1', ext: 'jpg', forwarded: false },
  ]);
  assert.equal(b.takeNextBatch().length, 2);
  const c = new Store(f);
  c.load();
  assert.deepEqual(c.nextBatch, []);
});

test('state.json anterior sin round ni nextBatch se carga', () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ job: { ...base, phase: 'reported', started: true, pending: [], imageCount: 0, contextTokens: 0 } }));
  const st = new Store(f);
  st.load();
  assert.deepEqual(st.nextBatch, []);
  st.addPending({ type: 'text', text: 'corrección' });
  st.startPlan();
  assert.equal(st.job.round, 2);
});
```

- [ ] **Step 3: Ejecutar y ver que fallan**

Run: `cd /srv/http/issue-bot && node --test tests/auth.test.js tests/state.test.js`
Expected: FAIL. `auth.test.js` falla al importar (`does not provide an export named 'isForwarded'`); en `state.test.js` fallan `recorrido completo` (`round` es `undefined`), `addPending guarda forwarded…`, `round…`, `nextBatch…` (`addToNextBatch is not a function`) y `state.json anterior…`.

- [ ] **Step 4: Implementar `src/auth.js`**

Reemplazar el fichero entero:

```js
const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

export function authorizeMessage(msg, ownerId, chatId) {
  if (!msg?.from) return 'ignore';
  if (msg.forward_origin || msg.forward_date) return 'ignore';
  if (!CHAT_TYPES.has(msg.chat?.type)) return 'ignore';
  if (ownerId == null) return 'register';
  const allowedChat = chatId ?? ownerId;
  return msg.from.id === ownerId && msg.chat.id === allowedChat ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId, chatId, chat) {
  if (ownerId == null || from?.id !== ownerId) return false;
  const allowedChat = chatId ?? ownerId;
  return chat?.id === allowedChat;
}
```

por:

```js
const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

export function isForwarded(msg) {
  return Boolean(msg?.forward_origin || msg?.forward_date);
}

export function authorizeMessage(msg, ownerId, chatId) {
  if (!msg?.from) return 'ignore';
  if (!CHAT_TYPES.has(msg.chat?.type)) return 'ignore';
  // Un reenvío cuenta como mensaje del dueño si lo reenvía él en su chat; nunca registra.
  if (ownerId == null) return isForwarded(msg) ? 'ignore' : 'register';
  const allowedChat = chatId ?? ownerId;
  return msg.from.id === ownerId && msg.chat.id === allowedChat ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId, chatId, chat) {
  if (ownerId == null || from?.id !== ownerId) return false;
  const allowedChat = chatId ?? ownerId;
  return chat?.id === allowedChat;
}
```

- [ ] **Step 5: Implementar los cambios de `src/state.js`**

Reemplazar:

```js
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
```

por:

```js
const tag = (item) => ({ ...item, forwarded: item.forwarded === true });

export class Store {
  constructor(file) {
    this.file = file;
    this.job = null;
    this.nextBatch = [];
  }

  load() {
    const data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    this.job = data.job ?? null;
    this.nextBatch = Array.isArray(data.nextBatch) ? data.nextBatch : [];
    return this.job;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ job: this.job, nextBatch: this.nextBatch }, null, 2));
    renameSync(tmp, this.file);
  }
```

Reemplazar:

```js
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
```

por:

```js
  open({ site, sitePath, jobDir, sessionId }) {
    if (this.job) throw new StateError('job-open');
    this.job = { site, sitePath, jobDir, sessionId, phase: 'collecting', round: 1, started: false, pending: [], imageCount: 0, contextTokens: 0 };
    this.save();
  }

  addPending(item) {
    this.#require();
    this.job.pending.push(tag(item));
    this.save();
  }

  addToNextBatch(item) {
    this.nextBatch.push(tag(item));
    this.save();
  }

  takeNextBatch() {
    const items = this.nextBatch;
    this.nextBatch = [];
    this.save();
    return items;
  }
```

Reemplazar:

```js
  startPlan() {
    this.#require('collecting', 'reported');
    if (this.job.pending.length === 0) throw new StateError('empty');
    this.job.phase = 'plan';
    this.save();
  }
```

por:

```js
  startPlan() {
    this.#require('collecting', 'reported');
    if (this.job.pending.length === 0) throw new StateError('empty');
    if (this.job.phase === 'reported') this.job.round = (this.job.round ?? 1) + 1;
    this.job.phase = 'plan';
    this.save();
  }
```

- [ ] **Step 6: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/auth.test.js tests/state.test.js`
Expected: `ℹ pass 26` (auth 18 + state 8), `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 98`, `ℹ pass 98`, `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
cd /srv/http/issue-bot
git add src/auth.js src/state.js tests/auth.test.js tests/state.test.js
git commit -m "feat: accept owner forwards and track rounds and the next batch"
```

---

### Task 5: Deny nuevos en la política de permisos (`policy.js`)

Va antes que Task 6: los deny tienen que estar puestos antes de que los allow amplios de los settings del proyecto entren en juego.

**Files:**
- Modify: `src/policy.js:42-51` (`deny` de `buildSettings`), `:56-60` (`FORBIDDEN`), `:71-73` (mensaje de `decidePermission`)
- Test: `tests/policy.test.js`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `buildSettings(...).permissions.deny` incluye además `Bash(git add:*)`, `Bash(git reset --hard:*)`, `Bash(git checkout -- :*)`, `Bash(git clean:*)`, `Bash(wp db drop:*)`, `Bash(wp db reset:*)`, `Bash(wp db import:*)` en ambas fases. `decidePermission('Bash', {command})` devuelve `deny` para esos comandos (también con `git -C <ruta>` y `wp --path=<ruta>` delante); firmas sin cambios.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir al final de `tests/policy.test.js`:

```js
const SETTINGS_ARGS = { sitePath: '/srv/http/tienda-demo', jobDir: '/home/lacho/audits/tienda-demo/results/qa-2026-09-21', botEnvPath: '/srv/http/issue-bot/.env' };

test('settings: deny de git y wp db destructivos en ambas fases, sin perder los de antes', () => {
  const rules = [
    'Bash(git add:*)', 'Bash(git reset --hard:*)', 'Bash(git checkout -- :*)', 'Bash(git clean:*)',
    'Bash(wp db drop:*)', 'Bash(wp db reset:*)', 'Bash(wp db import:*)',
    'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(npx playwright install:*)', 'Bash(npm i playwright:*)',
    'Bash(npm install playwright:*)', 'mcp__playwright__browser_install', 'mcp__playwright__browser_run_code_unsafe',
    'Read(//srv/http/issue-bot/.env)',
  ];
  for (const phase of ['plan', 'implement']) {
    const s = buildSettings({ ...SETTINGS_ARGS, phase });
    for (const rule of rules) assert.ok(s.permissions.deny.includes(rule), `${phase}: ${rule}`);
  }
});

test('segunda capa deniega git add, reset --hard, checkout --, clean y wp db drop/reset/import', () => {
  for (const command of [
    'git add .', 'git add -A', 'cd x && git add style.css', 'git -C /srv/http/tienda-demo add style.css',
    'git reset --hard', 'git reset HEAD~1 --hard', 'git checkout -- style.css', 'git checkout HEAD -- style.css',
    'git clean -fd', 'wp db drop --yes', 'wp db reset --yes', 'wp db import copia.sql',
    'wp --path=/srv/http/tienda-demo db import copia.sql',
  ]) {
    assert.equal(decidePermission('Bash', { command }).action, 'deny', command);
  }
});

test('variantes no destructivas se siguen preguntando', () => {
  for (const command of [
    'git checkout -b arreglo', 'git checkout --theirs style.css', 'git reset HEAD style.css', 'git stash',
    'git log --grep add', 'wp db export copia.sql', 'wp db query "SELECT 1"',
  ]) {
    assert.deepEqual(decidePermission('Bash', { command }), { action: 'ask' }, command);
  }
});
```

- [ ] **Step 2: Ejecutarlos y ver que fallan**

Run: `cd /srv/http/issue-bot && node --test tests/policy.test.js`
Expected: FAIL en `settings: deny de git y wp db…` (`plan: Bash(git add:*)`) y `segunda capa deniega git add…` (`git add .`); `variantes no destructivas…` pasa ya. `ℹ pass 11`, `ℹ fail 2`.

- [ ] **Step 3: Implementar los cambios de `src/policy.js`**

Reemplazar:

```js
      deny: [
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(npx playwright install:*)',
```

por:

```js
      deny: [
        'Bash(git commit:*)',
        'Bash(git push:*)',
        'Bash(git add:*)',
        'Bash(git reset --hard:*)',
        'Bash(git checkout -- :*)',
        'Bash(git clean:*)',
        'Bash(wp db drop:*)',
        'Bash(wp db reset:*)',
        'Bash(wp db import:*)',
        'Bash(npx playwright install:*)',
```

Reemplazar:

```js
const FORBIDDEN = [
  /\bgit\s+(commit|push)\b/i,
  /\bplaywright\s+install\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^&|;]*playwright/i,
];
```

por:

```js
// Admite opciones globales delante del subcomando: git -C <ruta> add, wp --path=<ruta> db drop.
const GIT = String.raw`\bgit\s+(?:-C\s+\S+\s+)*`;
const WP = String.raw`\bwp\s+(?:--\S+\s+)*`;

const FORBIDDEN = [
  new RegExp(String.raw`${GIT}(commit|push|add|clean)\b`, 'i'),
  new RegExp(String.raw`${GIT}reset\b[^&|;]*\s--hard\b`, 'i'),
  new RegExp(String.raw`${GIT}checkout\b[^&|;]*\s--(\s|$)`, 'i'),
  new RegExp(String.raw`${WP}db\s+(drop|reset|import)\b`, 'i'),
  /\bplaywright\s+install\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^&|;]*playwright/i,
];
```

Reemplazar:

```js
    return { action: 'deny', message: 'Comando prohibido en este bot: sin commit, sin push, sin instalar Playwright.' };
```

por:

```js
    return { action: 'deny', message: 'Comando prohibido en este bot: sin git commit, push, add, reset --hard, checkout -- ni clean; sin wp db drop, reset ni import; sin instalar Playwright.' };
```

- [ ] **Step 4: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/policy.test.js`
Expected: `ℹ pass 13`, `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 101`, `ℹ pass 101`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /srv/http/issue-bot
git add src/policy.js tests/policy.test.js
git commit -m "feat: deny destructive git and wp db commands"
```

---

### Task 6: Cargar los settings del sitio (`runner.js`, `prompts.js`)

Cambio pedido expresamente por el dueño. Va en una tarea propia y pequeña. La línea del prompt se quita aquí porque solo sobra cuando `project` está en `--setting-sources` (el `CLAUDE.md` del sitio se carga solo).

Si el clasificador de seguridad de Claude Code bloquea la edición de `--setting-sources`, **para**: informa al dueño con el diff exacto de abajo y pídele que lo apruebe o lo aplique él. No busques rodeos.

**Files:**
- Modify: `src/runner.js:8`
- Modify: `src/prompts.js:7`
- Test: `tests/runner.test.js:422`, `tests/prompts.test.js:300-303`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `buildArgs(...)` emite `--setting-sources user,project,local`; `systemPrompt(...)` ya no menciona `CLAUDE.md`. Firmas sin cambios.

- [ ] **Step 1: Actualizar los tests**

En `tests/runner.test.js`, reemplazar:

```js
  assert.equal(first[first.indexOf('--setting-sources') + 1], 'user');
```

por:

```js
  assert.equal(first[first.indexOf('--setting-sources') + 1], 'user,project,local');
```

En `tests/prompts.test.js`, reemplazar:

```js
test('ambas fases piden leer el CLAUDE.md del sitio (no se carga solo)', () => {
  assert.match(systemPrompt({ ...ctx, phase: 'plan' }), /Read.*CLAUDE\.md/i);
  assert.match(systemPrompt({ ...ctx, phase: 'implement' }), /Read.*CLAUDE\.md/i);
});
```

por:

```js
test('ninguna fase pide leer el CLAUDE.md: se carga solo con --setting-sources', () => {
  assert.doesNotMatch(systemPrompt({ ...ctx, phase: 'plan' }), /CLAUDE\.md/);
  assert.doesNotMatch(systemPrompt({ ...ctx, phase: 'implement' }), /CLAUDE\.md/);
});
```

- [ ] **Step 2: Ejecutarlos y ver que fallan**

Run: `cd /srv/http/issue-bot && node --test tests/runner.test.js tests/prompts.test.js`
Expected: FAIL en `buildArgs: primer turno usa --session-id, luego --resume` (`'user' !== 'user,project,local'`) y en `ninguna fase pide leer el CLAUDE.md…`. `ℹ fail 2`.

- [ ] **Step 3: Implementar**

En `src/runner.js`, reemplazar:

```js
    '--setting-sources', 'user',
```

por:

```js
    '--setting-sources', 'user,project,local',
```

En `src/prompts.js`, borrar la línea:

```
Antes de empezar, lee con Read el CLAUDE.md y .claude/CLAUDE.md del sitio si existen.
```

para que `COMMON` quede:

```js
const COMMON = ({ site, sitePath, jobDir }) => `
Trabajas en modo desatendido para un bot de Telegram. El dueño solo te lee por Telegram.
Sitio: ${site} (${sitePath}). Carpeta del trabajo: ${jobDir}. Capturas del dueño: ${jobDir}/img/.
Escribe en español, frases cortas, sin tablas decorativas. Telegram no renderiza Markdown complejo:
usa listas simples y bloques de código cortos.
Nunca hagas git commit ni git push. Nunca instales Playwright ni navegadores.
Si necesitas algo del dueño, pregúntalo en texto al final de tu respuesta.`;
```

- [ ] **Step 4: Ejecutar los tests y ver que pasan**

Run: `cd /srv/http/issue-bot && node --test tests/runner.test.js tests/prompts.test.js`
Expected: `ℹ pass 15`, `ℹ fail 0`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 101`, `ℹ pass 101`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /srv/http/issue-bot
git add src/runner.js src/prompts.js tests/runner.test.js tests/prompts.test.js
git commit -m "feat: load user, project and local settings in each turn"
```

---

### Task 7: Bot A — reenvíos, lote con temporizador y `nextBatch`

Límite de la tarea: sin detección de sitio. Tras esta tarea, un lote sin trabajo se guarda en `nextBatch` y al cerrarse pregunta «¿De qué sitio es? Usa /nuevo <sitio>.»; `/nuevo` lo adopta. Un reenvío tras el informe cierra el trabajo y empieza un lote nuevo. La detección y los botones llegan en Task 8.

**Files:**
- Modify: `src/config.js:35` (clave `batchIdleMs`)
- Modify: `src/bot.js` (imports, variables, middleware de reenvíos, `/nuevo`, `/plan`, `/estado`, `/cerrar`, sección Contenido desde `receive` hasta `requestPlan`, `dirty:*`, final de `runTurn`, arranque)
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: `isForwarded(msg)` (Task 4), `Store#nextBatch`, `Store#addToNextBatch(item)`, `Store#takeNextBatch()`, `job.round` (Task 4), `createBatchTimer(ms, onFire)` (Task 3). Existentes: `say()`, `chat()`, `redact()`, `downloadFile(fileId, fallbackExt)`, `resolveSite`, `makeJobDir`, `runTurn()`.
- Produces (dentro de `bot.js`, para Task 8):
  - `cfg.batchIdleMs: number`.
  - `const batch = createBatchTimer(cfg.batchIdleMs, () => closeBatch())`.
  - `idleText() -> string`, `notFoundText(name, site) -> string`.
  - `addToJob(items)`: descarga los `image` sin `path` (por `fileId`/`ext`) y los mete en `pending`.
  - `openJob(name, reason = '')`: abre el trabajo, adopta `nextBatch`, avisa «Trabajo abierto en X (reason).»; no hay `await` antes de `store.open`.
  - `closeJob()`: `batch.cancel()` + `store.close()`.
  - `receive(ctx, items, { forwarded })`, `processNextBatch()`, `handleContent(ctx)`, `closeBatch()`, `requestPlan()` (ya sin `ctx`; responde con `say`).
  - Items de imagen: `{ type: 'image', fileId, ext, path?, forwarded }`.

- [ ] **Step 1: Escribir los tests de configuración que fallan**

Añadir al final de `tests/config.test.js`:

```js
test('loadConfig: BATCH_IDLE_MS por defecto 120000; vacío o inválido cae al defecto', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=abc\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 120_000);
});

test('loadConfig: BATCH_IDLE_MS numérico', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nBATCH_IDLE_MS=5000\n');
  assert.equal(loadConfig(envPath).batchIdleMs, 5000);
});
```

- [ ] **Step 2: Ejecutarlos y ver que fallan**

Run: `cd /srv/http/issue-bot && node --test tests/config.test.js`
Expected: FAIL en los dos tests nuevos (`undefined !== 120000`, `undefined !== 5000`). `ℹ pass 7`, `ℹ fail 2`.

- [ ] **Step 3: Implementar `batchIdleMs` en `src/config.js`**

Reemplazar:

```js
export function loadConfig(envPath = path.join(ROOT, '.env')) {
```

por:

```js
const positiveInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function loadConfig(envPath = path.join(ROOT, '.env')) {
```

Reemplazar:

```js
    contextWarnTokens: 200_000,
  };
```

por:

```js
    contextWarnTokens: 200_000,
    batchIdleMs: positiveInt(env.BATCH_IDLE_MS, 120_000),
  };
```

- [ ] **Step 4: Ejecutar los tests de configuración**

Run: `cd /srv/http/issue-bot && node --test tests/config.test.js`
Expected: `ℹ pass 9`, `ℹ fail 0`.

- [ ] **Step 5: `bot.js` — imports y variables**

Reemplazar:

```js
import { authorizeMessage, authorizeCallback } from './auth.js';
```

por:

```js
import { authorizeMessage, authorizeCallback, isForwarded } from './auth.js';
```

Reemplazar:

```js
import { inlineImages, unembeddedRefs, summaryFromMarkdown, renderReport } from './report.js';
```

por:

```js
import { inlineImages, unembeddedRefs, summaryFromMarkdown, renderReport } from './report.js';
import { createBatchTimer } from './batch.js';
```

Reemplazar:

```js
let busy = false;
let killCurrent = null;
const orphans = [];
const permissions = new Map();
```

por:

```js
let busy = false;
let killCurrent = null;
const permissions = new Map();
// Lote de mensajes: se cierra solo tras cfg.batchIdleMs sin mensajes nuevos (equivale a /plan).
const batch = createBatchTimer(cfg.batchIdleMs, () => closeBatch());
const idleText = () => (cfg.batchIdleMs >= 60_000 ? `${Math.round(cfg.batchIdleMs / 60_000)} min` : `${Math.round(cfg.batchIdleMs / 1000)} s`);
const notFoundText = (name, site) => `No existe ${cfg.sitesRoot}/${name}.${site.suggestions.length ? `\n¿Quizá: ${site.suggestions.join(', ')}?` : ''}`;
```

- [ ] **Step 6: `bot.js` — los reenvíos no pasan por los comandos**

Reemplazar (final del middleware de autorización):

```js
  return next();
});

// --- Comandos ---------------------------------------------------------------
```

por:

```js
  return next();
});

// Los reenvíos son contenido de QA aunque empiecen por «/»: no pasan por los comandos.
bot.use((ctx, next) => (ctx.message && isForwarded(ctx.message) ? handleContent(ctx) : next()));

// --- Comandos ---------------------------------------------------------------
```

- [ ] **Step 7: `bot.js` — `/nuevo`, `/plan`, `/estado`, `/cerrar`**

Reemplazar:

```js
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
    const sid = store.job.sessionId.slice(0, 8);
    const kb = new InlineKeyboard().text('Seguir', `dirty:go:${sid}`).text('Cancelar', `dirty:cancel:${sid}`);
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
```

por:

```js
bot.command('nuevo', async (ctx) => {
  if (store.job) return ctx.reply(`Ya hay un trabajo abierto en ${store.job.site}. Ciérralo con /cerrar.`);
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio>.');
  return openJob(name);
});

bot.command('plan', () => batch.flush());

bot.command('estado', (ctx) => {
  const j = store.job;
  const next = store.nextBatch.length ? `\nLote siguiente: ${store.nextBatch.length} elementos` : '';
  if (!j) return ctx.reply(`No hay trabajo abierto.${next}`);
  return ctx.reply(`Sitio: ${j.site}\nFase: ${PHASE_LABEL[j.phase]}${busy ? ' (Claude trabajando)' : ''}\nRonda: ${j.round ?? 1}\nPendientes: ${j.pending.length}${next}\nContexto: ${j.contextTokens} tokens\nCarpeta: ${j.jobDir}`);
});
```

Reemplazar:

```js
  const site = store.job.site;
  store.close();
  return ctx.reply(`Trabajo en ${site} cerrado.`);
});
```

por:

```js
  const site = store.job.site;
  closeJob();
  await ctx.reply(`Trabajo en ${site} cerrado.`);
  return processNextBatch();
});
```

- [ ] **Step 8: `bot.js` — sección Contenido**

`downloadFile` no cambia. Reemplazar desde `async function receive(ctx, items) {` hasta el `}` que cierra `requestPlan` (líneas actuales 143–201). Texto actual:

```js
async function receive(ctx, items) {
  if (!store.job) {
    orphans.push(...items);
    return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio> y lo añado al trabajo.');
  }
  for (const item of items) store.addPending(item);
  if (store.job.phase === 'collecting') return;
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return ctx.reply('Comando desconocido. Usa /start para ver la lista.');
  if (store.job?.phase === 'collecting' && /^eso es todo\.?$/i.test(text.trim())) return requestPlan(ctx);
  return receive(ctx, [{ type: 'text', text }]);
});

bot.on('message:photo', async (ctx) => {
  if (!store.job) return ctx.reply('Primero /nuevo <sitio>; luego reenvía la captura.');
  const photo = ctx.message.photo.at(-1);
  let dest;
  try {
    dest = await downloadFile(photo.file_id, 'jpg');
  } catch (e) {
    return ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  const items = [{ type: 'image', path: dest }];
  if (ctx.message.caption) items.push({ type: 'text', text: ctx.message.caption });
  return receive(ctx, items);
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) return ctx.reply('Solo acepto imágenes como archivo.');
  if (!store.job) return ctx.reply('Primero /nuevo <sitio>; luego reenvía la captura.');
  let dest;
  try {
    dest = await downloadFile(doc.file_id, doc.mime_type.split('/')[1].split('+')[0]);
  } catch (e) {
    return ctx.reply(`No pude descargar la captura: ${redact(e.message)}`);
  }
  const items = [{ type: 'image', path: dest }];
  if (ctx.message.caption) items.push({ type: 'text', text: ctx.message.caption });
  return receive(ctx, items);
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
```

Código nuevo:

```js
// Las capturas viajan como fileId hasta que hay trabajo; se descargan al entrar en él.
async function addToJob(items) {
  for (const it of items) {
    if (it.type !== 'image' || it.path) {
      store.addPending(it);
      continue;
    }
    try {
      store.addPending({ ...it, path: await downloadFile(it.fileId, it.ext) });
    } catch (e) {
      await say(`No pude descargar una captura: ${redact(e.message)}`);
    }
  }
}

// Abre el trabajo y adopta el lote guardado. Hasta store.open no hay ningún await: los updates
// de un álbum se atienden en paralelo y los siguientes tienen que ver el trabajo ya abierto.
async function openJob(name, reason = '') {
  const site = resolveSite(name, cfg.sitesRoot);
  if (!site.ok) return say(notFoundText(name, site));
  const jobDir = makeJobDir(cfg.auditsRoot, site.name);
  store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  await addToJob(store.takeNextBatch());

  const opened = `Trabajo abierto en ${site.name}${reason ? ` (${reason})` : ''}.`;
  let dirty = '';
  try { dirty = execFileSync('git', ['-C', site.path, 'status', '--short'], { encoding: 'utf8' }).trim(); } catch { dirty = ''; }
  if (dirty) {
    const sid = store.job.sessionId.slice(0, 8);
    const kb = new InlineKeyboard().text('Seguir', `dirty:go:${sid}`).text('Cancelar', `dirty:cancel:${sid}`);
    return say(`${opened}\nEl repo tiene cambios sin commitear:\n${dirty.slice(0, 3000)}\n¿Sigo?`, { reply_markup: kb });
  }
  const count = store.job.pending.length;
  if (count) batch.touch();
  const next = count
    ? `Llevo ${count} elementos. Sigue reenviando; cierro el lote con /plan o tras ${idleText()} sin mensajes.`
    : 'Mándame los issues y termina con /plan.';
  return say(`${opened}\nCarpeta: ${jobDir}\n${next}`);
}

function closeJob() {
  batch.cancel();
  store.close();
}

async function receive(ctx, items, { forwarded }) {
  const tagged = items.map((it) => ({ ...it, forwarded }));
  const job = store.job;
  if (!job) {
    // Lote sin sitio: se guarda hasta /nuevo; al cerrarse el lote se pregunta el sitio.
    for (const it of tagged) store.addToNextBatch(it);
    batch.touch();
    return;
  }
  if (forwarded && job.phase === 'reported' && !busy) {
    // Reenvío tras el informe: lote nuevo de QA.
    for (const it of tagged) store.addToNextBatch(it);
    return processNextBatch();
  }
  if (forwarded && (busy || job.phase === 'plan' || job.phase === 'implement')) {
    for (const it of tagged) store.addToNextBatch(it);
    return ctx.reply('Guardado para el siguiente lote.');
  }
  await addToJob(tagged);
  if (!store.job || !store.job.pending.length) return;
  if (store.job.phase === 'collecting') {
    batch.touch();
    return;
  }
  if (busy) return ctx.reply('Anotado. Entra en el siguiente turno.');
  if (store.job.phase === 'reported') store.startPlan();
  return runTurn();
}

// Lote guardado sin turno en curso: tras el informe cierra el trabajo y empieza otro.
async function processNextBatch() {
  if (busy || !store.nextBatch.length) return;
  if (store.job) {
    if (store.job.phase !== 'reported') return;
    const site = store.job.site;
    closeJob();
    await say(`Nuevo lote de QA. Cierro el trabajo en ${site}.`);
  }
  batch.touch();
}

async function handleContent(ctx) {
  const msg = ctx.message;
  const forwarded = isForwarded(msg);
  let items;
  if (typeof msg.text === 'string') {
    const text = msg.text;
    if (!forwarded) {
      if (text.startsWith('/')) return ctx.reply('Comando desconocido. Usa /start para ver la lista.');
      const batchOpen = store.job ? store.job.phase === 'collecting' : store.nextBatch.length > 0;
      if (batchOpen && /^eso es todo\.?$/i.test(text.trim())) return batch.flush();
    }
    items = [{ type: 'text', text }];
  } else if (msg.photo) {
    items = [{ type: 'image', fileId: msg.photo.at(-1).file_id, ext: 'jpg' }];
  } else if (msg.document) {
    const mime = msg.document.mime_type ?? '';
    if (!mime.startsWith('image/')) return ctx.reply('Solo acepto imágenes como archivo.');
    items = [{ type: 'image', fileId: msg.document.file_id, ext: mime.split('/')[1].split('+')[0] }];
  } else {
    return;
  }
  if (msg.caption) items.push({ type: 'text', text: msg.caption });
  return receive(ctx, items, { forwarded });
}

bot.on(['message:text', 'message:photo', 'message:document'], handleContent);

// Cierre del lote: por el temporizador, /plan o «eso es todo».
async function closeBatch() {
  try {
    if (!store.job && store.nextBatch.length) return await say('¿De qué sitio es? Usa /nuevo <sitio>.');
    return await requestPlan();
  } catch (e) {
    console.error('Error cerrando el lote:', redact(e?.stack ?? e));
  }
}

async function requestPlan() {
  try {
    store.startPlan();
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    const msg = { 'no-job': 'No hay trabajo abierto. Usa /nuevo <sitio>.', empty: 'Aún no me has mandado ningún issue.', 'bad-phase': 'El plan ya está en marcha.' };
    return say(msg[e.code] ?? e.message);
  }
  if (busy) return say('Anotado. Entra en el siguiente turno.');
  return runTurn();
}
```

- [ ] **Step 9: `bot.js` — botones del repo sucio**

Reemplazar:

```js
  await ctx.editMessageReplyMarkup().catch(() => {});
  return say('Sigo. Mándame los issues y termina con /plan.');
});
```

por:

```js
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job.phase === 'collecting' && store.job.pending.length) batch.touch();
  return say(`Sigo. Mándame los issues y termina con /plan (o espera ${idleText()} sin mensajes).`);
});
```

Reemplazar:

```js
  if (store.job && !busy) store.close();
  return say('Trabajo cancelado.');
```

por:

```js
  if (store.job && !busy) closeJob();
  return say('Trabajo cancelado.');
```

- [ ] **Step 10: `bot.js` — final de `runTurn` y arranque**

Reemplazar (final de `runTurn`):

```js
  if (store.job?.pending.length && store.job.phase !== 'collecting') {
    if (store.job.phase === 'reported') store.startPlan();
    return runTurn();
  }
}
```

por:

```js
  if (store.job?.pending.length && store.job.phase !== 'collecting') {
    if (store.job.phase === 'reported') store.startPlan();
    return runTurn();
  }
  return processNextBatch();
}
```

Reemplazar (arranque):

```js
  await say(`Bot reiniciado. Trabajo abierto en ${store.job.site}, fase ${PHASE_LABEL[store.job.phase]}. ${hint}`).catch(() => {});
}
```

por:

```js
  await say(`Bot reiniciado. Trabajo abierto en ${store.job.site}, fase ${PHASE_LABEL[store.job.phase]}. ${hint}`).catch(() => {});
}
if (cfg.ownerId && store.nextBatch.length) {
  await say(`Tengo ${store.nextBatch.length} elementos guardados para el siguiente lote.`).catch(() => {});
}
if (!store.job && store.nextBatch.length) batch.touch();
if (store.job?.phase === 'collecting' && store.job.pending.length) batch.touch();
```

- [ ] **Step 11: Verificar sin arrancar el bot**

Run: `cd /srv/http/issue-bot && node --check src/bot.js && echo SINTAXIS-OK`
Expected: `SINTAXIS-OK`.

Run: `cd /srv/http/issue-bot && grep -nE "orphans|requestPlan\(ctx\)|bot\.on\('message:(text|photo|document)'" src/bot.js`
Expected: sin salida.

Run: `cd /srv/http/issue-bot && grep -cE "^(async )?function (addToJob|openJob|closeJob|receive|processNextBatch|handleContent|closeBatch|requestPlan)\(" src/bot.js`
Expected: `8`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 103`, `ℹ pass 103`, `ℹ fail 0`.

No ejecutes `node src/bot.js`: el dueño reinicia el servicio y prueba en vivo.

- [ ] **Step 12: Commit**

```bash
cd /srv/http/issue-bot
git add src/config.js src/bot.js tests/config.test.js
git commit -m "feat: route forwards into idle-closed batches and a next batch"
```

---

### Task 8: Bot B — detección de sitio, candidatos y conflicto de sitio

Límite de la tarea: todo lo que usa el índice de sitios. Parte del código de Task 7.

**Files:**
- Modify: `src/config.js` (clave `vhostDir`)
- Modify: `src/bot.js` (imports, variables, `/start`, `/nuevo`, `openJob`, `closeJob`, `receive`, `processNextBatch`, `handleContent`, `closeBatch`, callbacks nuevos, arranque)
- Test: `tests/config.test.js`

**Interfaces:**
- Consumes: `buildSiteIndex({sitesRoot, vhostDir})` (Task 1); `extractHosts(text, entities)`, `matchSite(hosts, index)`, `siteQuery(host)` (Task 2); de Task 7: `batch`, `idleText()`, `notFoundText(name, site)`, `addToJob(items)`, `openJob(name, reason)`, `closeJob()`, `receive`, `processNextBatch`, `handleContent`, `closeBatch`, `requestPlan`.
- Produces:
  - `cfg.vhostDir: string`.
  - `buildIndex() -> Map`, `batchHosts() -> string[]`, `unmaterialize(item) -> item`, `siteKeyboard(sites) -> InlineKeyboard`, `detectAndOpen(hosts)`.
  - `receive(ctx, items, { forwarded, hosts = [] })`; cada item lleva `hosts` (los del mensaje de origen).
  - Estado en memoria: `conflict: { site, sid } | null`, `lastPrompt: string`.
  - Callbacks: `site:<nombre>`, `site-other`, `switch:<sid8>`, `keep:<sid8>`.

- [ ] **Step 1: Escribir el test de configuración que falla**

Añadir al final de `tests/config.test.js`:

```js
test('loadConfig: VHOST_DIR por defecto y configurable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\n');
  assert.equal(loadConfig(envPath).vhostDir, '/etc/httpd/conf/extra');
  writeFileSync(envPath, 'TELEGRAM_TOKEN=t\nVHOST_DIR=/tmp/vhosts-prueba\n');
  assert.equal(loadConfig(envPath).vhostDir, '/tmp/vhosts-prueba');
});
```

- [ ] **Step 2: Ejecutarlo y ver que falla**

Run: `cd /srv/http/issue-bot && node --test tests/config.test.js`
Expected: FAIL en `VHOST_DIR por defecto y configurable` (`undefined !== '/etc/httpd/conf/extra'`). `ℹ pass 9`, `ℹ fail 1`.

- [ ] **Step 3: Implementar `vhostDir` en `src/config.js`**

Reemplazar:

```js
    sitesRoot: env.SITES_ROOT || '/srv/http',
```

por:

```js
    sitesRoot: env.SITES_ROOT || '/srv/http',
    vhostDir: env.VHOST_DIR || '/etc/httpd/conf/extra',
```

Run: `cd /srv/http/issue-bot && node --test tests/config.test.js`
Expected: `ℹ pass 10`, `ℹ fail 0`.

- [ ] **Step 4: `bot.js` — imports y variables**

Reemplazar:

```js
import { createBatchTimer } from './batch.js';
```

por:

```js
import { createBatchTimer } from './batch.js';
import { buildSiteIndex } from './site-index.js';
import { extractHosts, matchSite, siteQuery } from './detect.js';
```

Reemplazar:

```js
const notFoundText = (name, site) => `No existe ${cfg.sitesRoot}/${name}.${site.suggestions.length ? `\n¿Quizá: ${site.suggestions.join(', ')}?` : ''}`;
```

por:

```js
const notFoundText = (name, site) => `No existe ${cfg.sitesRoot}/${name}.${site.suggestions.length ? `\n¿Quizá: ${site.suggestions.join(', ')}?` : ''}`;
// Se reconstruye en cada detección: son unos pocos ficheros y así nunca queda viejo.
const buildIndex = () => buildSiteIndex({ sitesRoot: cfg.sitesRoot, vhostDir: cfg.vhostDir });
const batchHosts = () => [...new Set(store.nextBatch.flatMap((it) => it.hosts ?? []))];
// Una captura ya descargada vuelve a ser fileId para descargarse en la carpeta de otro trabajo.
const unmaterialize = (it) => (it.type === 'image' && it.fileId ? { ...it, path: undefined } : it);
let conflict = null; // { site, sid } mientras se decide «Cambiar a Y» / «Añadir a X»
let lastPrompt = ''; // hosts de la última pregunta de sitio, para no repetirla en cada foto de un álbum
```

- [ ] **Step 5: `bot.js` — `/start` y `/nuevo`**

Reemplazar:

```js
bot.command('start', (ctx) => ctx.reply('Comandos: /nuevo <sitio>, /plan, /estado, /cancelar, /cerrar'));
```

por:

```js
bot.command('start', (ctx) => ctx.reply('Reenvíame los mensajes de la QA: detecto el sitio por sus URLs. Comandos: /nuevo <sitio>, /plan, /estado, /cancelar, /cerrar'));
```

Reemplazar:

```js
bot.command('nuevo', async (ctx) => {
  if (store.job) return ctx.reply(`Ya hay un trabajo abierto en ${store.job.site}. Ciérralo con /cerrar.`);
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio>.');
  return openJob(name);
});
```

por:

```js
bot.command('nuevo', async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) return ctx.reply('¿De qué sitio es? Usa /nuevo <sitio>.');
  if (!store.job) return openJob(name);
  // /nuevo explícito gana a la detección mientras el lote se está recogiendo.
  if (busy || store.job.phase !== 'collecting') return ctx.reply(`Ya hay un trabajo abierto en ${store.job.site}. Ciérralo con /cerrar.`);
  const target = resolveSite(name, cfg.sitesRoot);
  if (!target.ok) return ctx.reply(notFoundText(name, target));
  if (target.name === store.job.site) return ctx.reply(`El trabajo abierto ya es de ${target.name}.`);
  const from = store.job.site;
  for (const it of store.takePending()) store.addToNextBatch(unmaterialize(it));
  closeJob();
  await say(`Cambio el trabajo de ${from} a ${target.name}.`);
  return openJob(target.name);
});
```

- [ ] **Step 6: `bot.js` — `openJob` y `closeJob`**

Reemplazar (dentro de `openJob`):

```js
  store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  await addToJob(store.takeNextBatch());
```

por:

```js
  store.open({ site: site.name, sitePath: site.path, jobDir, sessionId: randomUUID() });
  lastPrompt = '';
  await addToJob(store.takeNextBatch());
```

Reemplazar:

```js
function closeJob() {
  batch.cancel();
  store.close();
}
```

por:

```js
function closeJob() {
  batch.cancel();
  conflict = null;
  store.close();
}
```

- [ ] **Step 7: `bot.js` — `receive` con detección y conflicto**

Reemplazar el principio de `receive` (código de Task 7):

```js
async function receive(ctx, items, { forwarded }) {
  const tagged = items.map((it) => ({ ...it, forwarded }));
  const job = store.job;
  if (!job) {
    // Lote sin sitio: se guarda hasta /nuevo; al cerrarse el lote se pregunta el sitio.
    for (const it of tagged) store.addToNextBatch(it);
    batch.touch();
    return;
  }
```

por:

```js
async function receive(ctx, items, { forwarded, hosts = [] }) {
  const tagged = items.map((it) => ({ ...it, forwarded, hosts }));
  const job = store.job;
  if (!job) {
    // Lote sin sitio: se guarda y, si el mensaje trae URLs, se intenta detectar el sitio del lote.
    for (const it of tagged) store.addToNextBatch(it);
    batch.touch();
    if (hosts.length) return detectAndOpen(batchHosts());
    return;
  }
```

y reemplazar, en la misma función:

```js
  if (forwarded && (busy || job.phase === 'plan' || job.phase === 'implement')) {
    for (const it of tagged) store.addToNextBatch(it);
    return ctx.reply('Guardado para el siguiente lote.');
  }
  await addToJob(tagged);
```

por:

```js
  if (forwarded && (busy || job.phase === 'plan' || job.phase === 'implement')) {
    for (const it of tagged) store.addToNextBatch(it);
    return ctx.reply('Guardado para el siguiente lote.');
  }
  if (forwarded && job.phase === 'collecting') {
    if (conflict) {
      // El resto del reenvío en disputa (fotos de un álbum sin URL) espera a la respuesta.
      for (const it of tagged) store.addToNextBatch(it);
      return;
    }
    const m = hosts.length ? matchSite(hosts, buildIndex()) : { kind: 'none' };
    if (m.kind === 'one' && m.site !== job.site) {
      for (const it of tagged) store.addToNextBatch(it);
      const sid = job.sessionId.slice(0, 8);
      conflict = { site: m.site, sid };
      const kb = new InlineKeyboard().text(`Cambiar a ${m.site}`, `switch:${sid}`).text(`Añadir a ${job.site}`, `keep:${sid}`);
      return say(`Este reenvío es de ${m.site} (${m.host}), pero el trabajo abierto es de ${job.site}.`, { reply_markup: kb });
    }
  }
  await addToJob(tagged);
```

- [ ] **Step 8: `bot.js` — `processNextBatch`, `detectAndOpen` y `siteKeyboard`**

Reemplazar:

```js
    closeJob();
    await say(`Nuevo lote de QA. Cierro el trabajo en ${site}.`);
  }
  batch.touch();
}
```

por:

```js
    closeJob();
    await say(`Nuevo lote de QA. Cierro el trabajo en ${site}.`);
  }
  batch.touch();
  return detectAndOpen(batchHosts());
}

function siteKeyboard(sites) {
  const kb = new InlineKeyboard();
  for (const s of sites.slice(0, 5)) {
    if (Buffer.byteLength(`site:${s}`) <= 64) kb.text(s, `site:${s}`).row();
  }
  return kb.text('Otro', 'site-other');
}

// Sin trabajo abierto: un solo sitio abre el trabajo; varios o ninguno, botones. Nunca adivina.
async function detectAndOpen(hosts) {
  if (store.job || !hosts.length) return;
  const index = buildIndex();
  const m = matchSite(hosts, index);
  if (m.kind === 'one') return openJob(m.site, `detectado por ${m.host}`);
  const key = hosts.join(' ');
  if (key === lastPrompt) return;
  lastPrompt = key;
  if (m.kind === 'many') {
    return say(`El lote menciona varios sitios: ${m.sites.join(', ')}. ¿De cuál es?`, { reply_markup: siteKeyboard(m.sites) });
  }
  const candidates = [...new Set(hosts.flatMap((h) => {
    const r = resolveSite(siteQuery(h), cfg.sitesRoot);
    return r.ok ? [r.name] : r.suggestions;
  }))];
  const ask = candidates.length ? ' ¿Es alguno de estos?' : '';
  return say(`No tengo ese sitio (${hosts.join(', ')}).${ask}`, { reply_markup: siteKeyboard(candidates) });
}
```

- [ ] **Step 9: `bot.js` — hosts en `handleContent` y `closeBatch`**

Reemplazar (final de `handleContent`):

```js
  if (msg.caption) items.push({ type: 'text', text: msg.caption });
  return receive(ctx, items, { forwarded });
}
```

por:

```js
  if (msg.caption) items.push({ type: 'text', text: msg.caption });
  const hosts = extractHosts(msg.text ?? msg.caption ?? '', msg.entities ?? msg.caption_entities ?? []);
  return receive(ctx, items, { forwarded, hosts });
}
```

Reemplazar:

```js
async function closeBatch() {
  try {
    if (!store.job && store.nextBatch.length) return await say('¿De qué sitio es? Usa /nuevo <sitio>.');
    return await requestPlan();
```

por:

```js
async function closeBatch() {
  try {
    if (conflict) return await say(`Antes de seguir, dime si cambio a ${conflict.site} o lo añado a ${store.job?.site}.`);
    if (!store.job && store.nextBatch.length) {
      return await say(batchHosts().length ? 'Elige el sitio en los botones de arriba o usa /nuevo <sitio>.' : '¿De qué sitio es? Usa /nuevo <sitio>.');
    }
    return await requestPlan();
```

- [ ] **Step 10: `bot.js` — callbacks de sitio y de conflicto**

Reemplazar:

```js
bot.callbackQuery('approve', async (ctx) => {
```

por:

```js
bot.callbackQuery(/^site:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (store.job) return say(`Ya hay un trabajo abierto en ${store.job.site}.`);
  return openJob(ctx.match[1]);
});

bot.callbackQuery('site-other', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  return say('Usa /nuevo <sitio>.');
});

const conflictIs = (sid) => conflict?.sid === sid && store.job?.sessionId.slice(0, 8) === sid;

bot.callbackQuery(/^switch:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (!conflictIs(ctx.match[1])) return say('Esa pregunta ya no vale.');
  const { site } = conflict;
  const from = store.job.site;
  closeJob();
  await say(`Trabajo en ${from} cerrado.`);
  return openJob(site);
});

bot.callbackQuery(/^keep:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (!conflictIs(ctx.match[1])) return say('Esa pregunta ya no vale.');
  conflict = null;
  const site = store.job.site;
  await addToJob(store.takeNextBatch());
  batch.touch();
  return say(`Añadido a ${site}.`);
});

bot.callbackQuery('approve', async (ctx) => {
```

- [ ] **Step 11: `bot.js` — índice al arrancar**

Reemplazar:

```js
await bot.init();
run(bot);
```

por:

```js
console.log(`Índice de sitios: ${buildIndex().size} hosts`);
await bot.init();
run(bot);
```

- [ ] **Step 12: Verificar sin arrancar el bot**

Run: `cd /srv/http/issue-bot && node --check src/bot.js && echo SINTAXIS-OK`
Expected: `SINTAXIS-OK`.

Run: `cd /srv/http/issue-bot && grep -cE "^(async )?function (detectAndOpen|siteKeyboard)\(|^bot\.callbackQuery\((/\^(site|switch|keep):|'site-other')" src/bot.js`
Expected: `6`.

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 104`, `ℹ pass 104`, `ℹ fail 0`.

Run (índice real, sin imprimir nombres): `cd /srv/http/issue-bot && node -e "import('./src/site-index.js').then((m) => console.log(m.buildSiteIndex({ sitesRoot: '/srv/http', vhostDir: '/etc/httpd/conf/extra' }).size > 0))"`
Expected: `true`.

No ejecutes `node src/bot.js`.

- [ ] **Step 13: Commit**

```bash
cd /srv/http/issue-bot
git add src/config.js src/bot.js tests/config.test.js
git commit -m "feat: detect the site of forwarded QA batches"
```

---

### Task 9: `bot-sandbox` con dominio de prueba y README

**Files:**
- Create: `/srv/http/bot-sandbox/.wp-create.json` (repo propio, rama `master`)
- Modify: `README.md` (claves opcionales, Uso, Grupo; sección nueva Permisos)

**Interfaces:**
- Consumes: `buildSiteIndex` (Task 1); claves `BATCH_IDLE_MS` (Task 7) y `VHOST_DIR` (Task 8).
- Produces: `bot-sandbox.test` → `bot-sandbox` en el índice, para la prueba en vivo del dueño.

- [ ] **Step 1: Crear `/srv/http/bot-sandbox/.wp-create.json`**

```json
{
  "project": {
    "domain": "bot-sandbox.test"
  },
  "wordpress": {
    "url": "http://bot-sandbox.test"
  }
}
```

- [ ] **Step 2: Comprobar que el índice lo recoge**

Run: `cd /srv/http/issue-bot && node -e "import('./src/site-index.js').then((m) => console.log(m.buildSiteIndex({ sitesRoot: '/srv/http', vhostDir: '/nonexistent' }).get('bot-sandbox.test')))"`
Expected: `bot-sandbox`.

- [ ] **Step 3: Commit en el repo de `bot-sandbox` (solo ese fichero)**

`bot-sandbox` puede tener cambios sin commitear de pruebas anteriores (`index.html`, `style.css`): no los toques ni los añadas.

```bash
git -C /srv/http/bot-sandbox add .wp-create.json
git -C /srv/http/bot-sandbox commit -m "chore: add .wp-create.json with a test domain"
git -C /srv/http/bot-sandbox show --stat --oneline HEAD
```

Expected: el commit contiene solo `.wp-create.json`.

- [ ] **Step 4: README — claves opcionales**

Reemplazar:

````
   SITES_ROOT=/srv/http
   AUDITS_ROOT=/home/lacho/audits
   CLAUDE_BIN=claude
   BOT_SOCKET=<carpeta del bot>/bot.sock
   ```
````

por:

````
   SITES_ROOT=/srv/http
   AUDITS_ROOT=/home/lacho/audits
   CLAUDE_BIN=claude
   BOT_SOCKET=<carpeta del bot>/bot.sock
   BATCH_IDLE_MS=120000
   VHOST_DIR=/etc/httpd/conf/extra
   ```

   `BATCH_IDLE_MS`: milisegundos sin mensajes nuevos tras los que se cierra el lote.
   `VHOST_DIR`: carpeta de los vhosts de Apache (`httpd-*.conf`) que se usan para detectar el sitio.
````

- [ ] **Step 5: README — Uso y Permisos**

Reemplazar la sección entera:

```markdown
## Uso

- `/nuevo <sitio>`: abre un trabajo sobre `/srv/http/<sitio>`.
- Manda textos y capturas. Termina con `/plan` o «eso es todo».
- Discute el plan por chat y pulsa **Aprobar plan**.
- Recibes `informe-<sitio>-<fecha>.html`. Correcciones: escríbelas. Si no, `/cerrar`.
- `/estado`, `/cancelar`.

Diseño: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md`.
Logs: `journalctl --user -u issue-bot -f`.
```

por:

```markdown
## Uso

- Reenvía al chat los mensajes de la QA (textos, capturas, álbumes). El bot saca los hosts de
  las URLs y los busca en el `.wp-create.json` de cada sitio (`project.domain`,
  `wordpress.url`, `wordpress.url_origin`) y en los vhosts de `VHOST_DIR` (`ServerName`,
  `ServerAlias`). Si coincide un solo sitio abre el trabajo: «Trabajo abierto en X (detectado
  por <host>)». Si coinciden varios, o el host no está en el índice, elige en los botones o
  usa `/nuevo <sitio>`. El bot nunca crea sitios ni adivina uno.
- `/nuevo <sitio>`: abre un trabajo sobre `/srv/http/<sitio>` a mano. Mientras el lote se está
  recogiendo, gana a la detección.
- El lote se cierra solo tras 2 minutos sin mensajes (`BATCH_IDLE_MS`), o en el acto con `/plan`
  o «eso es todo». Si al cerrarse no hay sitio, el bot pregunta y conserva el lote.
- Si reenvías algo de otro sitio con un lote abierto, el bot pregunta: **Cambiar a Y** o
  **Añadir a X**.
- Discute el plan por chat y pulsa **Aprobar plan**.
- Recibes `informe-<sitio>-<fecha>.html` y la tabla resumen. Después:
  - lo que escribas tú es una corrección: nueva ronda del mismo trabajo;
  - un reenvío es un lote nuevo de QA: cierra el trabajo y abre otro para el sitio detectado.
- Los reenvíos que llegan mientras Claude trabaja, o con un plan sin aprobar, se guardan para el
  siguiente lote («Guardado para el siguiente lote»).
- `/estado`, `/cancelar`, `/cerrar`.

Diseño: `docs/superpowers/specs/2026-09-21-telegram-issue-bot-design.md` y
`docs/superpowers/specs/2026-09-22-qa-forward-flow-design.md`.
Logs: `journalctl --user -u issue-bot -f`.
Tras actualizar el código: `systemctl --user restart issue-bot`.

## Permisos

Cada turno carga los settings del usuario, del proyecto y locales del sitio
(`--setting-sources user,project,local`), así que el `CLAUDE.md` del sitio se carga solo, más la
lista del bot. Los deny del bot ganan a cualquier allow del sitio: nunca `git commit`, `push`,
`add`, `reset --hard`, `checkout --` ni `clean`; nunca `wp db drop`, `reset` ni `import`; nunca
instalar Playwright ni sus navegadores. Lo que no cubre ninguna lista se pide con botones
Permitir/Denegar.
```

- [ ] **Step 6: README — Grupo**

Reemplazar:

```markdown
4. El resto de personas del grupo pueden leer todo lo que el bot publique ahí.
```

por:

```markdown
4. El resto de personas del grupo pueden leer todo lo que el bot publique ahí.
5. Los reenvíos que hace el dueño en ese chat se aceptan, venga de quien venga el mensaje
   original. Los reenvíos de otras personas se ignoran.
```

- [ ] **Step 7: Verificar y hacer commit**

Run: `cd /srv/http/issue-bot && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `ℹ tests 104`, `ℹ pass 104`, `ℹ fail 0`.

```bash
cd /srv/http/issue-bot
git add README.md
git commit -m "docs: document the QA forward flow"
```

---

## Cobertura del spec

| Punto del spec | Tarea |
|----------------|-------|
| Reenvíos del dueño en su chat → `allow`; de otros → `ignore` | 4 |
| Hosts de texto, caption y entidades `url`/`text_link` | 2, 8 (`handleContent`) |
| Un sitio → «Trabajo abierto en X (detectado por <host>)» | 8 (`detectAndOpen`) |
| Varios o ninguno → hasta 5 candidatos + «Otro» | 8 (`siteKeyboard`) |
| Sin URLs al cerrar → «¿De qué sitio es? Usa /nuevo <sitio>», lote conservado | 7, 8 (`closeBatch`) |
| `/nuevo` explícito gana a la detección | 7 (adopta `nextBatch`), 8 (cambia un lote en recogida) |
| Temporizador `BATCH_IDLE_MS` (120 000), cada mensaje reinicia, álbum incluido | 3, 7 |
| `/plan` o «eso es todo» cierran ya | 7 (`batch.flush`) |
| `--setting-sources user,project,local`; fuera «lee el CLAUDE.md» | 6 |
| Tras el informe: escrito = nueva ronda; reenviado = trabajo nuevo `qa-<fecha>-N`, sesión nueva | 4 (`round`), 7 |
| Reenvíos durante un turno → `nextBatch`, se procesan al terminar según la fase | 7 (`receive`, final de `runTurn`) |
| Conflicto en `collecting`: «Cambiar a Y» / «Añadir a X» | 8 |
| `plan`/`implement` sin turno + reenvío → «Guardado para el siguiente lote» | 7 |
| Host fuera del índice → «No tengo ese sitio (<host>)» + candidatos con `resolveSite` | 2 (`siteQuery`), 8 |
| `site-index` (fuentes, normalización, ficheros ilegibles, `VHOST_DIR`) | 1, 8 |
| `state`: `forwarded`, `round`, `nextBatch` persistido | 4 |
| `policy`: deny nuevos en settings y `decidePermission` | 5 |
| `config`: `batchIdleMs`, `vhostDir` | 7, 8 |
| README y `bot-sandbox` con `.wp-create.json` | 9 |
