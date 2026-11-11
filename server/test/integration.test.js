import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { exportJWK, generateKeyPair, jwtVerify, createLocalJWKSet } from 'jose';
import { createServer } from '../src/server.js';
import { migrate } from '../src/migrate.js';

test('device authorization and transfer lifecycle', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `relay_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const setupToken = randomBytes(32).toString('base64url');
  const issuer = 'https://relay.test';
  server = await createServer({ pool, bootstrapToken: setupToken, privateJwk: await exportJWK(privateKey), powersyncUrl: 'https://sync.test', issuer });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  }
  const device = name => ({ device_id: randomUUID(), name, public_key: `public:${name}`, device_token: randomBytes(32).toString('base64url') });
  const mac = device('Mac');
  const phone = device('Phone');
  const other = device('Other');
  const messages = ['first', 'second', 'third'].map(value => Buffer.from(value).toString('base64'));
  const relay = (pending, actor, step, message = messages[step - 1]) => request(`/api/pairings/${pending.id}/messages`, {
    method: 'POST', token: actor.device_token, body: { step, message }
  });
  async function handshake(pending, candidate) {
    assert.equal((await relay(pending, candidate, 1)).status, 201);
    assert.equal((await relay(pending, mac, 2)).status, 201);
    assert.equal((await request(`/api/pairings/${pending.id}`, { token: candidate.device_token })).body.messages[1], messages[1]);
    assert.equal((await relay(pending, candidate, 3)).status, 201);
  }
  async function pair(candidate) {
    const pending = await request('/api/pairings', { method: 'POST', body: candidate });
    assert.equal(pending.status, 201);
    const found = await request(`/api/pairings/code/${pending.body.code}`, { token: mac.device_token });
    assert.equal(found.body.public_key, candidate.public_key);
    await handshake(pending.body, candidate);
    const approved = await request(`/api/pairings/${pending.body.id}/approve`, {
      method: 'POST', token: mac.device_token,
      body: { public_key: candidate.public_key, shared_key_envelope: `encrypted-key:${candidate.name}`, admission: `proof:${candidate.name}` }
    });
    assert.equal(approved.status, 201);
    return pending.body;
  }
  const mutation = (sender, data = {}) => ({
    op: 'PUT', table: 'items', id: randomUUID(),
    opData: { sender_id: sender.device_id, recipient_id: phone.device_id, kind: 'transfer', payload: 'opaque ciphertext', ...data }
  });
  const upload = (sender, ...batch) => request('/api/upload', { method: 'POST', token: sender.device_token, body: { batch } });

  await t.test('bootstrap is authenticated and single use; new devices require approval', async () => {
    assert.equal((await request('/api/bootstrap', { method: 'POST', body: { ...mac, shared_key_envelope: 'encrypted-key:mac' } })).status, 401);
    assert.equal((await request('/api/bootstrap', { method: 'POST', token: setupToken, body: { ...mac, shared_key_envelope: 'encrypted-key:mac', admission: 'proof:Mac' } })).status, 201);
    assert.equal((await request('/api/bootstrap', { method: 'POST', token: setupToken, body: { ...phone, shared_key_envelope: 'key' } })).status, 409);
    assert.equal((await request('/api/session', { token: phone.device_token })).status, 401);
    await pair(phone);
    await pair(other);
    const session = await request('/api/session', { token: phone.device_token });
    assert.equal(session.body.device.shared_key_envelope, 'encrypted-key:Phone');
    assert.equal(session.body.device.admission, 'proof:Phone');
    const directory = await request('/api/devices', { token: mac.device_token });
    assert.equal(directory.body.devices.find(device => device.id === phone.device_id).admission, 'proof:Phone');
    const keys = await request('/api/keys');
    assert.equal(keys.body.keys[0].d, undefined);
    const verified = await jwtVerify(session.body.powersync.token, createLocalJWKSet(keys.body), { issuer, audience: 'powersync' });
    assert.equal(verified.payload.sub, phone.device_id);
  });

  await t.test('mutation rejection rolls back the whole transaction and acknowledges it', async () => {
    const first = mutation(mac);
    const bad = mutation(mac, { sender_id: phone.device_id });
    const result = await upload(mac, first, bad);
    assert.equal(result.status, 200);
    assert.equal(result.body.accepted, false);
    assert.equal((await pool.query('SELECT id FROM items WHERE id = $1', [first.id])).rowCount, 0);
  });

  await t.test('pairing approval is bound to its key and expired codes cannot enroll', async () => {
    const candidate = device('Unapproved');
    const pending = await request('/api/pairings', { method: 'POST', body: candidate });
    await handshake(pending.body, candidate);
    const approval = { method: 'POST', token: mac.device_token, body: { public_key: 'different key', shared_key_envelope: 'encrypted key' } };
    assert.equal((await request(`/api/pairings/${pending.body.id}/approve`, approval)).status, 400);
    await pool.query('UPDATE pairing_sessions SET expires_at = now() - interval \'1 second\' WHERE id = $1', [pending.body.id]);
    assert.equal((await request(`/api/pairings/${pending.body.id}`, { token: candidate.device_token })).status, 410);
    assert.equal((await request(`/api/pairings/code/${pending.body.code}`, { token: mac.device_token })).status, 404);
    approval.body.public_key = candidate.public_key;
    assert.equal((await request(`/api/pairings/${pending.body.id}/approve`, approval)).status, 410);
    assert.equal((await pool.query('SELECT id FROM devices WHERE id = $1', [candidate.device_id])).rowCount, 0);
  });

  await t.test('relay enforces sequence, roles, approver binding and immutable retries', async () => {
    const candidate = device('PowerBin candidate');
    const { body: pending } = await request('/api/pairings', { method: 'POST', body: candidate });
    const approve = actor => request(`/api/pairings/${pending.id}/approve`, {
      method: 'POST', token: actor.device_token,
      body: { public_key: candidate.public_key, shared_key_envelope: 'encrypted grant', admission: 'opaque admission proof' }
    });
    assert.equal((await approve(mac)).status, 400);
    assert.equal((await relay(pending, candidate, 2)).status, 403);
    assert.equal((await relay(pending, mac, 1)).status, 403);
    assert.equal((await relay(pending, candidate, 3)).status, 409);
    assert.equal((await relay(pending, candidate, 1)).status, 201);
    assert.equal((await relay(pending, candidate, 1)).status, 200);
    assert.equal((await relay(pending, candidate, 1, 'Y2hhbmdlZA==')).status, 409);
    assert.equal((await relay(pending, mac, 2)).status, 201);
    assert.equal((await relay(pending, phone, 2)).status, 403);
    assert.equal((await request(`/api/pairings/${pending.id}`, { token: phone.device_token })).status, 403);
    const transcript = await request(`/api/pairings/${pending.id}`, { token: mac.device_token });
    assert.equal(transcript.body.approver_id, mac.device_id);
    assert.equal(transcript.body.token_hash, undefined);
    assert.deepEqual(transcript.body.messages, messages.slice(0, 2));
    assert.equal((await relay(pending, candidate, 3)).status, 201);
    assert.equal((await relay(pending, candidate, 1)).status, 200);
    assert.equal((await approve(phone)).status, 403);
    assert.equal((await approve(mac)).status, 201);
    assert.equal((await relay(pending, candidate, 3)).status, 200);
  });

  await t.test('only the chosen recipient can consume; retries cannot restore burned content', async () => {
    const item = mutation(mac);
    assert.equal((await upload(mac, item)).body.accepted, true);
    const consume = { op: 'PATCH', table: 'items', id: item.id, opData: { burned_at: new Date().toISOString() } };
    assert.equal((await upload(other, consume)).body.accepted, false);
    assert.equal((await upload(phone, consume)).body.accepted, true);
    assert.equal((await upload(mac, item)).body.accepted, true);
    const { rows } = await pool.query('SELECT payload, burn_reason FROM items WHERE id = $1', [item.id]);
    assert.equal(rows[0].payload, null);
    assert.equal(rows[0].burn_reason, 'consumed');
  });

  await t.test('guest GET does not consume and concurrent reveals return ciphertext at most once', async () => {
    const item = mutation(mac, { kind: 'link', recipient_id: null });
    await upload(mac, item);
    assert.equal((await request(`/api/links/${item.id}`)).status, 200);
    assert.equal((await request(`/api/links/${item.id}`)).status, 200);
    const results = await Promise.all([
      request(`/api/links/${item.id}/reveal`, { method: 'POST' }),
      request(`/api/links/${item.id}/reveal`, { method: 'POST' })
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
    assert.equal(results.find(result => result.status === 200).body.payload, 'opaque ciphertext');
    const { rows } = await pool.query('SELECT payload FROM items WHERE id = $1', [item.id]);
    assert.equal(rows[0].payload, null);
  });

  await t.test('expired offline uploads never persist their ciphertext', async () => {
    const item = mutation(mac, { kind: 'link', recipient_id: null, created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
    assert.equal((await upload(mac, item)).body.accepted, true);
    const { rows } = await pool.query('SELECT payload, burn_reason FROM items WHERE id = $1', [item.id]);
    assert.equal(rows[0].payload, null);
    assert.equal(rows[0].burn_reason, 'expired');
    assert.equal((await request(`/api/links/${item.id}/reveal`, { method: 'POST' })).status, 410);
  });

  await t.test('paired devices can rename themselves and peers without changing identity', async () => {
    const rename = (target, name, admission) => request(`/api/devices/${target.device_id}/rename`, {
      method: 'POST', token: mac.device_token, body: { name, admission }
    });
    const beforeMac = (await pool.query('SELECT * FROM devices WHERE id = $1', [mac.device_id])).rows[0];
    const beforePhone = (await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0];

    const self = await rename(mac, 'Work Mac', 'proof:Work Mac');
    assert.equal(self.status, 200);
    assert.equal(self.body.device.name, 'Work Mac');
    assert.equal(self.body.device.admission, 'proof:Work Mac');
    assert.deepEqual(Object.keys(self.body.device).sort(), ['admission', 'created_at', 'id', 'name', 'public_key']);
    assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [mac.device_id])).rows[0], {
      ...beforeMac, name: 'Work Mac', admission: 'proof:Work Mac'
    });

    // The limit is 64 UTF-8 bytes, not 64 JavaScript characters.
    const boundaryName = '🟢'.repeat(16);
    const boundary = await rename(phone, boundaryName, 'proof:Unicode boundary');
    assert.equal(boundary.status, 200);
    assert.equal(boundary.body.device.name, boundaryName);

    // The client signs exact name bytes. The server must preserve surrounding whitespace.
    const name = '  Téléphone 🟢  ';
    const proof = 'proof:exact Unicode name';
    const peer = await rename(phone, name, proof);
    assert.equal(peer.status, 200);
    assert.equal(peer.body.device.name, name);
    assert.equal(peer.body.device.admission, proof);
    assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0], {
      ...beforePhone, name, admission: proof
    });

    const directory = await request('/api/devices', { token: mac.device_token });
    const listed = directory.body.devices.find(device => device.id === phone.device_id);
    assert.equal(listed.name, name);
    assert.equal(listed.admission, proof);
    const selfSession = await request('/api/session', { token: mac.device_token });
    assert.equal(selfSession.status, 200);
    assert.equal(selfSession.body.device.name, 'Work Mac');
    assert.equal(selfSession.body.device.admission, 'proof:Work Mac');
    const peerSession = await request('/api/session', { token: phone.device_token });
    assert.equal(peerSession.status, 200);
    assert.equal(peerSession.body.device.name, name);
    assert.equal(peerSession.body.device.admission, proof);
  });

  await t.test('invalid or unauthenticated renames preserve the entire device record', async () => {
    const path = `/api/devices/${phone.device_id}/rename`;
    const before = (await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0];
    const valid = { name: 'Updated phone', admission: 'proof:updated' };
    assert.equal((await request(path, { method: 'POST', body: valid })).status, 401);
    assert.equal((await request(path, { method: 'POST', token: randomBytes(32).toString('base64url'), body: valid })).status, 401);

    for (const input of [
      { ...valid, name: '' },
      { ...valid, name: ' \t\n ' },
      { ...valid, name: null },
      { ...valid, name: 123 },
      { ...valid, name: 'x'.repeat(65) },
      { ...valid, name: '🟢'.repeat(17) },
      { ...valid, admission: '' },
      { ...valid, admission: ' \t\n ' },
      { ...valid, admission: null },
      { ...valid, admission: 123 },
      { ...valid, admission: 'x'.repeat(16 * 1024 + 1) },
      { name: valid.name },
      { admission: valid.admission }
    ]) {
      assert.equal((await request(path, { method: 'POST', token: mac.device_token, body: input })).status, 400);
      assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0], before);
    }
    assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0], before);
  });

  await t.test('unpair requires authentication, is idempotent and blocks revoked devices', async () => {
    const path = `/api/devices/${other.device_id}`;
    const revokedAt = async () => (await pool.query('SELECT revoked_at::text FROM devices WHERE id = $1', [other.device_id])).rows[0].revoked_at;

    assert.equal((await request(path, { method: 'DELETE' })).status, 401);
    assert.equal(await revokedAt(), null);
    assert.equal((await request('/api/session', { token: other.device_token })).status, 200);

    const unpaired = await request(path, { method: 'DELETE', token: mac.device_token });
    assert.equal(unpaired.status, 200);
    assert.equal(unpaired.body.revoked, true);
    const timestamp = await revokedAt();
    assert.ok(timestamp);
    assert.equal((await request(path, { method: 'DELETE', token: mac.device_token })).status, 200);
    assert.equal(await revokedAt(), timestamp);

    const directory = await request('/api/devices', { token: mac.device_token });
    assert.equal(directory.status, 200);
    assert.equal(directory.body.devices.some(device => device.id === other.device_id), false);
    assert.equal(directory.body.devices.some(device => device.id === mac.device_id), true);
    assert.equal(directory.body.devices.some(device => device.id === phone.device_id), true);
    assert.equal((await request('/api/session', { token: other.device_token })).status, 401);

    const revokedWrite = mutation(other);
    assert.equal((await upload(other, revokedWrite)).status, 401);
    assert.equal((await pool.query('SELECT id FROM items WHERE id = $1', [revokedWrite.id])).rowCount, 0);

    const revokedRecipient = mutation(mac, { recipient_id: other.device_id });
    const rejected = await upload(mac, revokedRecipient);
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.accepted, false);
    assert.equal((await pool.query('SELECT id FROM items WHERE id = $1', [revokedRecipient.id])).rowCount, 0);

    assert.equal((await request('/api/session', { token: mac.device_token })).status, 200);
    const activeTransfer = mutation(mac);
    assert.equal((await upload(mac, activeTransfer)).body.accepted, true);
    assert.equal((await pool.query('SELECT id FROM items WHERE id = $1', [activeTransfer.id])).rowCount, 1);
  });

  await t.test('rename rejects revoked callers and missing or revoked targets', async () => {
    const body = { name: 'Renamed device', admission: 'proof:rename' };
    const before = (await pool.query('SELECT * FROM devices WHERE id = $1', [other.device_id])).rows[0];
    assert.ok(before.revoked_at);
    const activeBefore = (await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0];
    assert.equal((await request(`/api/devices/${phone.device_id}/rename`, {
      method: 'POST', token: other.device_token, body
    })).status, 401);
    assert.equal((await request(`/api/devices/${other.device_id}/rename`, {
      method: 'POST', token: mac.device_token, body
    })).status, 404);
    assert.equal((await request(`/api/devices/${randomUUID()}/rename`, {
      method: 'POST', token: mac.device_token, body
    })).status, 404);
    assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [other.device_id])).rows[0], before);
    assert.deepEqual((await pool.query('SELECT * FROM devices WHERE id = $1', [phone.device_id])).rows[0], activeBefore);
  });
});
