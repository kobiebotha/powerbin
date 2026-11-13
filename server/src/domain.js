import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_PAYLOAD = 64 * 1024;
export const MAX_BODY = 1024 * 1024;
export const DEFAULT_TTL = 60 * 60 * 1000;
export const MAX_TTL = 24 * DEFAULT_TTL;
export const LINK_TTL = 48 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class Rejected extends Error {}

export function check(condition, message) {
  if (!condition) throw new Rejected(message);
}

export function uuid(value) {
  check(typeof value === 'string' && UUID.test(value), 'Invalid id');
  return value;
}

export function text(value, name, max) {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max, `Invalid ${name}`);
  return value;
}

export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function equalSecret(actual, expected) {
  return typeof actual === 'string' && typeof expected === 'string' &&
    timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'));
}

export function credential(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value), 'Invalid device token');
  return hash(value);
}

export function deviceInput(body) {
  check(body && typeof body === 'object' && !Array.isArray(body), 'Invalid device');
  return {
    id: uuid(body.device_id),
    name: text(typeof body.name === 'string' ? body.name.trim() : null, 'device name', 64),
    public_key: text(body.public_key, 'public key', 8192),
    token_hash: credential(body.device_token)
  };
}

export function pairingCode() {
  // 40 random bits, displayed as two groups; approval still requires a trusted device.
  return randomBytes(5).toString('hex').toUpperCase();
}

export function normalizeCode(value) {
  const code = String(value).toUpperCase().replace(/[\s-]/g, '');
  check(/^[0-9A-F]{10}$/.test(code), 'Invalid pairing code');
  return code;
}

export function pairingMessage(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Invalid pairing message');
  check(Number.isInteger(input.step) && input.step >= 1 && input.step <= 3, 'Invalid pairing step');
  const message = text(input.message, 'pairing message', 16 * 1024);
  check(/^[A-Za-z0-9+/_-]+={0,2}$/.test(message), 'Invalid pairing message');
  const normalized = message.replace(/-/g, '+').replace(/_/g, '/');
  const encoded = Buffer.from(normalized, 'base64').toString('base64');
  check(encoded === normalized || encoded.replace(/=+$/, '') === normalized, 'Invalid pairing message');
  return { step: input.step, message };
}

export function batchInput(body) {
  check(Array.isArray(body?.batch) && body.batch.length > 0 && body.batch.length <= 100, 'Expected 1–100 mutations');
  for (const operation of body.batch) {
    check(operation && operation.table === 'items', 'Only items can be uploaded');
    uuid(operation.id);
    check(['PUT', 'PATCH', 'DELETE'].includes(operation.op), 'Invalid operation');
    if (operation.op !== 'DELETE') {
      check(operation.opData && typeof operation.opData === 'object' && !Array.isArray(operation.opData), 'Missing operation data');
    }
    if (operation.op === 'PATCH') {
      const keys = Object.keys(operation.opData);
      check(keys.length === 1 && keys[0] === 'burned_at' && operation.opData.burned_at, 'Items are immutable; only burning is supported');
    }
  }
  return body.batch;
}

export function itemInput(operation, deviceId, now = Date.now()) {
  const data = operation.opData;
  check(data.sender_id === deviceId, 'Sender must be the authenticated device');
  check(['transfer', 'saved', 'link'].includes(data.kind), 'Invalid item kind');
  const payload = text(data.payload, 'encrypted payload', MAX_PAYLOAD);
  const recipientId = data.kind === 'transfer' ? uuid(data.recipient_id) : null;
  check(data.kind === 'transfer' || data.recipient_id == null, 'Only transfers have a recipient');
  check(data.created_at == null || typeof data.created_at === 'string', 'Invalid creation time');
  const createdAt = data.created_at == null ? now : Date.parse(data.created_at);
  check(Number.isFinite(createdAt) && createdAt <= now + 5 * 60 * 1000, 'Invalid creation time');
  let expiresAt = null;
  if (data.kind === 'saved') {
    check(data.expires_at == null, 'Saved snippets do not expire');
  } else {
    check(data.expires_at == null || typeof data.expires_at === 'string', 'Invalid expiry');
    const defaultTtl = data.kind === 'link' ? LINK_TTL : DEFAULT_TTL;
    const maxTtl = data.kind === 'link' ? LINK_TTL : MAX_TTL;
    expiresAt = data.expires_at == null ? createdAt + defaultTtl : Date.parse(data.expires_at);
    check(Number.isFinite(expiresAt) && expiresAt >= createdAt && expiresAt <= createdAt + maxTtl, 'Invalid expiry');
  }
  return {
    kind: data.kind,
    recipientId,
    payload: expiresAt !== null && expiresAt <= now ? null : payload,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    expired: expiresAt !== null && expiresAt <= now
  };
}
