import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const secret = () => randomBytes(32).toString('base64url');
const root = new URL('../', import.meta.url);
let contents;
try {
  contents = await readFile(new URL('.env', root), 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const databasePassword = secret();
  const appPassword = secret();
  const syncPassword = secret();
  const storagePassword = secret();
  contents = Object.entries({
    PORT: 18088,
    API_ORIGIN: 'http://localhost:18088',
    WEB_ORIGIN: 'http://localhost:4173',
    ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:8790',
    POWERSYNC_URL: 'http://localhost:18080',
    BOOTSTRAP_TOKEN: secret(),
    JWT_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: 'jwk' })),
    DATABASE_URL: `postgres://relay_app:${appPassword}@localhost:15432/relay`,
    TEST_DATABASE_URL: `postgres://postgres:${databasePassword}@localhost:15432/relay`,
    MIGRATION_DATABASE_URL: `postgres://postgres:${databasePassword}@localhost:15432/relay`,
    PS_PORT: 18080,
    PS_ADMIN_TOKEN: secret(),
    PS_JWT_PUBLIC_X: publicKey.export({ format: 'jwk' }).x,
    PS_DATABASE_USER: 'postgres',
    PS_DATABASE_NAME: 'relay',
    PS_DATABASE_PORT: 15432,
    PS_DATABASE_PASSWORD: databasePassword,
    PS_APP_PASSWORD: appPassword,
    PS_REPLICATION_PASSWORD: syncPassword,
    PS_DATA_SOURCE_URI: `postgres://relay_sync:${syncPassword}@pg-db:15432/relay`,
    PS_STORAGE_USER: 'powersync',
    PS_STORAGE_DATABASE: 'powersync',
    PS_STORAGE_PORT: 15433,
    PS_STORAGE_PASSWORD: storagePassword,
    PS_STORAGE_SOURCE_URI: `postgres://powersync:${storagePassword}@pg-storage:15433/powersync`
  }).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';
  await writeFile(new URL('.env', root), contents, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with unique local credentials.');
}

await writeFile(new URL('powersync/docker/.env', root),
  contents.split('\n').filter(line => line.startsWith('PS_')).join('\n') + '\n', { mode: 0o600 });
console.log('Local environment ready.');
