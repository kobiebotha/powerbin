#!/bin/sh
set -eu
psql --host /var/run/postgresql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=database="$POSTGRES_DB" \
  --set=storage_password="$POWERBIN_STORAGE_PASSWORD" <<'SQL'
CREATE USER powerbin_storage WITH PASSWORD :'storage_password';
CREATE SCHEMA powersync AUTHORIZATION powerbin_storage;
GRANT CONNECT ON DATABASE :"database" TO powerbin_storage;
SQL
