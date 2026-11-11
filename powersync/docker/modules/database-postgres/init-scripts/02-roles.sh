#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$RELAY_APP_PASSWORD" \
  --set=replication_password="$RELAY_REPLICATION_PASSWORD" <<'SQL'
CREATE USER relay_app WITH PASSWORD :'app_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON devices, pairing_sessions, items TO relay_app;

CREATE USER relay_sync WITH REPLICATION PASSWORD :'replication_password';
GRANT SELECT ON devices, items TO relay_sync;
SQL
