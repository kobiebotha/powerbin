use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_lite::{Stream, StreamExt};
use powersync::env::PowerSyncEnvironment;
use powersync::error::PowerSyncError;
use powersync::{
    Authenticator, ConnectionPool, MutationUploader, PowerSyncDatabase, SyncOptions, SyncStatusData,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::json;

use crate::model::{Device, Item};

#[derive(Clone)]
pub struct Database {
    inner: PowerSyncDatabase,
    rejected_upload: Arc<Mutex<Option<String>>>,
}

/// Call on the app's Tokio runtime; PowerSync keeps syncing in the background.
pub async fn connect(
    path: &str,
    api_origin: &str,
    device_token: &str,
    powersync_endpoint: &str,
) -> Result<Database, String> {
    PowerSyncEnvironment::powersync_auto_extension().map_err(|e| e.to_string())?;
    let backend = Backend {
        client: reqwest::Client::new(),
        origin: api_origin.trim_end_matches('/').to_owned(),
        token: device_token.to_owned(),
    };
    let pool = ConnectionPool::open(path).map_err(|e| e.to_string())?;
    let environment =
        PowerSyncEnvironment::custom(backend.client.clone(), pool, PowerSyncEnvironment::tokio());
    let inner = PowerSyncDatabase::new(environment, crate::schema::app_schema());
    let rejected_upload = Arc::new(Mutex::new(None));
    let uploader = Uploader {
        backend: backend.clone(),
        db: inner.clone(),
        rejected_upload: rejected_upload.clone(),
    };
    inner
        .connect(SyncOptions::new(powersync_endpoint, backend, uploader))
        .await;
    Ok(Database {
        inner,
        rejected_upload,
    })
}

impl Database {
    pub fn status(&self) -> Arc<SyncStatusData> {
        self.inner.status()
    }

    pub fn watch_status(&self) -> impl Stream<Item = Arc<SyncStatusData>> + '_ {
        self.inner.watch_status()
    }

    pub async fn disconnect(&self) {
        self.inner.disconnect().await;
    }

    pub fn watch_items(&self) -> impl Stream<Item = Result<Vec<Item>, String>> + 'static {
        self.inner
            .watch_statement(
                "SELECT id, kind, sender_id, recipient_id, payload, created_at, \
                 expires_at, burned_at, burn_reason FROM items ORDER BY created_at DESC, id"
                    .to_owned(),
                (),
                |statement, parameters| {
                    let mut rows = statement.query(parameters)?;
                    let mut items = Vec::new();
                    while let Some(row) = rows.next()? {
                        items.push(Item {
                            id: row.get("id")?,
                            kind: row.get("kind")?,
                            sender_id: row.get("sender_id")?,
                            recipient_id: row.get("recipient_id")?,
                            payload: row.get("payload")?,
                            created_at: row.get("created_at")?,
                            expires_at: row.get("expires_at")?,
                            burned_at: row.get("burned_at")?,
                            burn_reason: row.get("burn_reason")?,
                        });
                    }
                    Ok(items)
                },
            )
            .map(|result| result.map_err(|e| e.to_string()))
    }

    pub fn watch_devices(&self) -> impl Stream<Item = Result<Vec<Device>, String>> + 'static {
        self.inner
            .watch_statement(
                "SELECT id, name, public_key, admission, created_at, revoked_at \
                 FROM devices ORDER BY created_at, id"
                    .to_owned(),
                (),
                |statement, parameters| {
                    let mut rows = statement.query(parameters)?;
                    let mut devices = Vec::new();
                    while let Some(row) = rows.next()? {
                        devices.push(Device {
                            id: row.get("id")?,
                            name: row.get("name")?,
                            public_key: row.get("public_key")?,
                            admission: row.get("admission")?,
                            created_at: row.get("created_at")?,
                            revoked_at: row.get("revoked_at")?,
                        });
                    }
                    Ok(devices)
                },
            )
            .map(|result| result.map_err(|e| e.to_string()))
    }

    pub async fn insert(&self, item: &Item) -> Result<(), String> {
        self.insert_many(std::slice::from_ref(item)).await
    }

    /// Queue every recipient's transfer together, or leave the local queue unchanged.
    pub async fn insert_many(&self, items: &[Item]) -> Result<(), String> {
        if items.is_empty() {
            return Ok(());
        }
        let mut writer = self.inner.writer().await.map_err(|e| e.to_string())?;
        let transaction = writer.transaction().map_err(|e| e.to_string())?;
        for item in items {
            transaction.execute(
                "INSERT INTO items (id, kind, sender_id, recipient_id, payload, created_at, expires_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    item.id,
                    item.kind,
                    item.sender_id,
                    item.recipient_id,
                    item.payload,
                    item.created_at,
                    item.expires_at,
                ],
            ).map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())
    }

    pub async fn consume(&self, id: &str) -> Result<(), String> {
        let writer = self.inner.writer().await.map_err(|e| e.to_string())?;
        writer
            .execute(
                "UPDATE items SET burned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                 WHERE id = ? AND burned_at IS NULL",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn burn(&self, id: &str) -> Result<(), String> {
        let writer = self.inner.writer().await.map_err(|e| e.to_string())?;
        writer
            .execute("DELETE FROM items WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upload_error(&self) -> Option<String> {
        self.rejected_upload
            .lock()
            .unwrap()
            .clone()
            .or_else(|| self.inner.status().upload_error().map(ToString::to_string))
    }
}

#[derive(Clone)]
struct Backend {
    client: reqwest::Client,
    origin: String,
    token: String,
}

#[derive(Deserialize)]
struct Credentials {
    token: String,
}

impl Backend {
    async fn credentials(&self) -> Result<Credentials, PowerSyncError> {
        #[derive(Deserialize)]
        struct Session {
            powersync: Credentials,
        }
        Ok(self
            .client
            .get(format!("{}/api/session", self.origin))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?
            .json::<Session>()
            .await?
            .powersync)
    }
}

#[async_trait]
impl Authenticator for Backend {
    async fn resolve_credentials(&self) -> Result<Arc<String>, PowerSyncError> {
        Ok(Arc::new(self.credentials().await?.token))
    }

    fn invalidate_credentials(&self) {}
}

struct Uploader {
    backend: Backend,
    db: PowerSyncDatabase,
    rejected_upload: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl MutationUploader for Uploader {
    async fn upload(&self) -> Result<(), PowerSyncError> {
        #[derive(Deserialize)]
        struct Reply {
            accepted: bool,
            error: Option<String>,
        }
        let mut writes = self.db.crud_transactions();
        while let Some(transaction) = writes.try_next().await? {
            let batch: Vec<_> = transaction
                .crud
                .iter()
                .map(|entry| {
                    json!({
                        "op": entry.update_type,
                        "table": entry.table,
                        "id": entry.id,
                        "opData": entry.data,
                    })
                })
                .collect();
            let response = self
                .backend
                .client
                .post(format!("{}/api/upload", self.backend.origin))
                .bearer_auth(&self.backend.token)
                .timeout(Duration::from_secs(15))
                .json(&json!({ "batch": batch }))
                .send()
                .await?;
            let status = response.status();
            let rejected =
                if status.is_client_error() && status.as_u16() != 408 && status.as_u16() != 429 {
                    Some(format!("Upload rejected ({status})"))
                } else {
                    let reply = response.error_for_status()?.json::<Reply>().await?;
                    (!reply.accepted)
                        .then(|| reply.error.unwrap_or_else(|| "Upload rejected".to_owned()))
                };
            if let Some(error) = rejected {
                *self.rejected_upload.lock().unwrap() = Some(error);
            }
            // Permanent rejections must also leave the queue so later writes can sync.
            transaction.complete().await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Database {
        PowerSyncEnvironment::powersync_auto_extension().unwrap();
        let pool =
            ConnectionPool::single_connection(rusqlite::Connection::open_in_memory().unwrap());
        let env = PowerSyncEnvironment::custom(
            reqwest::Client::new(),
            pool,
            PowerSyncEnvironment::tokio(),
        );
        Database {
            inner: PowerSyncDatabase::new(env, crate::schema::app_schema()),
            rejected_upload: Default::default(),
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn item(id: &str) -> Item {
        Item {
            id: id.into(),
            kind: "transfer".into(),
            sender_id: "sender".into(),
            recipient_id: Some(format!("recipient-{id}")),
            payload: Some("encrypted payload".into()),
            created_at: "2026-11-10T00:00:00Z".into(),
            ..Default::default()
        }
    }

    #[test]
    fn batch_queues_all_recipients_in_one_crud_transaction() {
        runtime().block_on(async {
            let db = database();
            db.insert_many(&[]).await.unwrap();
            assert!(db.inner.next_crud_transaction().await.unwrap().is_none());

            db.insert_many(&[item("first"), item("second")])
                .await
                .unwrap();
            let transaction = db.inner.next_crud_transaction().await.unwrap().unwrap();
            assert_eq!(transaction.crud.len(), 2);
            let writer = db.inner.writer().await.unwrap();
            assert_eq!(
                writer
                    .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            drop(writer);
            transaction.complete().await.unwrap();
            assert!(db.inner.next_crud_transaction().await.unwrap().is_none());
        });
    }

    #[test]
    fn failed_recipient_insert_rolls_back_items_and_upload_queue() {
        runtime().block_on(async {
            let db = database();
            let writer = db.inner.writer().await.unwrap();
            writer
                .execute_batch(
                    "CREATE TRIGGER reject_test_recipient INSTEAD OF INSERT ON items
                 WHEN NEW.id = 'reject'
                 BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;",
                )
                .unwrap();
            drop(writer);

            assert!(
                db.insert_many(&[item("first"), item("reject")])
                    .await
                    .is_err()
            );
            let writer = db.inner.writer().await.unwrap();
            assert_eq!(
                writer
                    .query_row("SELECT count(*) FROM items", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            drop(writer);
            assert!(db.inner.next_crud_transaction().await.unwrap().is_none());
        });
    }
}
