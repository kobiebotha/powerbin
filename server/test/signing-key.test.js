import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signingKey } from '../src/signing-key.js';

test('explicit environment JWK takes precedence and never touches a key file', async () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  assert.deepEqual(await signingKey({ JWT_PRIVATE_JWK: JSON.stringify(key), JWT_PRIVATE_JWK_FILE: '/unwritable/unused/key' }), key);
  await assert.rejects(signingKey({}), /Set JWT_PRIVATE_JWK/);
  await assert.rejects(signingKey({ JWT_PRIVATE_JWK: '{', JWT_PRIVATE_JWK_FILE: '/unwritable/unused/key' }), SyntaxError);
});

test('file signing key is private, stable across restarts, and safely created concurrently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-signing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private', 'signing-key.json');
  const env = { JWT_PRIVATE_JWK_FILE: path };
  const keys = await Promise.all(Array.from({ length: 8 }, () => signingKey(env)));
  for (const key of keys) assert.deepEqual(key, keys[0]);
  assert.equal(createPrivateKey({ key: keys[0], format: 'jwk' }).asymmetricKeyType, 'ed25519');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(directory, 'private')), ['signing-key.json']);
  const saved = await readFile(path, 'utf8');
  assert.deepEqual(await signingKey(env), keys[0]);
  assert.equal(await readFile(path, 'utf8'), saved);
  await writeFile(path, 'invalid existing key');
  await assert.rejects(signingKey(env), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), 'invalid existing key');
});
