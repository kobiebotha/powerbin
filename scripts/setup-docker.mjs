#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg.startsWith('-'))) {
  console.log('Usage: node scripts/setup-docker.mjs [ENV_FILE]');
  process.exit(args.length === 1 && ['-h', '--help'].includes(args[0]) ? 0 : 2);
}
const path = args[0] ? resolve(args[0]) : fileURLToPath(new URL('../.env.docker', import.meta.url));
const secret = () => randomBytes(32).toString('hex');
const values = {
  POWERBIN_IMAGE_NAMESPACE: 'ghcr.io/kobiebotha',
  POWERBIN_IMAGE_TAG: 'latest',
  POWERBIN_BIND_ADDRESS: '127.0.0.1',
  POWERBIN_HTTP_PORT: '18088',
  POWERBIN_SYNC_PORT: '18080',
  POWERBIN_API_ORIGIN: 'http://localhost:18088',
  POWERBIN_POWERSYNC_URL: 'http://localhost:18080',
  POWERBIN_POSTGRES_PASSWORD: secret(),
  POWERBIN_APP_PASSWORD: secret(),
  POWERBIN_REPLICATION_PASSWORD: secret(),
  POWERBIN_STORAGE_PASSWORD: secret(),
  POWERBIN_BOOTSTRAP_TOKEN: secret(),
  POWERBIN_POWERSYNC_ADMIN_TOKEN: secret()
};
const contents = '# Generated credentials for compose.yaml. Keep this file private and preserve it with your volumes.\n' +
  Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
try {
  await writeFile(path, contents, { mode: 0o600, flag: 'wx' });
  console.log(`Created ${path} with unique credentials. No existing environment or volumes changed.`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log(`Preserved existing ${path}. Credentials were not replaced.`);
}
