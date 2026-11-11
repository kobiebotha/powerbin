import { column, PowerSyncDatabase, Schema, Table, WASQLiteVFS } from '@powersync/web';
import type { PowerSyncBackendConnector } from '@powersync/web';
export { load, save, copy } from './vault';

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
let lastError: string | null = null;
const listeners = new Set<(value: Snapshot) => void>();

function db(): PowerSyncDatabase {
  if (!database) throw new Error('Connect PowerBin before accessing its database');
  return database;
}

async function emit(): Promise<void> {
  const value = await snapshot();
  for (const listener of listeners) listener(value);
}

function report(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
  void emit().catch(console.error);
}

/** Opens the persistent local database; sync starts in the background. */
export async function connect(config: Config): Promise<void> {
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
  const endpoint = new URL(config.backend_url);
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${config.device_token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `PowerBin backend returned ${response.status}`);
    return value;
  };

  const connector: PowerSyncBackendConnector = {
    async fetchCredentials() {
      const session = await request<Session>('/api/session');
      if (session.device.id !== config.device_id) throw new Error('Device credentials do not match');
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
      dbFilename: config.db_filename || `relay-${config.device_id}.db`,
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      worker
    },
    sync: { worker }
  });
  await local.init();
  database = local;
  local.registerListener({ statusChanged: () => { void emit().catch(report); } });
  local.watch('SELECT id FROM items UNION ALL SELECT id FROM devices', [], {
    onResult: () => { void emit().catch(report); },
    onError: report
  });
  void local.connect(connector).catch(report);
}

export async function snapshot(): Promise<Snapshot> {
  const local = db();
  const rows = await local.readTransaction(async tx => ({
    items: await tx.getAll<Item>('SELECT * FROM items ORDER BY created_at DESC, id'),
    devices: await tx.getAll<Device>('SELECT * FROM devices ORDER BY created_at, id')
  }));
  const status = local.currentStatus;
  return {
    ...rows,
    connected: status.connected,
    connecting: status.connecting,
    has_synced: status.hasSynced || false,
    last_synced_at: status.lastSyncedAt?.toISOString() || null,
    error: lastError || status.uploadError?.message || status.downloadError?.message || null
  };
}

/** Returns an unsubscribe function. Payloads are JS objects for serde-wasm-bindgen. */
export function watch(listener: (value: Snapshot) => void): () => void {
  listeners.add(listener);
  if (database) void snapshot().then(value => { if (listeners.has(listener)) listener(value); }).catch(report);
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
