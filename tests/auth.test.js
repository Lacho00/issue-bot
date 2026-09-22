import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMessage, authorizeCallback } from '../src/auth.js';

const msg = (over = {}) => ({ from: { id: 7 }, chat: { type: 'private', id: 7 }, text: 'hola', ...over });

test('dueño en privado: allow', () => {
  assert.equal(authorizeMessage(msg(), 7, null), 'allow');
});

test('otro remitente: ignore', () => {
  assert.equal(authorizeMessage(msg({ from: { id: 8 } }), 7, null), 'ignore');
});

test('mensaje reenviado del dueño: ignore', () => {
  assert.equal(authorizeMessage(msg({ forward_origin: { type: 'user' } }), 7, null), 'ignore');
});

test('sin registro de grupo: el dueño en un grupo se ignora (el chat permitido es el privado)', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -1 } }), 7, null), 'ignore');
});

test('sin OWNER_ID: register en privado', () => {
  assert.equal(authorizeMessage(msg(), null, null), 'register');
});

test('sin OWNER_ID: un grupo también registra', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -1 } }), null, null), 'register');
});

test('sin from o canal: ignore aunque no haya OWNER_ID', () => {
  assert.equal(authorizeMessage(msg({ from: undefined }), null, null), 'ignore');
  assert.equal(authorizeMessage(msg({ chat: { type: 'channel', id: -1 } }), null, null), 'ignore');
});

test('dueño en el grupo registrado (CHAT_ID): allow', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -100 } }), 7, -100), 'allow');
  assert.equal(authorizeMessage(msg({ chat: { type: 'supergroup', id: -100 } }), 7, -100), 'allow');
});

test('dueño en un grupo distinto al registrado: ignore', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'group', id: -200 } }), 7, -100), 'ignore');
});

test('no-dueño en el grupo registrado: ignore', () => {
  assert.equal(authorizeMessage(msg({ from: { id: 8 }, chat: { type: 'group', id: -100 } }), 7, -100), 'ignore');
});

test('canal: ignore', () => {
  assert.equal(authorizeMessage(msg({ chat: { type: 'channel', id: -100 } }), 7, -100), 'ignore');
});

test('callback: solo el dueño en el chat permitido', () => {
  assert.equal(authorizeCallback({ id: 7 }, 7, null, { id: 7 }), true);
  assert.equal(authorizeCallback({ id: 8 }, 7, null, { id: 7 }), false);
  assert.equal(authorizeCallback({ id: 7 }, null, null, { id: 7 }), false);
});

test('callback: dueño en un chat distinto al permitido: false', () => {
  assert.equal(authorizeCallback({ id: 7 }, 7, -100, { id: 7 }), false);
  assert.equal(authorizeCallback({ id: 7 }, 7, -100, { id: -100 }), true);
});
