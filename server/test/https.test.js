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

test('HTTPS custom domains accept their own browser origin without changing the issuer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-custom-domain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'app.js'), 'export const powerbin = true;');
  const server = await createServer({
    ...config, webDist: directory, pool: { query: async () => ({ rows: [] }) },
    allowedOrigins: ['https://trusted.frontend.test']
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = {
    host: 'powerbin.custom.test', origin: 'https://powerbin.custom.test',
    'x-forwarded-proto': 'https'
  };

  await t.test('browser modules load on the HTTPS host serving the app', async () => {
    const response = await send(server, '/app.js', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(response.body, 'export const powerbin = true;');
    assert.equal(response.headers['access-control-allow-origin'], 'https://powerbin.custom.test');
  });

  await t.test('same-origin APIs and preflights pass the origin check and retain authentication', async () => {
    for (const [path, status] of [['/api/keys', 200], ['/api/session', 401]]) {
      const response = await send(server, path, { headers });
      assert.equal(response.status, status, path);
      assert.equal(response.headers['access-control-allow-origin'], headers.origin);
    }
    const preflight = await send(server, '/api/bootstrap', {
      method: 'OPTIONS', headers: { ...headers, 'access-control-request-method': 'POST' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], headers.origin);
    assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  });

  await t.test('host case, default HTTPS ports, and IPv6 use canonical origins', async () => {
    for (const [host, origin] of [
      ['POWERBIN.CUSTOM.TEST', 'https://powerbin.custom.test'],
      ['powerbin.custom.test:443', 'https://powerbin.custom.test'],
      ['powerbin.custom.test:8443', 'https://powerbin.custom.test:8443'],
      ['[2001:db8::1]:443', 'https://[2001:db8::1]']
    ]) {
      assert.equal((await send(server, '/app.js', { headers: { ...headers, host, origin } })).status, 200, host);
    }
  });

  await t.test('the configured issuer and additional cross-origin clients remain allowed', async () => {
    for (const origin of [config.issuer, 'https://trusted.frontend.test']) {
      const response = await send(server, '/app.js', { headers: { ...headers, origin } });
      assert.equal(response.status, 200);
      assert.equal(response.headers['access-control-allow-origin'], origin);
    }
  });

  await t.test('unrelated, opaque, malformed, wrong-scheme, and wrong-port origins are rejected', async () => {
    for (const [host, origin] of [
      ['powerbin.custom.test', 'https://unrelated.test'],
      ['powerbin.custom.test', 'http://powerbin.custom.test'],
      ['powerbin.custom.test', 'https://powerbin.custom.test:8443'],
      ['powerbin.custom.test:8443', 'https://powerbin.custom.test'],
      ['powerbin.custom.test', 'null'],
      ['powerbin.custom.test', 'https://powerbin.custom.test/'],
      ['powerbin.custom.test', 'https://user@powerbin.custom.test'],
      ['powerbin.custom.test', 'https://powerbin.custom.test https://unrelated.test']
    ]) {
      const response = await send(server, '/app.js', { headers: { ...headers, host, origin } });
      assert.equal(response.status, 403, `${host} / ${origin}`);
      assert.deepEqual(JSON.parse(response.body), { error: 'Origin not allowed' });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  });

  await t.test('forwarded hosts and malformed Host authorities cannot authorize an origin', async () => {
    const spoofed = await send(server, '/app.js', {
      headers: { ...headers, host: 'other.test', 'x-forwarded-host': 'powerbin.custom.test' }
    });
    assert.equal(spoofed.status, 403);
    for (const host of [
      '', 'user@powerbin.custom.test', 'powerbin.custom.test/path', 'powerbin.custom.test\\path',
      'powerbin.custom.test?query', 'powerbin.custom.test#fragment', 'powerbin.custom.test bad'
    ]) {
      assert.equal((await send(server, '/app.js', { headers: { ...headers, host } })).status, 403, host);
    }
  });

  await t.test('custom origins cannot bypass the trusted HTTPS requirement', async () => {
    for (const protocol of [undefined, 'http', 'https, http']) {
      const untrusted = { ...headers };
      if (protocol === undefined) delete untrusted['x-forwarded-proto'];
      else untrusted['x-forwarded-proto'] = protocol;
      const response = await send(server, '/app.js', { headers: untrusted });
      assert.equal(response.status, 403);
      assert.deepEqual(JSON.parse(response.body), { error: 'HTTPS required' });
    }
    const internalRead = { ...headers };
    delete internalRead['x-forwarded-proto'];
    assert.equal((await send(server, '/api/keys', { headers: internalRead })).status, 403);

    const local = await createServer({
      ...config, issuer: 'http://localhost:8080', webDist: directory,
      pool: { query: async () => ({ rows: [] }) }
    });
    await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => local.close(resolve)));
    const plaintext = { host: 'powerbin.custom.test', origin: 'http://powerbin.custom.test' };
    assert.equal((await send(local, '/app.js', { headers: plaintext })).status, 403);
  });

  await t.test('responses without Origin still vary on Origin for shared caches', async () => {
    const withoutOrigin = { ...headers };
    delete withoutOrigin.origin;
    const response = await send(server, '/app.js', { headers: withoutOrigin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.vary, 'Origin, Accept-Encoding');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});
