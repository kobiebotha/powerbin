import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createServer } from '../src/server.js';

function get(server, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('optional same-origin frontend serves only existing dist files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, 'dist');
  await mkdir(join(dist, 'api'), { recursive: true });
  const javascript = Buffer.from('export const powerbin = true;');
  const brotli = brotliCompressSync(javascript);
  const gzip = gzipSync(javascript);
  await Promise.all([
    writeFile(join(dist, 'index.html'), '<!doctype html><title>PowerBin</title>'),
    writeFile(join(dist, 'app-1234abcd.js'), javascript),
    writeFile(join(dist, 'app-1234abcd.js.br'), brotli),
    writeFile(join(dist, 'app-1234abcd.js.gz'), gzip),
    writeFile(join(dist, 'app-1234abcd.wasm'), Buffer.from([0, 97, 115, 109])),
    writeFile(join(dist, 'manifest.webmanifest'), '{}'),
    writeFile(join(dist, 'api', 'keys'), 'must not shadow API'),
    writeFile(join(dist, 'api', 'missing'), 'must not expose an unknown API path'),
    writeFile(join(directory, 'secret.txt'), 'outside dist')
  ]);
  await symlink(join(directory, 'secret.txt'), join(dist, 'escape.txt'));
  await symlink(join(directory, 'secret.txt'), join(dist, 'app-1234abcd.wasm.br'));
  const config = {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    bootstrapToken: 'x'.repeat(32),
    privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
    powersyncUrl: 'http://localhost:8080', issuer: 'http://localhost:8080'
  };
  const server = await createServer({ ...config, webDist: dist });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  await t.test('root and guest query load index, with safe response headers', async () => {
    for (const path of ['/', '/?link=one-time-id']) {
      const response = await get(server, path);
      assert.equal(response.status, 200);
      assert.match(response.body.toString(), /<title>PowerBin/);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(response.headers['cache-control'], 'no-cache');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
      assert.equal(response.headers['x-frame-options'], 'DENY');
    }
  });
  await t.test('MIME, immutable assets, manifest revalidation, and HEAD', async () => {
    const wasm = await get(server, '/app-1234abcd.wasm');
    assert.equal(wasm.headers['content-type'], 'application/wasm');
    assert.match(wasm.headers['cache-control'], /immutable/);
    const manifest = await get(server, '/manifest.webmanifest');
    assert.equal(manifest.headers['content-type'], 'application/manifest+json');
    assert.equal(manifest.headers['cache-control'], 'no-cache');
    const head = await get(server, '/app-1234abcd.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers['content-length']), javascript.length);
  });
  await t.test('precompressed variants honor encoding quality and keep the original MIME', async () => {
    const compressed = await get(server, '/app-1234abcd.js', {
      headers: { 'accept-encoding': 'gzip, br', origin: 'http://localhost:8080' }
    });
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal(compressed.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(compressed.headers.vary, 'Origin, Accept-Encoding');
    assert.deepEqual(compressed.body, brotli);
    const gzipped = await get(server, '/app-1234abcd.js', { headers: { 'accept-encoding': 'br;q=0, gzip' } });
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.deepEqual(gzipped.body, gzip);
    const plain = await get(server, '/app-1234abcd.js', { headers: { 'accept-encoding': 'gzip;q=0, br;q=0' } });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(plain.body, javascript);
    assert.equal((await get(server, '/app-1234abcd.js', { headers: { 'accept-encoding': 'identity;q=0, *;q=0' } })).status, 406);
  });
  await t.test('APIs retain precedence, and unknown paths never fall back to the app', async () => {
    const keys = await get(server, '/api/keys');
    assert.equal(keys.status, 200);
    assert.equal(JSON.parse(keys.body).keys[0].kty, 'OKP');
    assert.equal((await get(server, '/health')).status, 200);
    for (const path of ['/api/missing', '/missing', '/guest/', '/api']) {
      const response = await get(server, path);
      assert.equal(response.status, 404);
      assert.equal(JSON.parse(response.body).error, 'Not found');
    }
    assert.equal((await get(server, '/', { method: 'POST' })).status, 404);
  });
  await t.test('raw and encoded traversal, malformed escapes, and external symlinks are blocked', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%2e%2e/api/keys', '/%5c..%5csecret.txt', '/%00', '/%zz']) {
      assert.equal((await get(server, path)).status, 400, path);
    }
    assert.equal((await get(server, '/escape.txt')).status, 404);
    const wasm = await get(server, '/app-1234abcd.wasm', { headers: { 'accept-encoding': 'br' } });
    assert.equal(wasm.headers['content-encoding'], undefined);
    assert.deepEqual(wasm.body, Buffer.from([0, 97, 115, 109]));
  });
  await t.test('omitting WEB_DIST preserves the API-only server', async () => {
    const apiOnly = await createServer(config);
    await new Promise(resolve => apiOnly.listen(0, '127.0.0.1', resolve));
    try { assert.equal((await get(apiOnly, '/')).status, 404); }
    finally { await new Promise(resolve => apiOnly.close(resolve)); }
  });
});
