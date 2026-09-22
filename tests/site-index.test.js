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
