#!/usr/bin/env node
// Disposable release check. Build the images first; this script never reads .env.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const native = process.argv.includes('--native');
if (process.argv.slice(2).some(arg => arg !== '--native')) {
  console.error('Usage: node railway/smoke.mjs [--native]');
  process.exit(2);
}
const prefix = `powerbin-smoke-${process.pid}-${randomBytes(4).toString('hex')}`;
const names = Object.fromEntries(['postgres', 'bucket', 'powersync', 'powerbin'].map(name => [name, `${prefix}-${name}`]));
const volumes = ['postgres', 'bucket', 'keys'].map(name => `${prefix}-${name}`);
const images = {
  powerbin: process.env.SMOKE_POWERBIN_IMAGE || 'powerbin:release',
  postgres: process.env.SMOKE_POSTGRES_IMAGE || 'powerbin-postgres:release',
  powersync: process.env.SMOKE_POWERSYNC_IMAGE || 'powerbin-powersync:release',
  bucket: process.env.SMOKE_STORAGE_IMAGE || 'postgres:18'
};
const secrets = Object.fromEntries(['admin', 'app', 'replication', 'storage', 'bootstrap', 'powersync'].map(name => [name, randomBytes(32).toString('hex')]));
const created = { containers: new Set(), volumes: [], network: false };
let interrupted = false;
let active;
const stop = () => { interrupted = true; active?.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const redact = value => Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
function command(executable, args, { env, timeout = 60_000, inherit = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) return Promise.reject(new Error('Smoke check interrupted'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    active = child;
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (active === child) active = undefined;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(redact(`${executable} ${args[0]} failed (${code ?? 'terminated'}): ${stderr.trim()}`)));
    });
  });
}
const docker = (args, options) => command('docker', args, options);
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
async function ready(label, check) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !interrupted) {
    try { if (await check()) return; } catch { /* dependencies may still be starting */ }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function run(name, env, extra = []) {
  created.containers.add(names[name]);
  await docker(['run', '--detach', '--pull=never', '--name', names[name], '--network', prefix, '--network-alias', name,
    '--label', `powerbin.smoke=${prefix}`, ...Object.keys(env).flatMap(key => ['--env', key]), ...extra, images[name]], { env });
}
async function request(origin, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(origin + path, {
    method, signal: AbortSignal.timeout(10_000),
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
function verifySession(session, jwks, device, issuer, endpoint) {
  const [header, payload, signature] = session.powersync.token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'EdDSA');
  assert.ok(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwks.keys[0], format: 'jwk' }), Buffer.from(signature, 'base64url')), 'Session JWT signature');
  assert.ok(claims.sub === device.device_id && claims.iss === issuer && claims.aud === 'powersync', 'Session JWT claims');
  assert.equal(session.powersync.endpoint, endpoint);
}
async function checkSite(origin) {
  const response = await fetch(origin, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /<title>PowerBin<\/title>/);
  const descriptor = JSON.parse(html.match(/const app = (\{[^\n]+\});/)?.[1] || 'null');
  assert.ok(descriptor?.code && descriptor.rust === false, 'Packaged entry is the current mixed TSX app');
  const code = await fetch(`${origin}/${descriptor.code}`).then(response => response.text());
  assert.ok(code.includes('powerbin/native') && code.includes('PowerBin'), 'TSX bundle contains the Rust bridge');
  const files = JSON.parse(await docker(['exec', names.powerbin, 'node', '--input-type=module', '-e',
    "import { readdir } from 'node:fs/promises'; const root='/app/public'; const files=[]; async function walk(path='') { for(const e of await readdir(root+'/'+path,{withFileTypes:true})) { const name=path+e.name; if(e.isDirectory()) await walk(name+'/'); else files.push(name); } } await walk(); console.log(JSON.stringify(files));"]));
  const references = new Set([
    'manifest.webmanifest', descriptor.code, descriptor.wasm, descriptor.glue, descriptor.host,
    ...Object.values(descriptor.data || {}), ...Object.values(descriptor.assets || {}),
    ...Object.values(descriptor.chunks || {}), ...Object.values(descriptor.sides || {}).map(side => side.url),
    html.match(/import\s*\{\s*createPlayer\s*\}\s*from\s*["']\.\/([^"']+)["']/)?.[1]
  ].filter(Boolean));
  for (const path of references) assert.ok(files.includes(path), `NSH descriptor asset ${path} is packaged`);
  for (const font of [...(descriptor.fonts || []), ...Object.values(descriptor.chunkFonts || {}).flat()]) {
    assert.ok(descriptor.assets?.[font] && files.includes(descriptor.assets[font]), `NSH font ${font} is packaged`);
  }
  for (const chunk of descriptor.entryChunks || []) assert.ok(descriptor.chunks?.[chunk], `NSH entry chunk ${chunk} is packaged`);
  assert.ok(files.includes('web/dist/adapter.js'), 'PowerSync adapter is packaged');
  assert.ok(files.some(path => path.startsWith('web/dist/') && /worker.*\.js$/.test(path)), 'PowerSync worker is packaged');
  assert.ok(files.some(path => path.startsWith('web/dist/') && path.endsWith('.wasm')), 'SQLite WASM is packaged');
  const types = { js: /^text\/javascript/, mjs: /^text\/javascript/, wasm: /^application\/wasm/, webmanifest: /^application\/manifest\+json/ };
  let checked = 0;
  for (const path of files) {
    const type = types[path.split('.').at(-1)];
    if (!type && !references.has(path)) continue;
    const asset = await fetch(`${origin}/${path}`, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    assert.equal(asset.status, 200, `Packaged asset ${path}`);
    if (type) assert.match(asset.headers.get('content-type'), type, `MIME type for ${path}`);
    assert.ok(Number(asset.headers.get('content-length')) > 0, `Nonempty asset ${path}`);
    checked++;
  }
  const retained = JSON.parse(await docker(['exec', names.powerbin, 'node', '--input-type=module', '-e',
    "import { existsSync } from 'node:fs'; import { readdir } from 'node:fs/promises'; const found=['/workspace','/opt/nsh','/opt/pnpm','/usr/local/cargo','/root/.cargo','/root/.rustup','/usr/local/bin/rustc','/usr/local/bin/cargo','/app/node_modules/powersync'].filter(existsSync); async function walk(path) { for(const e of await readdir(path,{withFileTypes:true})) { if(e.name==='node_modules') continue; const name=path+'/'+e.name; if(/^(?:\\.env(?:\\..*)?|\\.git|\\.tools|target)$/.test(e.name) || /\\.(?:pem|key|p12)$|signing-key.*\\.json$/i.test(e.name)) found.push(name); else if(e.isDirectory()) await walk(name); } } await walk('/app'); console.log(JSON.stringify(found));"]));
  assert.ok(retained.length === 0, 'Runtime excludes development secrets, private key files, and build toolchains');
  console.log(`PASS: current TSX entry, descriptor assets/fonts/chunks, adapter, workers, and ${checked} served assets; runtime contains no development secrets or build toolchains`);
}

try {
  for (const image of Object.values(images)) await docker(['image', 'inspect', image]);
  const ports = new Set();
  while (ports.size < 3) ports.add(await port());
  const [postgresPort, powerbinPort, powersyncPort] = ports;
  const apiOrigin = `http://127.0.0.1:${powerbinPort}`;
  const syncOrigin = `http://127.0.0.1:${powersyncPort}`;
  created.network = true;
  await docker(['network', 'create', '--label', `powerbin.smoke=${prefix}`, prefix]);
  for (const volume of volumes) {
    created.volumes.push(volume);
    await docker(['volume', 'create', '--label', `powerbin.smoke=${prefix}`, volume]);
  }
  await run('postgres', { POSTGRES_DB: 'powerbin', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: secrets.admin,
    POWERBIN_APP_PASSWORD: secrets.app, POWERBIN_REPLICATION_PASSWORD: secrets.replication },
  ['--publish', `127.0.0.1:${postgresPort}:5432`, '--mount', `type=volume,source=${volumes[0]},target=/var/lib/postgresql`]);
  await run('bucket', { POSTGRES_DB: 'powersync', POSTGRES_USER: 'powersync', POSTGRES_PASSWORD: secrets.storage },
    ['--mount', `type=volume,source=${volumes[1]},target=/var/lib/postgresql`]);
  await ready('source Postgres initialization', async () => {
    const result = await docker(['exec', names.postgres, 'psql', '-U', 'postgres', '-d', 'powerbin', '-Atc',
      "SELECT current_setting('wal_level') || ':' || (SELECT count(*) FROM pg_roles WHERE rolname IN ('powerbin_app', 'powerbin_sync')) || ':' || (SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_publication_tables WHERE pubname='powersync')"]);
    return result === 'logical:2:devices,items';
  });
  await ready('storage Postgres', async () => (await docker(['exec', names.bucket, 'pg_isready', '-U', 'powersync', '-d', 'powersync'])).includes('accepting connections'));
  console.log('PASS: fresh source schema, restricted roles, logical replication, publication, and separate storage initialized');
  await run('powersync', { PORT: '8080', PS_DATA_SOURCE_URI: `postgresql://powerbin_sync:${secrets.replication}@postgres:5432/powerbin`,
    PS_STORAGE_SOURCE_URI: `postgresql://powersync:${secrets.storage}@bucket:5432/powersync`, PS_JWKS_URI: 'http://powerbin:8080/api/keys', PS_ADMIN_TOKEN: secrets.powersync },
  ['--publish', `127.0.0.1:${powersyncPort}:8080`]);
  const powerbinEnv = { PORT: '8080', HOST: '::', DATABASE_URL: `postgresql://powerbin_app:${secrets.app}@postgres:5432/powerbin`,
    API_ORIGIN: apiOrigin, POWERSYNC_URL: syncOrigin, BOOTSTRAP_TOKEN: secrets.bootstrap, JWT_PRIVATE_JWK_FILE: '/data/signing-key.json' };
  const powerbinArgs = ['--publish', `127.0.0.1:${powerbinPort}:8080`, '--mount', `type=volume,source=${volumes[2]},target=/data`];
  await run('powerbin', powerbinEnv, powerbinArgs);
  await ready('PowerBin health', async () => (await request(apiOrigin, '/health')).status === 200);
  await ready('PowerSync startup', async () => (await fetch(`${syncOrigin}/probes/startup`, { signal: AbortSignal.timeout(3000) })).ok);
  console.log('PASS: PowerBin and PowerSync healthy without fixed host ports or existing development credentials');
  await checkSite(apiOrigin);

  const device = { device_id: randomUUID(), device_token: randomBytes(32).toString('base64url'), name: 'Release smoke', public_key: 'smoke-public-key', shared_key_envelope: 'smoke-envelope', admission: 'smoke-admission' };
  assert.equal((await request(apiOrigin, '/api/bootstrap', { method: 'POST', body: device })).status, 401);
  assert.equal((await request(apiOrigin, '/api/bootstrap', { method: 'POST', token: secrets.bootstrap, body: device })).status, 201);
  assert.equal((await request(apiOrigin, '/api/bootstrap', { method: 'POST', token: secrets.bootstrap, body: device })).status, 409);
  const jwks = (await request(apiOrigin, '/api/keys')).body;
  assert.equal(jwks.keys.length, 1);
  assert.ok(!('d' in jwks.keys[0]), 'JWKS exposes only the public key');
  const session = await request(apiOrigin, '/api/session', { token: device.device_token });
  assert.equal(session.status, 200);
  verifySession(session.body, jwks, device, apiOrigin, syncOrigin);
  const keyState = () => docker(['exec', names.powerbin, 'node', '--input-type=module', '-e',
    "import { readFile, stat } from 'node:fs/promises'; import { createHash } from 'node:crypto'; console.log(JSON.stringify({ hash:createHash('sha256').update(await readFile('/data/signing-key.json')).digest('hex'),file:(await stat('/data/signing-key.json')).mode&511,directory:(await stat('/data')).mode&511 }));"]);
  const before = JSON.parse(await keyState());
  assert.ok(before.file === 0o600 && before.directory === 0o700, 'Private signing-key permissions');
  console.log('PASS: authenticated single-use bootstrap and valid session JWT backed by public-only JWKS');

  if (native) {
    await command(process.env.CARGO || 'cargo', ['run', '--locked', '--manifest-path', 'app/Cargo.toml', '--example', 'sync_smoke'], {
      env: { MIGRATION_DATABASE_URL: `postgresql://postgres:${secrets.admin}@127.0.0.1:${postgresPort}/powerbin`,
        DATABASE_URL: `postgresql://powerbin_app:${secrets.app}@127.0.0.1:${postgresPort}/powerbin`, SMOKE_API_ORIGIN: apiOrigin, SMOKE_POWERSYNC_URL: syncOrigin },
      inherit: true, timeout: 600_000
    });
  }
  await docker(['rm', '--force', names.powerbin]);
  await run('powerbin', powerbinEnv, powerbinArgs);
  await ready('replacement PowerBin container', async () => (await request(apiOrigin, '/health')).status === 200);
  const after = JSON.parse(await keyState());
  assert.ok(before.hash === after.hash && before.file === after.file && before.directory === after.directory, 'Signing key survives container replacement');
  assert.ok(JSON.stringify((await request(apiOrigin, '/api/keys')).body) === JSON.stringify(jwks), 'Public signing key survives replacement');
  const restored = await request(apiOrigin, '/api/session', { token: device.device_token });
  assert.equal(restored.status, 200);
  verifySession(restored.body, jwks, device, apiOrigin, syncOrigin);
  console.log('PASS: replacing PowerBin preserves signing key, private permissions, and existing device authentication');
  console.log(native ? 'Release smoke passed, including real native SDK sync.' : 'Release container/API smoke passed. Add --native to exercise real two-client SDK sync.');
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  async function remove(args) {
    try { await docker(args, { cleanup: true }); }
    catch (error) {
      if (/No such (?:container|volume|network)/i.test(error.message)) return;
      cleanupFailed = true;
      console.error(redact(`Cleanup failed: ${error.message}`));
      process.exitCode = 1;
    }
  }
  for (const name of [...created.containers].reverse()) await remove(['rm', '--force', '--volumes', name]);
  for (const volume of created.volumes) await remove(['volume', 'rm', volume]);
  if (created.network) await remove(['network', 'rm', prefix]);
  if (created.network && !cleanupFailed) console.log('Removed this smoke run’s containers, volumes, and network.');
}
