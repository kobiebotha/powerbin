import { createServer as httpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { webFiles, webPath } from './web.js';
import {
  MAX_BODY, Rejected, batchInput, check, deviceInput, equalSecret, hash,
  itemInput, normalizeCode, pairingCode, pairingMessage, text, uuid
} from './domain.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const publicDevice = 'id, name, public_key, admission, created_at';
const bearer = request => request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{1,128})$/)?.[1];
const admission = value => value == null ? null : text(value, 'admission proof', 16 * 1024);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Use application/json');
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch { throw new HttpError(400, 'Expected a JSON object'); }
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function authenticate(pool, request) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Device authentication required');
  const { rows } = await pool.query(
    `SELECT ${publicDevice}, shared_key_envelope FROM devices WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash(token)]
  );
  if (!rows[0]) throw new HttpError(401, 'Device authentication required');
  return rows[0];
}

async function insertDevice(client, device, envelope, proof) {
  const { rows } = await client.query(
    `INSERT INTO devices (id, name, public_key, shared_key_envelope, token_hash, admission)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${publicDevice}`,
    [device.id, device.name, device.public_key, envelope, device.token_hash, proof]
  );
  return rows[0];
}

async function createItem(client, operation, deviceId) {
  const existing = await client.query('SELECT sender_id FROM items WHERE id = $1', [operation.id]);
  if (existing.rows[0]) {
    check(existing.rows[0].sender_id === deviceId, 'Item id belongs to another device');
    return; // Retries never replace immutable content or resurrect burned items.
  }
  const item = itemInput(operation, deviceId);
  if (item.recipientId) {
    const target = await client.query('SELECT id FROM devices WHERE id = $1 AND revoked_at IS NULL', [item.recipientId]);
    check(target.rowCount === 1, 'Recipient is not a paired device');
  }
  const inserted = await client.query(
    `INSERT INTO items (id, kind, sender_id, recipient_id, payload, created_at, expires_at, burned_at, burn_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END, CASE WHEN $8 THEN 'expired' END)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [operation.id, item.kind, deviceId, item.recipientId, item.payload, item.createdAt, item.expiresAt, item.expired]
  );
  if (!inserted.rowCount) {
    const owner = await client.query('SELECT sender_id FROM items WHERE id = $1', [operation.id]);
    check(owner.rows[0]?.sender_id === deviceId, 'Item id belongs to another device');
  }
}

async function burnItem(client, operation, deviceId) {
  const { rows } = await client.query('SELECT kind, sender_id, recipient_id FROM items WHERE id = $1 FOR UPDATE', [operation.id]);
  const item = rows[0];
  if (!item) return;
  const consumed = operation.op === 'PATCH';
  check(consumed
    ? item.kind === 'transfer' && item.recipient_id === deviceId
    : item.kind === 'saved' || item.sender_id === deviceId || item.recipient_id === deviceId,
  'Device cannot burn this item');
  await client.query(
    `UPDATE items SET payload = NULL, burned_at = COALESCE(burned_at, now()),
     burn_reason = COALESCE(burn_reason, $2) WHERE id = $1`,
    [operation.id, consumed ? 'consumed' : 'deleted']
  );
}

export async function expireItems(pool) {
  await pool.query(
    `UPDATE items SET payload = NULL, burned_at = now(), burn_reason = 'expired'
     WHERE burned_at IS NULL AND expires_at <= now()`
  );
  await pool.query('DELETE FROM pairing_sessions WHERE expires_at < now() - interval \'1 day\'');
}

export async function createServer({ pool, bootstrapToken, privateJwk, powersyncUrl, issuer, allowedOrigins = [], webDist }) {
  if (bootstrapToken.length < 32) throw new Error('BOOTSTRAP_TOKEN must be a high-entropy secret of at least 32 characters');
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.d) throw new Error('JWT_PRIVATE_JWK must be a private Ed25519 JWK');
  const signingKey = await importJWK(privateJwk, 'EdDSA');
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, alg: 'EdDSA', use: 'sig', kid: privateJwk.kid || 'powerbin' };
  const origins = new Set([new URL(issuer).origin, ...allowedOrigins]);
  const attempts = new Map();
  const serveWeb = webDist ? await webFiles(webDist) : null;

  function rateLimit(request) {
    const now = Date.now();
    const key = request.socket.remoteAddress;
    const current = attempts.get(key);
    if (current && current.until > now) {
      if (++current.count > 30) throw new HttpError(429, 'Try again shortly');
    } else {
      attempts.set(key, { count: 1, until: now + 60_000 });
      for (const [address, attempt] of attempts) if (attempt.until <= now) attempts.delete(address);
    }
  }

  const server = httpServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!origins.has(origin)) throw new HttpError(403, 'Origin not allowed');
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.writeHead(204); response.end(); return;
      }
      const path = serveWeb ? webPath(request.url) : new URL(request.url, issuer).pathname;
      if (path === null) throw new HttpError(400, 'Invalid path');
      const method = request.method;
      let match;

      if (method === 'GET' && path === '/health') {
        await pool.query('SELECT 1');
        return json(response, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/keys') return json(response, 200, { keys: [publicJwk] });

      if (method === 'POST' && path === '/api/bootstrap') {
        rateLimit(request);
        if (!equalSecret(bearer(request), bootstrapToken)) throw new HttpError(401, 'Setup authentication required');
        const input = await body(request);
        const device = deviceInput(input);
        const envelope = text(input.shared_key_envelope, 'encrypted shared key', 16 * 1024);
        const created = await transaction(pool, async client => {
          await client.query('LOCK TABLE devices IN SHARE ROW EXCLUSIVE MODE');
          const exists = await client.query('SELECT id FROM devices LIMIT 1');
          if (exists.rowCount) throw new HttpError(409, 'This installation is already configured');
          return insertDevice(client, device, envelope, admission(input.admission));
        });
        return json(response, 201, { device: created });
      }

      if (method === 'POST' && path === '/api/pairings') {
        rateLimit(request);
        const device = deviceInput(await body(request));
        const id = randomUUID();
        const code = pairingCode();
        const { rows } = await pool.query(
          `INSERT INTO pairing_sessions (id, code, device_id, name, public_key, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes') RETURNING expires_at`,
          [id, code, device.id, device.name, device.public_key, device.token_hash]
        );
        return json(response, 201, { id, code: `${code.slice(0, 5)}-${code.slice(5)}`, expires_at: rows[0].expires_at });
      }

      if (method === 'GET' && (match = path.match(/^\/api\/pairings\/code\/([^/]+)$/))) {
        await authenticate(pool, request);
        const { rows } = await pool.query(
          `SELECT id, device_id, name, public_key, approver_id, expires_at FROM pairing_sessions
           WHERE code = $1 AND approved_at IS NULL AND expires_at > now()`, [normalizeCode(match[1])]
        );
        if (!rows[0]) throw new HttpError(404, 'Pairing code unavailable');
        return json(response, 200, rows[0]);
      }

      if (method === 'GET' && (match = path.match(/^\/api\/pairings\/([^/]+)$/))) {
        const token = bearer(request);
        if (!token) throw new HttpError(401, 'Pairing authentication required');
        const { rows } = await pool.query(
          `SELECT id, device_id, name, public_key, token_hash, approver_id, messages, approved_at, expires_at
           FROM pairing_sessions WHERE id = $1`, [uuid(match[1])]
        );
        const pairing = rows[0];
        if (!pairing) throw new HttpError(404, 'Pairing unavailable');
        if (pairing.token_hash !== hash(token)) {
          const device = await authenticate(pool, request);
          if (pairing.approver_id && pairing.approver_id !== device.id) throw new HttpError(403, 'Another device is pairing');
        }
        if (!pairing.approved_at && new Date(pairing.expires_at).getTime() <= Date.now()) throw new HttpError(410, 'Pairing expired');
        const { token_hash, ...visible } = pairing;
        return json(response, 200, { ...visible, status: pairing.approved_at ? 'approved' : 'pending' });
      }

      if (method === 'POST' && (match = path.match(/^\/api\/pairings\/([^/]+)\/messages$/))) {
        const token = bearer(request);
        if (!token) throw new HttpError(401, 'Pairing authentication required');
        const { step, message } = pairingMessage(await body(request));
        const result = await transaction(pool, async client => {
          const { rows } = await client.query('SELECT * FROM pairing_sessions WHERE id = $1 AND expires_at > now() FOR UPDATE', [uuid(match[1])]);
          const pairing = rows[0];
          if (!pairing) throw new HttpError(410, 'Pairing unavailable');
          const candidate = pairing.token_hash === hash(token);
          const approver = candidate ? null : await authenticate(client, request);
          if (candidate ? step === 2 : step !== 2) throw new HttpError(403, 'Invalid pairing role');
          if (approver && pairing.approver_id && pairing.approver_id !== approver.id) throw new HttpError(403, 'Another device is pairing');
          const messages = pairing.messages;
          if (messages[step - 1] !== undefined) {
            if (messages[step - 1] !== message) throw new HttpError(409, 'Pairing message is immutable');
            return { status: 200, messages, approver_id: pairing.approver_id };
          }
          if (pairing.approved_at || messages.length !== step - 1) throw new HttpError(409, 'Pairing message out of order');
          messages.push(message);
          const approverId = approver?.id || pairing.approver_id;
          await client.query('UPDATE pairing_sessions SET messages = $2::jsonb, approver_id = $3 WHERE id = $1', [pairing.id, JSON.stringify(messages), approverId]);
          return { status: 201, messages, approver_id: approverId };
        });
        return json(response, result.status, { messages: result.messages, approver_id: result.approver_id });
      }

      if (method === 'POST' && (match = path.match(/^\/api\/pairings\/([^/]+)\/approve$/))) {
        const approver = await authenticate(pool, request);
        const input = await body(request);
        const envelope = text(input.shared_key_envelope, 'encrypted shared key', 16 * 1024);
        const proof = admission(input.admission);
        const device = await transaction(pool, async client => {
          const { rows } = await client.query(
            `SELECT * FROM pairing_sessions WHERE id = $1 AND approved_at IS NULL AND expires_at > now() FOR UPDATE`,
            [uuid(match[1])]
          );
          const pairing = rows[0];
          if (!pairing) throw new HttpError(410, 'Pairing unavailable');
          check(pairing.messages.length === 3, 'Finish the pairing handshake before approval');
          if (pairing.approver_id !== approver.id) throw new HttpError(403, 'Approve on the device that performed the handshake');
          check(input.public_key === pairing.public_key, 'Pairing key changed; verify the device again');
          const created = await insertDevice(client, { ...pairing, id: pairing.device_id }, envelope, proof);
          await client.query('UPDATE pairing_sessions SET approved_at = now() WHERE id = $1', [pairing.id]);
          return created;
        });
        return json(response, 201, { device });
      }

      if (method === 'GET' && path === '/api/session') {
        const device = await authenticate(pool, request);
        const token = await new SignJWT({ device_id: device.id }).setProtectedHeader({ alg: 'EdDSA', kid: publicJwk.kid })
          .setSubject(device.id).setIssuer(issuer).setAudience('powersync').setIssuedAt().setExpirationTime('5m').sign(signingKey);
        return json(response, 200, {
          device,
          powersync: { endpoint: powersyncUrl, token, expires_at: new Date(Date.now() + 300_000).toISOString() }
        });
      }

      if (method === 'GET' && path === '/api/devices') {
        await authenticate(pool, request);
        const { rows } = await pool.query(`SELECT ${publicDevice} FROM devices WHERE revoked_at IS NULL ORDER BY created_at`);
        return json(response, 200, { devices: rows });
      }
      if (method === 'POST' && (match = path.match(/^\/api\/devices\/([^/]+)\/rename$/))) {
        await authenticate(pool, request);
        const input = await body(request);
        const name = text(input.name, 'device name', 64);
        check(name.trim().length > 0, 'Invalid device name');
        const proof = text(input.admission, 'admission proof', 16 * 1024);
        check(proof.trim().length > 0, 'Invalid admission proof');
        // The admission proof binds the exact name bytes; do not normalize the name here.
        const { rows } = await pool.query(
          `UPDATE devices SET name = $2, admission = $3
           WHERE id = $1 AND revoked_at IS NULL RETURNING ${publicDevice}`,
          [uuid(match[1]), name, proof]
        );
        if (!rows[0]) throw new HttpError(404, 'Device unavailable');
        return json(response, 200, { device: rows[0] });
      }
      if (method === 'DELETE' && (match = path.match(/^\/api\/devices\/([^/]+)$/))) {
        await authenticate(pool, request);
        await pool.query('UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [uuid(match[1])]);
        return json(response, 200, { revoked: true });
      }

      if (method === 'POST' && path === '/api/upload') {
        const device = await authenticate(pool, request);
        const input = await body(request);
        try {
          const batch = batchInput(input);
          await transaction(pool, async client => {
            for (const operation of batch) {
              if (operation.op === 'PUT') await createItem(client, operation, device.id);
              else await burnItem(client, operation, device.id);
            }
          });
          return json(response, 200, { accepted: true });
        } catch (error) {
          // Acknowledge permanent rejection so PowerSync can complete this upload and reconcile.
          if (error instanceof Rejected) return json(response, 200, { accepted: false, error: error.message });
          throw error;
        }
      }

      if ((match = path.match(/^\/api\/links\/([^/]+)(\/reveal)?$/))) {
        const id = uuid(match[1]);
        if (method === 'GET' && !match[2]) {
          const { rows } = await pool.query('SELECT expires_at, burned_at FROM items WHERE id = $1 AND kind = \'link\'', [id]);
          if (!rows[0]) throw new HttpError(404, 'Link unavailable');
          if (rows[0].burned_at || new Date(rows[0].expires_at).getTime() <= Date.now()) throw new HttpError(410, 'Link consumed or expired');
          return json(response, 200, { expires_at: rows[0].expires_at });
        }
        if (method === 'POST' && match[2]) {
          rateLimit(request);
          await body(request);
          const result = await transaction(pool, async client => {
            const { rows } = await client.query('SELECT payload, expires_at, burned_at FROM items WHERE id = $1 AND kind = \'link\' FOR UPDATE', [id]);
            const item = rows[0];
            if (!item) return { status: 404, body: { error: 'Link unavailable' } };
            if (item.burned_at) return { status: 410, body: { error: 'Link consumed or expired' } };
            const expired = new Date(item.expires_at).getTime() <= Date.now();
            await client.query('UPDATE items SET payload = NULL, burned_at = now(), burn_reason = $2 WHERE id = $1', [id, expired ? 'expired' : 'consumed']);
            return expired
              ? { status: 410, body: { error: 'Link consumed or expired' } }
              : { status: 200, body: { payload: item.payload } };
          });
          return json(response, result.status, result.body);
        }
      }
      if (serveWeb && await serveWeb(request, response)) return;
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof Rejected ? 400 : 500;
      if (status === 500) console.error('Backend error:', error.code || error.name);
      if (!response.headersSent && !response.destroyed) json(response, status, { error: status === 500 ? 'Internal server error' : error.message });
    }
  });

  let cleanup;
  server.once('listening', () => {
    const expire = () => expireItems(pool).catch(error => console.error('Expiry error:', error.code || error.name));
    expire();
    cleanup = setInterval(expire, 60_000);
    cleanup.unref();
  });
  server.once('close', () => clearInterval(cleanup));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
