FROM postgres:18
COPY server/migrations/001.sql /docker-entrypoint-initdb.d/00-schema-001.sql
COPY server/migrations/002.sql /docker-entrypoint-initdb.d/00-schema-002.sql
COPY powersync/docker/modules/database-postgres/init-scripts/01-powersync-publication.sql /docker-entrypoint-initdb.d/01-publication.sql
COPY powersync/docker/modules/database-postgres/init-scripts/02-roles.sh /docker-entrypoint-initdb.d/02-roles.sh
CMD ["postgres", "-c", "wal_level=logical"]
