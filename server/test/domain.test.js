import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_TTL, MAX_PAYLOAD, Rejected, batchInput, deviceInput, equalSecret,
  itemInput, normalizeCode, pairingMessage
} from '../src/domain.js';

const sender = randomUUID();
const recipient = randomUUID();
const now = Date.parse('2026-11-05T12:00:00Z');
const transfer = data => ({
  op: 'PUT', table: 'items', id: randomUUID(),
  opData: { kind: 'transfer', sender_id: sender, recipient_id: recipient, payload: 'encrypted envelope', ...data }
});

test('enrollment validates identity and hashes the device credential', () => {
  const token = randomBytes(32).toString('base64url');
  const device = deviceInput({ device_id: sender, name: ' Mac ', public_key: 'public key', device_token: token });
  assert.equal(device.name, 'Mac');
  assert.match(device.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(device.token_hash, token);
  for (const bad of [{ name: 1 }, { name: '' }, { device_token: 'short' }, { device_id: "'; DROP TABLE devices" }]) {
    assert.throws(() => deviceInput({ device_id: sender, name: 'Mac', public_key: 'key', device_token: token, ...bad }), Rejected);
  }
  assert.equal(equalSecret(token, token), true);
  assert.equal(equalSecret('different-length', token), false);
  assert.equal(equalSecret(undefined, token), false);
});

test('upload mutations cannot target other tables or modify encrypted content', () => {
  const put = transfer();
  assert.deepEqual(batchInput({ batch: [put] }), [put]);
  for (const operation of [
    { ...put, table: 'devices' },
    { ...put, op: 'PATCH', opData: { payload: 'replacement' } },
    { ...put, op: 'PATCH', opData: { burned_at: 'now', payload: 'replacement' } },
    { ...put, op: 'PATCH', opData: [] },
    { ...put, op: 'UNKNOWN' }
  ]) assert.throws(() => batchInput({ batch: [operation] }), Rejected);
  assert.throws(() => batchInput({ batch: Array(101).fill(put) }), Rejected);
});

test('items bind their sender to the authenticated device', () => {
  assert.throws(() => itemInput(transfer({ sender_id: recipient }), sender, now), /Sender/);
  assert.throws(() => itemInput(transfer({ recipient_id: null }), sender, now), /Invalid id/);
  assert.throws(() => itemInput(transfer({ kind: 'link' }), sender, now), /Only transfers/);
});

test('payload limits count UTF-8 bytes rather than JavaScript characters', () => {
  assert.throws(() => itemInput(transfer({ payload: '🦉'.repeat(MAX_PAYLOAD / 4 + 1) }), sender, now), /payload/);
});

test('unclaimed transfers expire, including additions uploaded after their expiry', () => {
  const fresh = itemInput(transfer(), sender, now);
  assert.equal(fresh.expiresAt, new Date(now + DEFAULT_TTL).toISOString());
  const expired = itemInput(transfer({ created_at: new Date(now - 2 * DEFAULT_TTL).toISOString() }), sender, now);
  assert.equal(expired.expired, true);
  assert.equal(expired.payload, null);
  assert.throws(() => itemInput(transfer({ expires_at: new Date(now + 25 * DEFAULT_TTL).toISOString() }), sender, now), /expiry/);
  assert.throws(() => itemInput(transfer({ created_at: 'not a date' }), sender, now), /creation time/);
});

test('retaining a snippet requires the explicit saved kind', () => {
  const saved = itemInput(transfer({ kind: 'saved', recipient_id: null }), sender, now);
  assert.equal(saved.expiresAt, null);
  assert.equal(saved.expired, false);
  assert.throws(() => itemInput(transfer({ kind: 'saved', recipient_id: null, expires_at: new Date(now).toISOString() }), sender, now), /do not expire/);
});

test('pairing code entry tolerates grouping without accepting arbitrary identifiers', () => {
  assert.equal(normalizeCode(' a1b2c-d3e4f '), 'A1B2CD3E4F');
  assert.throws(() => normalizeCode('short'), Rejected);
});

test('pairing relay accepts only three bounded base64 message steps', () => {
  const message = randomBytes(32).toString('base64url');
  assert.deepEqual(pairingMessage({ step: 1, message }), { step: 1, message });
  assert.equal(pairingMessage({ step: 3, message: 'YWJjZA==' }).message, 'YWJjZA==');
  for (const input of [
    null, { step: 0, message }, { step: 4, message }, { step: '1', message },
    { step: 1, message: 'not base64!' }, { step: 1, message: 'a' },
    { step: 1, message: 'A'.repeat(16 * 1024 + 1) }
  ]) assert.throws(() => pairingMessage(input), Rejected);
});
