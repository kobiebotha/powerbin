#!/usr/bin/env node
// Fresh disposable databases only. This never reads .env or a running project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const prefix = `powerbin-compact-${process.pid}-${randomBytes(4).toString('hex')}`;
const image = process.env.SMOKE_POWERSYNC_IMAGE || 'powerbin-powersync:release';
const postgres = process.env.SMOKE_STORAGE_IMAGE || 'postgres:18';
const source = `${prefix}-source`, storage = `${prefix}-storage`, sync = `${prefix}-sync`;
const password = randomBytes(32).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'powerbin-compact-'));
const containers = new Set();
let network = false, interrupted = false, active;
const interrupt = () => { interrupted = true; active?.kill('SIGTERM'); };
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);

function docker(args, { env, input, cleanup = false } = {}) {
  if (interrupted && !cleanup) return Promise.reject(new Error('Compaction smoke interrupted'));
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    active = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (active === child) active = undefined;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Docker ${args[0]} failed: ${stderr.replaceAll(password, '[redacted]').trim()}`));
    });
    child.stdin.end(input);
  });
}

async function wait(label, check) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !interrupted) {
    try { if (await check()) return; } catch { /* dependencies are still starting */ }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function database(name, extra = []) {
  containers.add(name);
  await docker(['run', '--detach', '--pull=never', '--name', name, '--network', prefix,
    '--label', `powerbin.compaction-smoke=${prefix}`, '--tmpfs', '/var/lib/postgresql',
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=smoke', postgres, ...extra],
  { env: { POSTGRES_PASSWORD: password } });
  await wait(name, async () => (await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'smoke'])).includes('accepting connections'));
}

const sql = (container, statement) => docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'smoke', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement });
async function startSync(supervised) {
  containers.add(sync);
  await docker(['run', '--detach', '--pull=never', '--name', sync, '--network', prefix,
    '--label', `powerbin.compaction-smoke=${prefix}`,
    '--mount', `type=bind,source=${join(directory, 'service.yaml')},target=/config/service.yaml,readonly`,
    '--mount', `type=bind,source=${join(directory, 'sync-config.yaml')},target=/config/sync-config.yaml,readonly`,
    ...(!supervised ? ['--entrypoint', 'node'] : []), image,
    ...(!supervised ? ['service/lib/entry.js', 'start', '-r', 'unified'] : [])]);
  await wait('PowerSync readiness', async () => {
    await docker(['exec', sync, 'node', '-e', "fetch('http://127.0.0.1:8080/probes/startup').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
    return true;
  });
}

try {
  await docker(['image', 'inspect', image]);
  await docker(['image', 'inspect', postgres]);
  network = true;
  await docker(['network', 'create', '--label', `powerbin.compaction-smoke=${prefix}`, prefix]);
  await database(source, ['postgres', '-c', 'wal_level=logical']);
  await database(storage);
  await sql(source, 'CREATE TABLE items (id UUID PRIMARY KEY, payload TEXT); CREATE PUBLICATION powersync FOR TABLE items;');
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  await writeFile(join(directory, 'service.yaml'), JSON.stringify({
    name: 'powerbin-compaction-smoke', _type: 'self-hosted', port: 8080,
    replication: { connections: [{ type: 'postgresql', uri: `postgresql://postgres:${password}@${source}:5432/smoke`, sslmode: 'disable' }] },
    storage: { type: 'postgresql', uri: `postgresql://postgres:${password}@${storage}:5432/smoke`, sslmode: 'disable' },
    sync_config: { path: 'sync-config.yaml' },
    client_auth: { audience: ['powersync'], jwks: { keys: [{ ...publicKey, alg: 'EdDSA', kid: 'smoke' }] } }
  }), { mode: 0o644 });
  await writeFile(join(directory, 'sync-config.yaml'), 'config:\n  edition: 3\nstreams:\n  smoke:\n    auto_subscribe: true\n    query: SELECT * FROM items\n', { mode: 0o644 });
  await startSync(false);
  let table;
  await wait('bucket storage schema', async () => {
    table = await sql(storage, "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) FROM pg_tables WHERE tablename = 'bucket_data'");
    return /^[a-z_]+\.[a-z_]+$/.test(table);
  });
  const id = randomUUID(), liveId = randomUUID();
  const burnedMarker = `burned-ciphertext-${randomUUID()}`, liveMarker = `live-ciphertext-${randomUUID()}`;
  const count = marker => sql(storage, `SELECT count(*) FROM ${table} WHERE data::text LIKE '%${marker}%'`);
  await sql(source, `INSERT INTO items VALUES ('${id}', '${burnedMarker}'), ('${liveId}', '${liveMarker}');`);
  await wait('ciphertext replication', async () => Number(await count(burnedMarker)) > 0 && Number(await count(liveMarker)) > 0);
  await sql(source, `UPDATE items SET payload = NULL WHERE id = '${id}';`);
  await wait('burn replication', async () => Number(await sql(storage, `SELECT count(*) FROM ${table} WHERE row_id = '${id}'`)) >= 2);
  assert.ok(Number(await count(burnedMarker)) > 0, 'unscheduled bucket history retains the old ciphertext');
  console.log('PASS: reproduced retained burned ciphertext in isolated Postgres bucket history');

  await docker(['stop', '--time', '15', sync]);
  await docker(['rm', sync]);
  containers.delete(sync);
  await startSync(true);
  await wait('scheduled startup compaction', async () => Number(await count(burnedMarker)) === 0);
  assert.ok(Number(await count(liveMarker)) > 0, 'compaction preserves current unburned ciphertext');
  const logs = await docker(['logs', sync]);
  assert.match(logs, /PowerSync bucket compaction completed/);
  console.log('PASS: image startup automatically compacted burned history and preserved live ciphertext');
} finally {
  for (const name of containers) await docker(['rm', '--force', name], { cleanup: true }).catch(() => {});
  if (network) await docker(['network', 'rm', prefix], { cleanup: true }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
  process.removeListener('SIGTERM', interrupt);
  process.removeListener('SIGINT', interrupt);
}
