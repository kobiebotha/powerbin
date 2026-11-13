import { column, PowerSyncDatabase, Schema, SyncStreamConnectionMethod, Table, WASQLiteVFS } from '@powersync/web';
import type { PowerSyncBackendConnector } from '@powersync/web';
import { syncEndpoint, origin, request as backendRequest } from './transport';
export { load, save, copy } from './vault';
export { request } from './transport';

// Mirrors app/src/schema.rs. PowerSync adds the id column automatically.
const schema = new Schema({
  items: new Table({
    kind: column.text,
    sender_id: column.text,
    recipient_id: column.text,
    payload: column.text,
    created_at: column.text,
    expires_at: column.text,
    burned_at: column.text,
    burn_reason: column.text
  }),
  devices: new Table({
    name: column.text,
    public_key: column.text,
    admission: column.text,
    created_at: column.text,
    revoked_at: column.text
  })
});

type Rows = (typeof schema)['types'];
export type Item = Rows['items'];
export type Device = Rows['devices'];

export interface Config {
  backend_url: string;
  device_id: string;
  device_token: string;
  db_filename?: string;
}

export interface Snapshot {
  items: Item[];
  devices: Device[];
  connected: boolean;
  connecting: boolean;
  has_synced: boolean;
  last_synced_at: string | null;
  error: string | null;
}

type DatabaseRows = Pick<Snapshot, 'items' | 'devices'>;
const itemsQuery = 'SELECT * FROM items ORDER BY created_at DESC, id';
const devicesQuery = 'SELECT * FROM devices ORDER BY created_at, id';

export interface NewItem {
  id: string;
  kind: 'transfer' | 'saved' | 'link';
  sender_id: string;
  recipient_id: string | null;
  payload: string;
  created_at: string;
  expires_at: string | null;
}

interface Session {
  device: { id: string };
  powersync: { endpoint: string; token: string; expires_at: string };
}

let database: PowerSyncDatabase | undefined;
let activeConfig: Config | undefined;
let opening: Promise<void> | undefined;
let rows: DatabaseRows | undefined;
let firstRows: Promise<void> | undefined;
let queryError: string | null = null;
let lastError: string | null = null;
const listeners = new Set<(value: Snapshot) => void>();

function db(): PowerSyncDatabase {
  if (!database) throw new Error('Connect PowerBin before accessing its database');
  return database;
}

function currentSnapshot(): Snapshot {
  const status = db().currentStatus;
  return {
    ...(rows || { items: [], devices: [] }),
    connected: status.connected,
    connecting: status.connecting,
    has_synced: status.hasSynced || false,
    last_synced_at: status.lastSyncedAt?.toISOString() || null,
    error: queryError || lastError || status.uploadError?.message || status.downloadError?.message || null
  };
}

function emit(): void {
  // Wait for the watched query's initial data, unless opening it failed.
  if (!database || (!rows && !queryError && !lastError)) return;
  const value = currentSnapshot();
  for (const listener of listeners) listener(value);
}

function report(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
  emit();
}

/** Opens the persistent local database; sync starts in the background. */
export async function connect(config: Config): Promise<void> {
  origin(config.backend_url);
  if (opening) {
    if (JSON.stringify(config) !== JSON.stringify(activeConfig)) {
      throw new Error('PowerBin is already connected as another device; reload to switch devices');
    }
    return opening;
  }
  activeConfig = { ...config };
  opening = open(config).catch(error => {
    opening = undefined;
    throw error;
  });
  return opening;
}

async function open(config: Config): Promise<void> {
  origin(config.backend_url);
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    return JSON.parse(await backendRequest(config.backend_url, config.device_token, path,
      body === undefined ? 'GET' : 'POST', body === undefined ? undefined : JSON.stringify(body))) as T;
  };

  const connector: PowerSyncBackendConnector = {
    async fetchCredentials() {
      const session = await request<Session>('/api/session');
      if (session.device.id !== config.device_id) throw new Error('Device credentials do not match');
      syncEndpoint(config.backend_url, session.powersync.endpoint);
      return {
        endpoint: session.powersync.endpoint,
        token: session.powersync.token,
        expiresAt: new Date(session.powersync.expires_at)
      };
    },
    async uploadData(db) {
      const transaction = await db.getNextCrudTransaction();
      if (!transaction) return;
      const batch = transaction.crud.map(({ op, table, id, opData }) => ({ op, table, id, opData }));
      const result = await request<{ accepted: boolean; error?: string }>('/api/upload', { batch });
      // The backend acknowledges permanent validation failures with HTTP 200.
      // Complete those too, so a rejected mutation cannot block later writes.
      await transaction.complete();
      if (!result.accepted) report(result.error || 'The backend rejected this change');
    }
  };

  const worker = '/web/dist/@powersync/worker.js';
  const local = new PowerSyncDatabase({
    schema,
    database: {
      dbFilename: config.db_filename || `powerbin-${config.device_id}.db`,
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      worker
    },
    sync: { worker }
  });
  await local.init();
  database = local;
  local.registerListener({ statusChanged: emit });
  firstRows = new Promise<void>((resolve, reject) => {
    // Watch the actual snapshot, including device trust/name changes needed to
    // render the inbox. Keep both reads in one transaction. PowerSync serializes
    // query executions and reruns after changes received during an in-flight read.
    const query = local.customQuery<DatabaseRows>({
      compile: () => ({ sql: itemsQuery, parameters: [] }),
      execute: async () => [await local.readTransaction(async tx => ({
        items: await tx.getAll<Item>(itemsQuery),
        devices: await tx.getAll<Device>(devicesQuery)
      }))]
    }).watch({ triggerOnTables: ['items', 'devices'], reportFetching: false });
    query.registerListener({
      onData: ([value]) => {
        if (!value) return;
        rows = value;
        queryError = null;
        resolve();
        emit();
      },
      onError: error => {
        // The SDK also calls onError(null) when clearing a previous error.
        // Publish recovery with the successful data in onData instead.
        if (!error) return;
        reject(error);
        queryError = error.message || String(error);
        emit();
      }
    });
  });
  // Watch errors also reach subscribers through emit(), even when nobody is
  // awaiting the initial snapshot.
  void firstRows.catch(() => {});
  // WebKit can withhold fetch-stream data until the next chunk (the service's
  // 18–22 second heartbeat). WebSocket frames bypass that HTTP buffering path.
  void local.connect(connector, {
    connectionMethod: SyncStreamConnectionMethod.WEB_SOCKET
  }).catch(report);
}

export async function snapshot(): Promise<Snapshot> {
  db();
  if (!rows) await firstRows;
  return currentSnapshot();
}

/** Returns an unsubscribe function. Payloads are JS objects for serde-wasm-bindgen. */
export function watch(listener: (value: Snapshot) => void): () => void {
  listeners.add(listener);
  if (database && (rows || queryError || lastError)) listener(currentSnapshot());
  return () => { listeners.delete(listener); };
}

export async function insert(item: NewItem): Promise<void> {
  await insertMany([item]);
}

/** Keep a send to multiple devices in one local write/upload transaction. */
export async function insertMany(items: NewItem[]): Promise<void> {
  if (items.length === 0) return;
  await db().writeTransaction(async tx => {
    for (const item of items) {
      await tx.execute(
        `INSERT INTO items (id, kind, sender_id, recipient_id, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.kind, item.sender_id, item.recipient_id, item.payload, item.created_at, item.expires_at]
      );
    }
  });
}

/** A manual burn. The backend retains and syncs an empty tombstone. */
export async function burn(id: string): Promise<void> {
  await db().execute('DELETE FROM items WHERE id = ?', [id]);
}

/** Consuming a received transfer uses the backend's distinct PATCH operation. */
export async function consume(id: string): Promise<void> {
  await db().execute('UPDATE items SET burned_at = ? WHERE id = ?', [new Date().toISOString(), id]);
}
