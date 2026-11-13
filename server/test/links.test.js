import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from '../src/server.js';

test('link metadata exposes the stored encryption version without claiming its ciphertext', async t => {
  const id = '9cbf58a5-e288-4aa3-9ea2-089b54775e44';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let payload = Buffer.from([2, ...new Uint8Array(40)]).toString('base64url');
  let reads = 0;
  const server = await createServer({
    pool: {
      query: async (sql, parameters) => {
        if (sql.startsWith('SELECT expires_at, burned_at, payload')) {
          assert.deepEqual(parameters, [id]);
          reads++;
          return { rows: [{ expires_at: expiresAt, burned_at: null, payload }] };
        }
        assert.doesNotMatch(sql, /FOR UPDATE|burn_reason = \$2/);
        return { rows: [] };
      }
    },
    bootstrapToken: 'x'.repeat(32),
    privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
    powersyncUrl: 'http://localhost:8080', issuer: 'http://localhost:8080'
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/links/${id}`;

  for (const [stored, expected] of [
    [payload, 2],
    [Buffer.from([1, ...new Uint8Array(80)]).toString('base64url'), 1],
    [Buffer.from([9, ...new Uint8Array(40)]).toString('base64url'), 9],
    ['opaque malformed ciphertext', null],
    [null, null]
  ]) {
    payload = stored;
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { expires_at: expiresAt, protocol_version: expected });
    assert.equal(payload, stored);
  }
  assert.equal(reads, 5);
});
