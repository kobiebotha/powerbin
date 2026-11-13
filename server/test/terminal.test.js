import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

const id = '9cbf58a5-e288-4aa3-9ea2-089b54775e44';
const missing = 'ed70e50d-570d-4c1b-8cb7-a484ae6bc44a';

function get(server, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('terminal link view reads availability without revealing or burning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>PowerBin</title>');
  const item = { expires_at: new Date(Date.now() + 60_000).toISOString(), burned_at: null };
  const reads = [];
  const server = await createServer({
    pool: {
      query: async (sql, parameters) => {
        if (sql.startsWith('SELECT expires_at, burned_at')) {
          reads.push(parameters[0]);
          return { rows: parameters[0] === id ? [item] : [] };
        }
        // The server's periodic expiry sweep does not claim a particular link.
        assert.doesNotMatch(sql, /FOR UPDATE|burn_reason = \$2/);
        return { rows: [] };
      }
    },
    bootstrapToken: 'x'.repeat(32),
    privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
    powersyncUrl: 'http://localhost:8080', issuer: 'http://localhost:8080', webDist: directory
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('curl gets readable instructions and safe cache headers', async () => {
    const response = await get(server, `/?link=${id}`, { headers: { 'user-agent': 'curl/8.10.1', accept: '*/*' } });
    assert.equal(response.status, 200);
    assert.match(response.body, /Status:  Available/);
    assert.match(response.body, /pnpx powerbin reveal/);
    assert.match(response.body, /has not consumed/);
    assert.doesNotMatch(response.body, /<html|<script/);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.vary, 'Accept, User-Agent');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(reads.at(-1), id);
    assert.equal(item.burned_at, null);
  });
  await t.test('HEAD reads availability and emits no body', async () => {
    const response = await get(server, `/?link=${id}`, { method: 'HEAD', headers: { accept: 'text/plain' } });
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
    assert.ok(Number(response.headers['content-length']) > 0);
    assert.equal(item.burned_at, null);
  });
  await t.test('browsers receive HTML and negotiation varies both representations', async () => {
    for (const headers of [
      { accept: 'text/html, */*;q=0.8' },
      { accept: 'text/plain;q=0, */*', 'user-agent': 'curl/8.10.1' },
      { accept: 'text/html, text/plain;q=0.5', 'user-agent': 'curl/8.10.1' }
    ]) {
      const response = await get(server, `/?link=${id}`, { headers });
      assert.equal(response.status, 200);
      assert.match(response.body, /<title>PowerBin/);
      assert.equal(response.headers.vary, 'Accept, User-Agent, Accept-Encoding');
    }
    const explicitText = await get(server, `/?link=${id}`, { headers: { accept: 'text/plain' } });
    assert.equal(explicitText.headers['content-type'], 'text/plain; charset=utf-8');
  });
  await t.test('malformed and duplicate IDs fail before a database read', async () => {
    const count = reads.length;
    for (const query of ['link=invalid', `link=${id}&link=${id}`]) {
      const response = await get(server, `/?${query}`, { headers: { accept: 'text/plain' } });
      assert.equal(response.status, 400);
      assert.match(response.body, /Invalid link/);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(reads.length, count);
  });
  await t.test('unavailable, consumed, and expired states remain readable', async () => {
    const absent = await get(server, `/?link=${missing}`, { headers: { accept: 'text/plain' } });
    assert.equal(absent.status, 404);
    assert.match(absent.body, /unavailable/);
    item.burned_at = new Date().toISOString();
    const burned = await get(server, `/?link=${id}`, { headers: { accept: 'text/plain' } });
    assert.equal(burned.status, 410);
    assert.match(burned.body, /consumed or has expired/);
    item.burned_at = null;
    item.expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await get(server, `/?link=${id}`, { headers: { accept: 'text/plain' } })).status, 410);
  });
});
