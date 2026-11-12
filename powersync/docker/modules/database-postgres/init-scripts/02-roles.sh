#!/bin/sh
set -eu
psql --host /var/run/postgresql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POWERBIN_APP_PASSWORD" \
  --set=replication_password="$POWERBIN_REPLICATION_PASSWORD" <<'SQL'
CREATE USER powerbin_app WITH PASSWORD :'app_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON devices, pairing_sessions, items TO powerbin_app;

CREATE USER powerbin_sync WITH REPLICATION PASSWORD :'replication_password';
GRANT SELECT ON devices, items TO powerbin_sync;
SQL
