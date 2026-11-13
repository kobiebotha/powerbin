import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const require = createRequire(new URL('../package.json', import.meta.url));
const sdk = await import(require.resolve('@powersync/web'));
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const output = mkdtempSync(join(tmpdir(), 'powerbin-adapter-test-'));
let adapterSource;
let transportSource;
try {
  // TypeScript 7 exposes its compiler through the CLI rather than transpileModule.
  execFileSync(process.execPath, [
    join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '--ignoreConfig', '--noCheck', '--module', 'esnext', '--target', 'esnext',
    '--outDir', output, process.env.POWERBIN_ADAPTER_SOURCE || join(webRoot, 'src/adapter.ts')
  ], { cwd: webRoot, stdio: 'pipe' });
  adapterSource = readFileSync(join(output, 'adapter.js'), 'utf8');
  transportSource = readFileSync(join(output, 'transport.js'), 'utf8');
} finally {
  rmSync(output, { recursive: true, force: true });
}

const itemColumns = ['id', 'kind', 'sender_id', 'recipient_id', 'payload', 'created_at', 'expires_at', 'burned_at', 'burn_reason'];
const deviceColumns = ['id', 'name', 'public_key', 'admission', 'created_at', 'revoked_at'];
const item = (id, payload = 'encrypted snippet') => ({
  id, kind: 'transfer', sender_id: 'sender', recipient_id: 'recipient', payload,
  created_at: `2026-11-11T12:00:0${id === 'older' ? 0 : 1}Z`,
  expires_at: null, burned_at: null, burn_reason: null
});
const device = (id, name = id) => ({
  id, name, public_key: 'public-key', admission: 'signed-admission',
  created_at: '2026-11-11T12:00:00Z', revoked_at: null
});
const plain = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 2000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, description) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await pause(5);
  }
}
function createSqlite(items = [], devices = []) {
  const sql = new DatabaseSync(':memory:');
  for (const [table, columns, rows] of [['items', itemColumns, items], ['devices', deviceColumns, devices]]) {
    sql.exec(`CREATE TABLE ${table} (${columns.map(column => `${column} TEXT${column === 'id' ? ' PRIMARY KEY' : ''}`).join(', ')})`);
    const insert = sql.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of rows) insert.run(...columns.map(column => row[column] ?? null));
  }
  return sql;
}
const result = rows => ({ rows: { _array: rows, length: rows.length, item: index => rows[index] } });

async function harness(t, { items = [], devices = [], fetch: fetchRequest = fetch } = {}) {
  let database;
  class TestDatabase {
    constructor() {
      database = this;
      this.sql = createSqlite(items, devices);
      this.listeners = new Set();
      this.tableListeners = new Set();
      this.currentStatus = { connected: false, connecting: false, hasSynced: false };
      this.logger = { log() {} };
      this.readTransactions = 0;
      this.connectCalls = 0;
      this.nextRead = undefined;
      this.database = {
        registerListener: listener => {
          this.tableListeners.add(listener);
          return () => this.tableListeners.delete(listener);
        },
        readLock: callback => callback({
          execute: async (sql, params = []) => result(this.sql.prepare(sql).all(...params))
        })
      };
    }
    async init() {}
    async waitForReady() {}
    async connect(connector, options) {
      this.connectCalls++;
      this.connector = connector;
      this.connectOptions = options;
    }
    registerListener(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    async getAll(sql, params = []) { return this.sql.prepare(sql).all(...params); }
    async readTransaction(callback) {
      this.readTransactions++;
      if (this.nextReadError) {
        const error = this.nextReadError;
        this.nextReadError = undefined;
        throw error;
      }
      // Model the stable view of a real SQLite read transaction while a newer
      // write can commit on another connection. A held result simulates slow IO.
      const reader = createSqlite(
        this.sql.prepare('SELECT * FROM items').all(),
        this.sql.prepare('SELECT * FROM devices').all()
      );
      const held = this.nextRead;
      this.nextRead = undefined;
      try {
        const rows = await callback({ getAll: async (sql, params = []) => reader.prepare(sql).all(...params) });
        if (held) {
          held.started.resolve();
          await held.release.promise;
        }
        return rows;
      } finally {
        reader.close();
      }
    }
    holdNextRead() {
      const held = { started: deferred(), release: deferred() };
      this.nextRead = held;
      return { started: held.started.promise, release: held.release.resolve };
    }
    notify(table) {
      for (const listener of this.tableListeners) listener.tablesUpdated?.({ tables: [table] });
    }
    mutate(sql, parameters = [], table = 'items') {
      this.sql.prepare(sql).run(...parameters);
      this.notify(table);
    }
    async execute(sql, parameters = []) { this.mutate(sql, parameters); }
    async writeTransaction(callback) {
      await callback({ execute: async (sql, parameters = []) => this.sql.prepare(sql).run(...parameters) });
      this.notify('items');
    }
    status(status) {
      Object.assign(this.currentStatus, status);
      for (const listener of this.listeners) listener.statusChanged?.(this.currentStatus);
    }
    async close() {
      await Promise.all([...this.listeners].map(listener => listener.closing?.()));
      this.sql.close();
    }
  }
  // Keep SDK query execution, dependency resolution, change throttling and
  // serialization real; replace only browser workers, storage and transport.
  for (const method of [
    'watch', 'watchWithCallback', 'watchWithAsyncGenerator', 'customQuery', 'query',
    'resolveTables', 'onChangeWithCallback', 'onChange', 'processTableUpdates',
    'handleTableChanges', 'executeReadOnly'
  ]) TestDatabase.prototype[method] = sdk.PowerSyncDatabase.prototype[method];

  const context = createContext({ console, URL, setTimeout, clearTimeout, AbortController, fetch: fetchRequest });
  const web = new SyntheticModule(['column', 'PowerSyncDatabase', 'Schema', 'SyncStreamConnectionMethod', 'Table', 'WASQLiteVFS'], function () {
    for (const key of ['column', 'Schema', 'SyncStreamConnectionMethod', 'Table', 'WASQLiteVFS']) this.setExport(key, sdk[key]);
    this.setExport('PowerSyncDatabase', TestDatabase);
  }, { context });
  const vault = new SyntheticModule(['load', 'save', 'copy'], function () {
    for (const key of ['load', 'save', 'copy']) this.setExport(key, async () => {});
  }, { context });
  const module = new SourceTextModule(adapterSource, { context, identifier: 'adapter.js' });
  const transport = new SourceTextModule(transportSource, { context, identifier: 'transport.js' });
  await module.link(specifier => {
    if (specifier === '@powersync/web') return web;
    if (specifier === './vault') return vault;
    if (specifier === './transport') return transport;
    throw new Error(`Unexpected adapter import: ${specifier}`);
  });
  await module.evaluate();
  t.after(async () => { if (database) await database.close(); });
  const adapter = module.namespace;
  const connect = () => adapter.connect({ backend_url: 'https://example.test', device_id: 'recipient', device_token: 'synthetic-token' });
  return { adapter, connect, get db() { return database; } };
}

test('unsafe backend origins fail before opening the database or sending credentials', async t => {
  let requests = 0;
  const h = await harness(t, { fetch: async () => { requests++; throw new Error('Unexpected request'); } });
  for (const backend_url of ['http://example.test', 'http://192.0.2.1', 'http://localhost.attacker.test', 'https://user:secret@example.test']) {
    await assert.rejects(h.adapter.connect({ backend_url, device_id: 'recipient', device_token: 'dummy-device-token' }), /HTTPS|credentials/);
    await assert.rejects(h.adapter.request(backend_url, 'dummy-setup-token', '/api/bootstrap', 'POST', '{"device_token":"dummy-device-token"}'), /HTTPS|credentials/);
  }
  assert.equal(requests, 0);
  assert.equal(h.db, undefined);
});

test('sync credentials validate the returned endpoint and API fetches refuse redirects', async t => {
  let syncEndpoint = 'http://sync.example.test';
  const calls = [];
  const h = await harness(t, { fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ device: { id: 'recipient' }, powersync: {
      endpoint: syncEndpoint, token: 'dummy-sync-token', expires_at: '2026-11-13T23:59:59Z'
    } }));
  } });
  await h.connect();
  await assert.rejects(h.db.connector.fetchCredentials(), /HTTPS/);
  assert.equal(calls[0].url, 'https://example.test/api/session');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(calls[0].options.redirect, 'error');
  syncEndpoint = 'http://127.0.0.1:8080';
  await assert.rejects(h.db.connector.fetchCredentials(), /HTTPS sync endpoint/);
  syncEndpoint = 'ws://sync.example.test';
  await assert.rejects(h.db.connector.fetchCredentials(), /HTTPS/);
  syncEndpoint = 'https://sync.example.test';
  assert.equal((await h.db.connector.fetchCredentials()).endpoint, syncEndpoint);
  assert.equal(h.db.connectOptions.connectionMethod, sdk.SyncStreamConnectionMethod.WEB_SOCKET);
});

test('real HTTP listeners receive no forbidden credentials or redirected request replay', async t => {
  const requests = [];
  const listener = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  await new Promise(resolve => listener.listen(0, '0.0.0.0', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port;
  const h = await harness(t);
  for (const [method, body] of [['GET'], ['POST', '{"device_token":"dummy-device-token"}']]) {
    await assert.rejects(h.adapter.request(`http://127.0.0.2:${port}`, 'dummy-setup-token', '/api/bootstrap', method, body), /HTTPS/);
  }
  assert.deepEqual(requests, []);
  // Local development is still usable with the exact same credentialed path.
  assert.equal(await h.adapter.request(`http://127.0.0.1:${port}`, 'dummy-device-token', '/api/session', 'GET'), '{}');
  assert.deepEqual(requests, [{ url: '/api/session', authorization: 'Bearer dummy-device-token' }]);

  const redirect = createServer((request, response) => {
    request.resume();
    response.writeHead(307, { Location: `http://127.0.0.1:${port}/capture` });
    response.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => redirect.close(resolve)));
  await assert.rejects(h.adapter.request(`http://127.0.0.1:${redirect.address().port}`, 'dummy-setup-token', '/api/bootstrap', 'POST', '{"device_token":"dummy-device-token"}'), /fetch failed/);
  assert.equal(requests.length, 1, 'the redirect target never receives the bearer or POST body');
});

test('existing and late subscribers receive complete initial watched rows', async t => {
  const h = await harness(t, { items: [item('newer'), item('older')], devices: [device('sender')] });
  const before = [];
  const stopBefore = h.adapter.watch(value => before.push(plain(value)));
  await h.connect();
  await until(() => before.some(value => value.items.length === 2), 'initial watched rows');
  const late = [];
  const stopLate = h.adapter.watch(value => late.push(plain(value)));
  await until(() => late.length > 0, 'late subscriber snapshot');
  assert.deepEqual(late.at(-1).items.map(row => row.id), ['newer', 'older']);
  assert.equal(late.at(-1).devices[0].id, 'sender');
  assert.deepEqual(plain(await h.adapter.snapshot()), late.at(-1));
  stopBefore();
  stopLate();
});

test('initial snapshots wait for complete watched data', async t => {
  const h = await harness(t, { items: [item('newer')], devices: [device('sender')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  const connecting = h.connect();
  const held = h.db.holdNextRead();
  t.after(held.release);
  await connecting;
  await waitFor(held.started, 'held initial read');
  let resolved = false;
  const pending = h.adapter.snapshot().then(value => { resolved = true; return plain(value); });
  await pause(5);
  assert.equal(resolved, false, 'a snapshot must wait for the first complete watched read');
  assert.equal(values.length, 0);
  held.release();
  const initial = await waitFor(pending, 'initial watched data');
  assert.equal(initial.items[0].id, 'newer');
  assert.equal(initial.devices[0].id, 'sender');
  await until(() => values.length > 0, 'first complete snapshot delivery');
  assert.deepEqual(values.at(-1), initial);
});

test('watched changes update inbox rows without status changes or page refresh', async t => {
  const h = await harness(t);
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  await h.connect();
  await until(() => values.length > 0, 'initial empty inbox');
  await h.adapter.insert(item('newer'));
  await until(() => values.at(-1)?.items.length === 1, 'new inbox row');
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['replaced payload', 'newer']);
  await until(() => values.at(-1)?.items[0]?.payload === 'replaced payload', 'same-ID payload update');
  await h.adapter.consume('newer');
  await until(() => values.at(-1)?.items[0]?.burned_at != null, 'burn state update');
  await h.adapter.burn('newer');
  await until(() => values.at(-1)?.items.length === 0, 'inbox deletion');
  assert.ok(values.every(value => value.connected === false));
  assert.equal(h.db.connectCalls, 1);
});

test('device-only watched changes update names and revocations', async t => {
  const h = await harness(t, { devices: [device('sender')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  await h.connect();
  await until(() => values.at(-1)?.devices.length === 1, 'initial sender');
  h.db.mutate('UPDATE devices SET name = ? WHERE id = ?', ['Renamed sender', 'sender'], 'devices');
  await until(() => values.at(-1)?.devices[0]?.name === 'Renamed sender', 'sender rename');
  h.db.mutate('UPDATE devices SET revoked_at = ? WHERE id = ?', ['2026-11-11T13:00:00Z', 'sender'], 'devices');
  await until(() => values.at(-1)?.devices[0]?.revoked_at != null, 'sender revocation');
});

test('unsubscribe and remount preserve database watches and current rows', async t => {
  const h = await harness(t);
  const first = [];
  const second = [];
  const stopFirst = h.adapter.watch(value => first.push(plain(value)));
  await h.connect();
  await until(() => first.length > 0, 'first subscriber');
  const stopSecond = h.adapter.watch(value => second.push(plain(value)));
  await until(() => second.length > 0, 'second subscriber');
  stopFirst();
  const firstCount = first.length;
  await h.adapter.insert(item('newer'));
  await until(() => second.at(-1)?.items.length === 1, 'remaining subscriber update');
  assert.equal(first.length, firstCount);
  stopSecond();
  const secondCount = second.length;
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['updated while unmounted', 'newer']);
  await until(async () => (await h.adapter.snapshot()).items[0].payload === 'updated while unmounted', 'data update while unmounted');
  const remounted = [];
  const stopRemounted = h.adapter.watch(value => remounted.push(plain(value)));
  await until(() => remounted.at(-1)?.items[0]?.payload === 'updated while unmounted', 'remounted current inbox');
  assert.equal(second.length, secondCount);
  stopRemounted();
  assert.equal(h.db.connectCalls, 1);
});

test('a delayed earlier snapshot cannot overwrite a newer watched mutation', async t => {
  const h = await harness(t, { items: [item('newer', 'original payload')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  await h.connect();
  await until(() => values.at(-1)?.items[0]?.payload === 'original payload', 'initial payload');
  const held = h.db.holdNextRead();
  t.after(held.release);
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['first update', 'newer']);
  await waitFor(held.started, 'held earlier read');
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['latest update', 'newer']);
  // Allow the SDK's 30 ms trailing table-change throttle to schedule its next
  // read while the earlier result remains held. No status events are emitted.
  await pause(80);
  held.release();
  await pause(80);
  assert.equal(values.at(-1)?.items[0]?.payload, 'latest update');
});

test('status changes and late snapshots reuse the current watched data', async t => {
  const h = await harness(t, { items: [item('newer')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  await h.connect();
  await until(() => values.at(-1)?.items.length === 1, 'initial rows');
  const reads = h.db.readTransactions;
  h.db.status({ connected: true, hasSynced: true });
  await until(() => values.at(-1)?.connected === true, 'updated sync status');
  const late = [];
  h.adapter.watch(value => late.push(plain(value)));
  await until(() => late.length > 0, 'late cached snapshot');
  assert.equal(late.at(-1).items[0].id, 'newer');
  assert.equal(h.db.readTransactions, reads, 'status and subscription events must not start independent data reads');
});

test('a transient watched read error clears when a later change succeeds', async t => {
  const h = await harness(t, { items: [item('newer')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  await h.connect();
  await until(() => values.at(-1)?.items.length === 1, 'initial rows');
  h.db.nextReadError = new Error('synthetic transient read failure');
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['first update', 'newer']);
  await until(() => values.at(-1)?.error?.includes('synthetic transient read failure'), 'watched read error');
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['recovered payload', 'newer']);
  await until(() => values.at(-1)?.items[0]?.payload === 'recovered payload', 'read recovery');
  assert.equal(values.at(-1).error, null);
  assert.ok(values.every(value => value.error !== 'null'), 'the SDK clearing an error is not a new error');
});

test('initial watched read failures reject pending snapshots and can recover', async t => {
  const h = await harness(t, { items: [item('newer')] });
  const values = [];
  h.adapter.watch(value => values.push(plain(value)));
  const connecting = h.connect();
  h.db.nextReadError = new Error('synthetic initial read failure');
  await connecting;
  await assert.rejects(h.adapter.snapshot(), /synthetic initial read failure/);
  await until(() => values.at(-1)?.error?.includes('synthetic initial read failure'), 'initial watched error');
  h.db.mutate('UPDATE items SET payload = ? WHERE id = ?', ['recovered initial payload', 'newer']);
  await until(() => values.at(-1)?.items[0]?.payload === 'recovered initial payload', 'initial read recovery');
  assert.equal(values.at(-1).error, null);
  assert.equal((await h.adapter.snapshot()).items[0].payload, 'recovered initial payload');
});
