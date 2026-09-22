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
