//! Run against the local stack with `cargo run --example sync_smoke`.
//! Two temporary devices and SQLite databases are removed when the process exits normally.

#[allow(dead_code)]
#[path = "../src/db_native.rs"]
mod db_native;
#[allow(dead_code)]
#[path = "../src/model.rs"]
mod model;
#[path = "../src/schema.rs"]
mod schema;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use futures_lite::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use db_native::Database;
use model::Item;

#[derive(Deserialize)]
struct Device {
    id: String,
    token: String,
}

#[derive(Deserialize)]
struct Fixture {
    sender: Device,
    recipient: Device,
    transfer_id: String,
    manual_id: String,
    rejected_id: String,
    #[serde(skip)]
    directory: PathBuf,
}

impl Fixture {
    fn create() -> Result<Self, String> {
        let mut fixture: Self =
            serde_json::from_value(node("setup", json!({}))?).map_err(|e| e.to_string())?;
        fixture.directory =
            std::env::temp_dir().join(format!("relay-smoke-{}", fixture.transfer_id));
        std::fs::create_dir(&fixture.directory).map_err(|e| e.to_string())?;
        Ok(fixture)
    }

    fn row(&self, id: &str) -> Result<Value, String> {
        node("row", json!({ "id": id }))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if node(
            "cleanup",
            json!({ "ids": [&self.sender.id, &self.recipient.id] }),
        )
        .is_err()
        {
            eprintln!("Could not remove smoke-test database fixtures");
        }
        if !self.directory.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Native sync smoke failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let fixture = Fixture::create()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let origin = std::env::var("SMOKE_API_ORIGIN")
            .unwrap_or_else(|_| "http://127.0.0.1:18088".to_owned());
        let endpoint = std::env::var("SMOKE_POWERSYNC_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:18080".to_owned());
        let mut sender = Some(
            db_native::connect(
                fixture
                    .directory
                    .join("sender.db")
                    .to_str()
                    .ok_or("Invalid database path")?,
                &origin,
                &fixture.sender.token,
                &endpoint,
            )
            .await?,
        );
        let recipient = db_native::connect(
            fixture
                .directory
                .join("recipient.db")
                .to_str()
                .ok_or("Invalid database path")?,
            &origin,
            &fixture.recipient.token,
            &endpoint,
        )
        .await?;
        let result = smoke(&fixture, &mut sender, &recipient, &origin, &endpoint).await;
        if let Some(sender) = sender {
            sender.disconnect().await;
        }
        recipient.disconnect().await;
        result
    })
}

async fn smoke(
    fixture: &Fixture,
    sender_slot: &mut Option<Database>,
    recipient: &Database,
    origin: &str,
    endpoint: &str,
) -> Result<(), String> {
    let sender = sender_slot.as_ref().ok_or("Sender database unavailable")?;
    connected(sender).await?;
    connected(recipient).await?;
    let mut directory = Box::pin(recipient.watch_devices());
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(devices) = directory.try_next().await? {
            if [&fixture.sender.id, &fixture.recipient.id]
                .iter()
                .all(|id| devices.iter().any(|device| &device.id == *id))
            {
                return Ok::<_, String>(());
            }
        }
        Err("Device watch ended".to_owned())
    })
    .await
    .map_err(|_| "Device directory did not sync".to_owned())??;
    println!("PASS: two authenticated native clients connected and watched device sync");

    let mut sent = Box::pin(sender.watch_items());
    let mut received = Box::pin(recipient.watch_items());
    // Poll both watches before writing, so subsequent assertions exercise live updates.
    tokio::time::timeout(Duration::from_secs(30), async {
        sent.try_next().await?.ok_or("Sender watch ended")?;
        received.try_next().await?.ok_or("Recipient watch ended")?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Initial item watches did not emit".to_owned())??;
    let created_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|e| e.to_string())?;
    let expires_at = (OffsetDateTime::now_utc() + time::Duration::hours(1))
        .format(&Rfc3339)
        .map_err(|e| e.to_string())?;
    let transfer = Item {
        id: fixture.transfer_id.clone(),
        kind: "transfer".to_owned(),
        sender_id: fixture.sender.id.clone(),
        recipient_id: Some(fixture.recipient.id.clone()),
        payload: Some("opaque smoke-test ciphertext".to_owned()),
        created_at,
        expires_at: Some(expires_at),
        ..Item::default()
    };
    tokio::time::timeout(Duration::from_secs(30), sender.disconnect())
        .await
        .map_err(|_| "Sender did not disconnect".to_owned())?;
    require(!sender.status().is_connected(), "Sender remained connected")?;
    sender.insert(&transfer).await?;
    item_until(
        &mut sent,
        &transfer.id,
        |row| row.payload == transfer.payload,
        "offline local insert",
    )
    .await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    require(
        fixture.row(&transfer.id)?.is_null(),
        "Offline write reached Postgres before reconnection",
    )?;
    println!("PASS: disconnected SQL insert reached the local watch and stayed out of Postgres");

    // Drop every sender watch/handle before opening the same on-disk SQLite file.
    drop(sent);
    drop(sender_slot.take());
    *sender_slot = Some(
        tokio::time::timeout(
            Duration::from_secs(30),
            db_native::connect(
                fixture
                    .directory
                    .join("sender.db")
                    .to_str()
                    .ok_or("Invalid database path")?,
                origin,
                &fixture.sender.token,
                endpoint,
            ),
        )
        .await
        .map_err(|_| "Sender database did not reopen".to_owned())??,
    );
    let sender = sender_slot.as_ref().ok_or("Sender database unavailable")?;
    let mut sent = Box::pin(sender.watch_items());
    item_until(
        &mut sent,
        &transfer.id,
        |row| row.payload == transfer.payload,
        "persisted offline insert after reopening SQLite",
    )
    .await?;
    connected(sender).await?;
    item_until(
        &mut received,
        &transfer.id,
        |row| row.payload == transfer.payload,
        "remote insert",
    )
    .await?;
    require(
        fixture.row(&transfer.id)?["payload"] == transfer.payload.as_deref().unwrap(),
        "Upload did not reach Postgres",
    )?;
    println!(
        "PASS: reopened SQLite retained the offline queue; reconnect uploaded it to Postgres and the other device"
    );

    recipient.consume(&transfer.id).await?;
    let consumed =
        |row: &Item| row.payload.is_none() && row.burn_reason.as_deref() == Some("consumed");
    item_until(
        &mut received,
        &transfer.id,
        consumed,
        "recipient consume acknowledgement",
    )
    .await?;
    item_until(
        &mut sent,
        &transfer.id,
        consumed,
        "sender consume notification",
    )
    .await?;
    let row = fixture.row(&transfer.id)?;
    require(
        row["payload"].is_null() && row["burn_reason"] == "consumed",
        "Postgres did not clear consumed ciphertext",
    )?;
    println!(
        "PASS: recipient consumption cleared ciphertext and synced the tombstone to both devices"
    );

    // Recreate a stale local record: backend idempotence must restore the synced tombstone.
    sender.burn(&transfer.id).await?;
    sender.insert(&transfer).await?;
    let mut replay = Box::pin(sender.watch_items());
    item_until(
        &mut replay,
        &transfer.id,
        consumed,
        "stale PUT reconciliation",
    )
    .await?;
    let row = fixture.row(&transfer.id)?;
    require(
        row["payload"].is_null() && row["burn_reason"] == "consumed",
        "Stale PUT resurrected ciphertext",
    )?;
    println!("PASS: replaying an old PUT through the native queue did not resurrect burned data");

    let invalid = Item {
        id: fixture.rejected_id.clone(),
        sender_id: fixture.recipient.id.clone(),
        ..transfer.clone()
    };
    sender.insert(&invalid).await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut status = Box::pin(sender.watch_status());
        while status.next().await.is_some() {
            if sender.upload_error().as_deref() == Some("Sender must be the authenticated device") {
                return Ok(());
            }
        }
        Err("Status watch ended before permanent rejection".to_owned())
    })
    .await
    .map_err(|_| "Permanent rejection was not surfaced".to_owned())??;
    require(
        fixture.row(&invalid.id)?.is_null(),
        "Rejected upload reached Postgres",
    )?;

    let manual = Item {
        id: fixture.manual_id.clone(),
        ..transfer
    };
    sender.insert(&manual).await?;
    item_until(
        &mut received,
        &manual.id,
        |row| row.payload == manual.payload,
        "upload after rejection",
    )
    .await?;
    sender.burn(&manual.id).await?;
    item_until(
        &mut received,
        &manual.id,
        |row| row.payload.is_none() && row.burn_reason.as_deref() == Some("deleted"),
        "manual burn",
    )
    .await?;
    require(
        fixture.row(&manual.id)?["burn_reason"] == "deleted",
        "Manual DELETE did not preserve a tombstone",
    )?;
    println!(
        "PASS: permanent rejection drained, later upload succeeded, and manual DELETE synced its burn"
    );
    Ok(())
}

async fn connected(db: &Database) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut statuses = Box::pin(db.watch_status());
        while let Some(status) = statuses.next().await {
            if status.is_connected() && status.has_synced() {
                return Ok(());
            }
        }
        Err("Status watch ended".to_owned())
    })
    .await
    .map_err(|_| {
        db.status()
            .any_error()
            .map(ToString::to_string)
            .unwrap_or_else(|| "PowerSync did not finish initial sync".to_owned())
    })?
}

async fn item_until(
    stream: &mut (impl Stream<Item = Result<Vec<Item>, String>> + Unpin),
    id: &str,
    predicate: impl Fn(&Item) -> bool,
    label: &str,
) -> Result<Item, String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(items) = stream.try_next().await? {
            if let Some(item) = items.into_iter().find(|row| row.id == id && predicate(row)) {
                return Ok(item);
            }
        }
        Err("Item watch ended".to_owned())
    })
    .await
    .map_err(|_| format!("Timed out waiting for {label}"))?
}

fn require(condition: bool, error: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(error.to_owned())
    }
}

fn node(operation: &str, input: Value) -> Result<Value, String> {
    let mut child = Command::new("node")
        .args(["--input-type=module", "-e", FIXTURE, operation])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("No fixture stdin")?
        .write_all(input.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Database fixture {operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Invalid database fixture output".to_owned())
}

// Reuse the backend's installed pg dependency. No bootstrap or real device credentials are used.
const FIXTURE: &str = r#"
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hash } from './src/domain.js';
if (!process.env.MIGRATION_DATABASE_URL && !process.env.DATABASE_URL && existsSync('../.env')) process.loadEnvFile('../.env');
const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
const input = JSON.parse(await new Response(process.stdin).text());
const op = process.argv[1];
try {
  if (op === 'setup') {
    const device = () => ({ id: randomUUID(), token: randomBytes(32).toString('base64url') });
    const sender = device(), recipient = device();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [name, d] of [['sender', sender], ['recipient', recipient]]) {
        await client.query(`INSERT INTO devices (id, name, public_key, shared_key_envelope, token_hash, admission)
          VALUES ($1, $2, 'smoke-only', 'smoke-only', $3, 'smoke-only')`, [d.id, `SDK smoke ${name}`, hash(d.token)]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    process.stdout.write(JSON.stringify({ sender, recipient, transfer_id: randomUUID(), manual_id: randomUUID(), rejected_id: randomUUID() }));
  } else if (op === 'row') {
    const { rows } = await pool.query('SELECT payload, burned_at, burn_reason FROM items WHERE id = $1', [input.id]);
    process.stdout.write(JSON.stringify(rows[0] || null));
  } else if (op === 'cleanup') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM items WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])', [input.ids]);
      await client.query('DELETE FROM devices WHERE id = ANY($1::uuid[])', [input.ids]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    process.stdout.write('{}');
  } else { throw new Error('Unknown fixture operation'); }
} catch (error) {
  console.error('Smoke fixture failed:', error.code || error.name);
  process.exitCode = 1;
} finally { await pool.end(); }
"#;
