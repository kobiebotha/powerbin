import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from '../src/server.js';

const config = {
  bootstrapToken: 'x'.repeat(32),
  privateJwk: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  powersyncUrl: 'http://localhost:8080', issuer: 'http://localhost:8080'
};

async function fixture(t, options = {}) {
  const query = async () => ({ rows: [], rowCount: 0 });
  const server = await createServer({ ...config, pool: { query, connect: async () => ({ query, release() {} }) }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}'
    });
    await response.arrayBuffer();
    return response;
  };
}

test('trusted proxy separates rate limits by real client and route', async t => {
  const post = await fixture(t, { trustedProxyHeader: 'x-real-ip' });
  const attacker = { 'x-real-ip': '192.0.2.1' };
  for (let i = 0; i < 30; i++) assert.equal((await post('/api/pairings', attacker)).status, 400);
  const limited = await post('/api/pairings', attacker);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await post('/api/pairings', { 'x-real-ip': '192.0.2.2' })).status, 400);
  assert.equal((await post('/api/bootstrap', attacker)).status, 401);
  assert.equal((await post('/api/links/9cbf58a5-e288-4aa3-9ea2-089b54775e44/reveal', attacker)).status, 404);
});

test('untrusted forwarding headers cannot evade the rate limit', async t => {
  const post = await fixture(t);
  for (let i = 0; i < 30; i++) {
    assert.equal((await post('/api/pairings', { 'x-real-ip': `192.0.2.${i + 1}`, 'x-forwarded-for': `192.0.2.${i + 1}` })).status, 400);
  }
  assert.equal((await post('/api/pairings', { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1' })).status, 429);
});

test('one trusted forwarding proxy uses the rightmost address and ignores spoofed prefixes', async t => {
  const post = await fixture(t, { trustedProxyHeader: 'x-forwarded-for' });
  for (let i = 0; i < 30; i++) {
    assert.equal((await post('/api/pairings', { 'x-forwarded-for': `192.0.2.${i + 1}, 198.51.100.1` })).status, 400);
  }
  assert.equal((await post('/api/pairings', { 'x-forwarded-for': '203.0.113.1, 198.51.100.1' })).status, 429);
  assert.equal((await post('/api/pairings', { 'x-forwarded-for': '203.0.113.1, 198.51.100.2' })).status, 400);
});

test('invalid proxy addresses fall back to the peer instead of creating arbitrary buckets', async t => {
  const post = await fixture(t, { trustedProxyHeader: 'x-real-ip' });
  for (let i = 0; i < 30; i++) assert.equal((await post('/api/pairings', { 'x-real-ip': `not-an-ip-${i}` })).status, 400);
  assert.equal((await post('/api/pairings', { 'x-real-ip': 'bad, 192.0.2.1' })).status, 429);
  assert.equal((await post('/api/pairings', { 'x-real-ip': 'fe80::1%en0' })).status, 429);
});

test('unknown proxy configuration fails at startup', async () => {
  await assert.rejects(createServer({ ...config, trustedProxyHeader: 'host' }), /TRUST_PROXY_HEADER/);
});

test('equivalent IPv6 spellings share the same client budget', async t => {
  const post = await fixture(t, { trustedProxyHeader: 'x-real-ip' });
  for (let i = 0; i < 30; i++) {
    assert.equal((await post('/api/pairings', { 'x-real-ip': '2001:db8::1' })).status, 400);
  }
  assert.equal((await post('/api/pairings', { 'x-real-ip': '2001:0db8:0000:0000:0000:0000:0000:0001' })).status, 429);
});
