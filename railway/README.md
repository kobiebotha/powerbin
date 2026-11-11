# Railway template preparation

This stack has four services: `postgres` (application data), `bucket` (PowerSync
storage), `powersync`, and `relay` (API plus the packaged Native Shell website).
Only `relay` and `powersync` need public HTTPS domains. No template has been
created, published, or deployed.

Railway templates are created in the [template composer](https://docs.railway.com/templates/create)
or generated from an existing project. The Dockerfiles and settings below are
the inputs to that workflow; this directory is not an invented template manifest.
Use the eventual published repository/branch for all three GitHub-backed services,
with the repository root as their root directory. The bucket uses a public image.

| Service | Source / Dockerfile | Volume | Public port | Health check |
| --- | --- | --- | --- | --- |
| `postgres` | Repository; `railway/postgres.Dockerfile` | `/var/lib/postgresql` | None | None (no HTTP endpoint) |
| `bucket` | Docker image `postgres:18` | `/var/lib/postgresql` | None | None (no HTTP endpoint) |
| `powersync` | Repository; `railway/powersync.Dockerfile` | None | 8080 | `/probes/startup` |
| `relay` | Repository; root `Dockerfile` | `/data` | 8080 | `/health` |

Set `RAILWAY_DOCKERFILE_PATH` to the indicated path on `postgres` and `powersync`.
Leave start commands unset: each image supplies its command. Use one replica per
service. Keep the services in one region. The PowerBin image runs as root, so it can
write the mounted `/data` volume; the signing-key helper restricts its parent to
0700 and creates the private key with mode 0600. Do not set a non-root run UID
without provisioning matching volume ownership.

## Template composer variables

Enter the expressions literally in the template composer. Railway resolves
[reference variables](https://docs.railway.com/variables) and
[secret functions](https://docs.railway.com/templates/create#template-variable-functions)
when a user creates a deployment. Names in the references must match the service
names above. Generated passwords use URL-safe alphanumeric characters.

`postgres`:

```dotenv
POSTGRES_DB=relay
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${{secret(48)}}
RELAY_APP_PASSWORD=${{secret(48)}}
RELAY_REPLICATION_PASSWORD=${{secret(48)}}
RAILWAY_DOCKERFILE_PATH=railway/postgres.Dockerfile
```

`bucket`:

```dotenv
POSTGRES_DB=powersync
POSTGRES_USER=powersync
POSTGRES_PASSWORD=${{secret(48)}}
```

`powersync`:

```dotenv
PORT=8080
RAILWAY_DOCKERFILE_PATH=railway/powersync.Dockerfile
PS_DATA_SOURCE_URI=postgresql://relay_sync:${{postgres.RELAY_REPLICATION_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/relay
PS_STORAGE_SOURCE_URI=postgresql://powersync:${{bucket.POSTGRES_PASSWORD}}@${{bucket.RAILWAY_PRIVATE_DOMAIN}}:5432/powersync
PS_JWKS_URI=http://${{relay.RAILWAY_PRIVATE_DOMAIN}}:8080/api/keys
PS_ADMIN_TOKEN=${{secret(48)}}
```

`relay`:

```dotenv
PORT=8080
HOST=::
DATABASE_URL=postgresql://relay_app:${{postgres.RELAY_APP_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/relay
API_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
POWERSYNC_URL=https://${{powersync.RAILWAY_PUBLIC_DOMAIN}}
BOOTSTRAP_TOKEN=${{secret(48)}}
JWT_PRIVATE_JWK_FILE=/data/signing-key.json
```

Generate a public domain for `relay` and `powersync` in the composer. `HOST=::`
allows PowerBin to accept Railway private-network IPv6 requests from PowerSync.
The source database initializes the schema, `relay_app` restricted write role,
`relay_sync` replication/read role, and `powersync` publication only on a fresh
volume. The storage database is separate. Never expose either database publicly.

Railway has no template function for a paired Ed25519 JWK. PowerBin generates the
key once on the explicit `/data` path and reuses it across deployments. Existing
`JWT_PRIVATE_JWK` configuration takes precedence and works exactly as before.
PowerSync fetches the public JWKS from PowerBin's `/api/keys` using the documented
[`client_auth.jwks_uri`](https://docs.powersync.com/configuration/auth/custom#self-hosted-configuration).
The private key stays in the PowerBin volume. Preserve this volume across redeploys.

After startup, open PowerBin's public domain and use its generated `BOOTSTRAP_TOKEN`
from Railway's variables screen to initialize the first device. Pair further
devices through the app. For locally built native apps, put the deployed public
URL in the local `.env` entries `API_ORIGIN` and `WEB_ORIGIN`, then rebuild.
`WEB_ORIGIN` is required for native guest links to contain the full public URL;
entering an API URL in the setup screen does not set that build-time value.
The build script reads `.env`, rather than exported shell variables. Change only
these public URL entries; keep deployed secrets out of local app builds.

## Build and verification

The web builder uses Rust 1.99.1, Node 24, pnpm 11.22.0, wasm-bindgen 0.2.129,
and the checksum-verified [official NSH 0.4.0 Linux x86_64 SDK](https://github.com/longbridge/nsh/releases/tag/v0.4.0).
Build Linux amd64; NSH does not provide a Linux ARM64 release archive. Debian
Trixie provides the GTK 4.14+ and glibc required by NSH's host descriptor.
The final image contains Node, production server dependencies, and the packaged
site. The strict `.dockerignore` allows source files only: no `.env`, `.tools`,
local node_modules, generated site, target directory, or private keys enter builds.
The browser derives its API URL from its own origin; no deployment secrets or
domain-specific `.env` file are needed to build the site.

```sh
docker build --platform linux/amd64 -t relay:local .
docker build -f railway/postgres.Dockerfile -t relay-postgres:local .
docker build -f railway/powersync.Dockerfile -t relay-powersync:local .
pnpm test
```

All three Dockerfiles built successfully locally, including the Linux amd64
PowerBin image. An isolated four-service smoke test passed with fresh databases:

- Source and storage Postgres initialized; PowerBin and PowerSync health checks passed.
- The packaged site and worker assets loaded; `/api/keys` exposed only the public
  key. Authenticated bootstrap/session JWTs verified against that key.
- Two native SDK clients synced the device directory. A disconnected insert
  stayed local, survived closing and reopening SQLite, and uploaded to Postgres
  and the recipient after reconnecting.
- Consumption synced an empty tombstone; stale uploads could not resurrect it.
  Permanent rejection drained correctly, allowing later uploads and deletion.
- Replacing the PowerBin container retained the mounted signing key and existing
  device authentication. Key permissions were 0600 inside a 0700 directory.
- Disposable containers, network, anonymous database volumes, and key files
  were cleaned up; the existing development stack was left untouched.

Browser/macOS pairing, saved snippets, and one-use guest reveal were verified
separately against the local development stack. No Railway deployment or
template publication has been performed.

The layout follows the official [PowerSync Railway starter](https://railway.com/deploy/powersync-starter-postgres)
and [Postgres bucket-storage example](https://github.com/powersync-ja/self-host-demo/tree/main/demos/nodejs-postgres-bucket-storage),
with PowerBin's authenticated backend and shared native/web frontend.
