import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

const id = '9cbf58a5-e288-4aa3-9ea2-089b54775e44';
const config = {
  bootstrapToken: 'x'.repeat(32),
  privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  powersyncUrl: 'https://sync.test', issuer: 'https://powerbin.test', trustedProxyHeader: 'x-real-ip'
};

function send(server, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTPS deployments reject HTTP before serving files or accessing one-time links', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-https-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'index.html'), '<!doctype html><title>PowerBin</title>'),
    writeFile(join(directory, 'app.js'), 'export const powerbin = true;')
  ]);
  const item = { expires_at: new Date(Date.now() + 60_000).toISOString(), burned_at: null, payload: 'encrypted message' };
  const queries = [];
  const query = async (sql, parameters) => {
    // Ignore the independent startup/periodic expiry sweep.
    if (sql.includes("burn_reason = 'expired'") || sql.startsWith('DELETE FROM pairing_sessions')) return { rows: [] };
    queries.push(sql);
    if (sql.startsWith('SELECT') && sql.includes('FROM items')) {
      assert.deepEqual(parameters, [id]);
      return { rows: [{ ...item }] };
    }
    if (sql.startsWith('UPDATE items')) {
      item.payload = null;
      item.burned_at = new Date().toISOString();
    }
    return { rows: [] };
  };
  const server = await createServer({
    ...config, webDist: directory,
    pool: { query, connect: async () => { queries.push('connect'); return { query, release() {} }; } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('an HTTP reveal neither returns ciphertext nor consumes the message', async () => {
    const response = await send(server, `/api/links/${id}/reveal`, {
      method: 'POST', headers: { 'x-forwarded-proto': 'http', 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body, /encrypted message/);
    assert.deepEqual(queries, []);
    assert.equal(item.payload, 'encrypted message');
    assert.equal(item.burned_at, null);
  });

  const routes = [
    ['GET', `/?link=${id}`, { accept: 'text/html' }],
    ['GET', '/'],
    ['GET', `/?link=${id}`, { accept: 'text/plain', 'user-agent': 'curl/8.10.1' }],
    ['HEAD', `/?link=${id}`],
    ['GET', '/app.js'],
    ['GET', `/api/links/${id}`],
    ['POST', `/api/links/${id}/reveal`],
    ['POST', '/api/bootstrap', { authorization: `Bearer ${config.bootstrapToken}` }],
    ['POST', '/api/pairings'],
    ['GET', '/api/session'],
    ['OPTIONS', `/api/links/${id}/reveal`, { origin: config.issuer }]
  ];

  await t.test('HTTP forwarded by a proxy is rejected on every route', async () => {
    for (const [method, path, headers] of [...routes, ['GET', '/health'], ['GET', '/api/keys']]) {
      const response = await send(server, path, { method, headers: { ...headers, 'x-forwarded-proto': 'http' } });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers.location, undefined);
      assert.equal(response.headers['strict-transport-security'], undefined);
      if (method !== 'HEAD') assert.deepEqual(JSON.parse(response.body), { error: 'HTTPS required' });
    }
    assert.deepEqual(queries, []);
    assert.equal(item.payload, 'encrypted message');
    assert.equal(item.burned_at, null);
  });

  await t.test('missing, invalid, or ambiguous protocol headers cannot bypass HTTPS', async () => {
    for (const [method, path, headers] of routes) {
      const response = await send(server, path, { method, headers: { ...headers, host: 'localhost' } });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    for (const protocol of ['', 'ftp', 'https, http', 'http, https', ['https', 'http']]) {
      assert.equal((await send(server, '/', { headers: { 'x-forwarded-proto': protocol } })).status, 403);
    }
    assert.deepEqual(queries, []);
    assert.equal(item.burned_at, null);
  });

  await t.test('direct internal health and public-key reads remain available', async () => {
    assert.equal((await send(server, '/health', { headers: { host: 'healthcheck.railway.app' } })).status, 200);
    const keys = await send(server, '/api/keys', { headers: { host: 'powerbin.railway.internal' } });
    assert.equal(keys.status, 200);
    assert.equal(JSON.parse(keys.body).keys[0].d, undefined);
    assert.equal(keys.headers['strict-transport-security'], undefined);
    for (const path of ['/health?link=anything', '/api/keys?link=anything']) {
      assert.equal((await send(server, path)).status, 403);
    }
    assert.equal((await send(server, '/api/keys', { method: 'POST' })).status, 403);
  });

  await t.test('HTTPS serves the app and APIs with HSTS, including error responses', async () => {
    const headers = { 'x-forwarded-proto': 'https' };
    for (const path of ['/', `/?link=${id}`, '/app.js', '/api/keys', '/not-found']) {
      const response = await send(server, path, { headers });
      assert.equal(response.status, path === '/not-found' ? 404 : 200);
      assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
    }
    const terminal = await send(server, `/?link=${id}`, { headers: { ...headers, accept: 'text/plain' } });
    assert.match(terminal.body, /Status:  Available/);
    assert.equal(terminal.headers['strict-transport-security'], 'max-age=31536000');
    const response = await send(server, `/api/links/${id}/reveal`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { payload: 'encrypted message' });
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal(item.payload, null);
    assert.ok(item.burned_at);
  });
});

test('HTTP is allowed only for configured local development origins', async t => {
  const pool = { query: async () => ({ rows: [] }) };
  for (const issuer of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    const server = await createServer({ ...config, pool, issuer });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await send(server, '/api/keys');
    assert.equal(response.status, 200);
    assert.equal(response.headers['strict-transport-security'], undefined);
    assert.equal((await send(server, '/api/keys', { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  }
  for (const issuer of ['http://powerbin.test', 'http://localhost.attacker.test', 'ftp://localhost']) {
    await assert.rejects(createServer({ ...config, pool, issuer }), /API_ORIGIN must use HTTPS/);
  }
});

test('forwarded HTTPS is not trusted without explicit proxy configuration', async t => {
  const server = await createServer({ ...config, trustedProxyHeader: null, pool: { query: async () => ({ rows: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await send(server, `/?link=${id}`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers['strict-transport-security'], undefined);
});
