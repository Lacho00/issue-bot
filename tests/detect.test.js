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
