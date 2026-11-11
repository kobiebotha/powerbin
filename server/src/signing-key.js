import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function signingKey(env = process.env) {
  if (env.JWT_PRIVATE_JWK) return JSON.parse(env.JWT_PRIVATE_JWK);
  const path = env.JWT_PRIVATE_JWK_FILE;
  if (!path) throw new Error('Set JWT_PRIVATE_JWK or JWT_PRIVATE_JWK_FILE');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(key), { flag: 'wx', mode: 0o600 });
  try {
    // Linking a complete file publishes it atomically, without replacing a key.
    await link(temporary, path);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  return JSON.parse(await readFile(path, 'utf8'));
}
