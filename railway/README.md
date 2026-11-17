# Railway images and template

This stack has three services: `postgres` (application data and PowerSync
storage in one database), `powersync`, and `powerbin` (API plus the packaged Native
Shell website). Sharing Postgres avoids a second database service and volume,
reducing overhead for small self-hosted installations with little resource
contention. Application queries, replication, and sync storage share its resources.
Only `powerbin` and `powersync` need public HTTPS domains. The local template uses
prebuilt GHCR images so Railway pulls the runtime images without compiling Rust,
WASM, or the frontend. Existing Railway projects are not changed by edits to this
checkout. On 2026-11-16, the unpublished PowerBin draft was updated to this
three-service configuration and confirmed by final API read-back, including its
hosting README.

Publish the updated Postgres image before testing a fresh Railway deployment;
the draft already uses the shared database, and the storage role is created by
the new image's initialization script. The local Docker Compose development
stack still uses separate source and storage databases.

## Publish images with GitHub Actions

[publish-images.yml](../.github/workflows/publish-images.yml) runs on pull requests
targeting `master`, pushes to `master` (including merges), and manual runs.
Every run installs standalone pnpm and runs `pnpm test`.
Pull requests and manual runs on other branches run only these unit tests.
Pushes and manual runs on `master` also build all three custom images for
`linux/amd64`, cache build layers, and run the disposable
[release smoke check](smoke.mjs) against them. After a successful `master` check,
a separate job publishes the exact tested images using GitHub's built-in
`GITHUB_TOKEN`; no PAT or Railway credentials are needed. Actions are pinned to
commit SHAs.

| Railway service | GHCR image | Dockerfile |
| --- | --- | --- |
| `powerbin` | `ghcr.io/kobiebotha/powerbin` | `Dockerfile` |
| `postgres` | `ghcr.io/kobiebotha/powerbin-postgres` | `railway/postgres.Dockerfile` |
| `powersync` | `ghcr.io/kobiebotha/powerbin-powersync` | `railway/powersync.Dockerfile` |

Each image gets `latest` and `sha-<full Git commit SHA>` tags. Use `latest` for a
moving release channel, or pin all three services to the same commit tag for a
specific release or rollback.
Image names use the workflow repository owner's lowercase name, so forks publish
under their own account; update the template image references when using a fork.

Before using the template:

1. Wait for the [**Publish container images** workflow](https://github.com/kobiebotha/powerbin/actions/workflows/publish-images.yml)
   on `master` to finish successfully. GitHub defaults new GHCR
   packages to private. Set all three packages to **Public** in each package's
   settings so Railway and template users can pull without credentials. See
   [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images).
2. Verify anonymous access, for example with an empty Docker config directory:

   ```sh
   docker_config=$(mktemp -d)
   docker --config "$docker_config" pull --platform linux/amd64 ghcr.io/kobiebotha/powerbin:latest
   docker --config "$docker_config" pull --platform linux/amd64 ghcr.io/kobiebotha/powerbin-postgres:latest
   docker --config "$docker_config" pull --platform linux/amd64 ghcr.io/kobiebotha/powerbin-powersync:latest
   ```

3. Test a fresh installation from the draft before publishing the template.
   Existing installations need the database/role migration described below
   before adopting the renamed template defaults. Updating the draft does not
   migrate their environment variables or volumes.

Publishing updates GHCR. This workflow does not redeploy Railway; image update
policies or an explicit redeploy control when a running project adopts a new
image. Railway accepts [public Docker image sources](https://docs.railway.com/services#deploying-a-public-docker-image).

## Template authoring

An existing
[PowerBin draft](https://railway.com/workspace/templates/a22b8e33-dd36-455d-9887-1e93d2168810/settings)
initially had a four-service configuration confirmed by API read-back. It now
matches the three-service configuration in this checkout. A separate
[configuration-only project](https://railway.com/project/8f5b7f87-5f5d-4d1e-88e0-6038a724b7ea)
was created with four configured services and no repository deployment triggers.
The configuration-only project retains its earlier layout; it has not been
migrated. Updating the draft did not deploy or migrate a running installation.

The Dockerfiles and settings below define the stack.
[template.json](template.json) is the authored `serializedConfig`, derived from
the actual API response for the PowerSync starter. It is configuration data for
the template API, rather than a file Railway automatically imports from Git.
Those earlier GitHub-backed service sources used
[`kobiebotha/powersync-native-shell-demo/tree/init`](https://github.com/kobiebotha/powersync-native-shell-demo/tree/init)
with the repository root as their root directory. The local specification uses
GHCR image sources and three services sharing one Postgres database. It is now
applied to the unpublished PowerBin draft.

## Direct API draft authoring

The public `/graphql/v2` schema omits the app's template-authoring mutations.
Railway's current app uses `/graphql/internal` for `templateChangeSetStage`,
`templateChangeSets`, and `templateChangeSetApply`. This was confirmed from its
official [editor asset](https://railway.com/assets/useTemplateEditor-OEqlO1md.js)
and [shared app asset](https://railway.com/assets/modal-D5tuZPNc.js). The endpoint
is undocumented and may change; no Railway UI or browser was used.

[template-api.mjs](template-api.mjs) edits an existing unpublished draft directly.
It stages the configuration, verifies the staged `draftView`, applies the change
set, and compares the final `serializedConfig` with `template.json`, including
variable defaults, source branches, networking, and volumes. It never publishes
or requests a running deployment. The current PowerBin draft's change set is
`APPLIED`; final read-back confirmed all three services, GHCR sources, literal and
generated defaults, service references, healthchecks, public-domain settings,
volumes, and removal of the separate storage service.

Use unique service and volume IDs for each independently derived template.
Copied starter IDs caused collisions in this authoring flow; PowerBin's local
configuration and remote draft now use their own canonical IDs.

```sh
node railway/template-api.mjs plan
node railway/template-api.mjs apply --template EMPTY_DRAFT_ID
```

Applying requires an account or workspace API token in `RAILWAY_API_TOKEN`,
supplied through the environment or the ignored root `.env`. A project token is
insufficient for workspace template authoring. Tokens are never printed.
The script edits only the specified unpublished draft and keeps progress and the
read-back under ignored `.tools/`. If a mutation does not return a saved result,
it stops instead of blindly repeating it.

For later revisions, the remote configuration must match the helper's saved
verified export. To incorporate independently inspected changes, pass
`--expected-config PATH` with a fresh snapshot of the template's `serializedConfig`.
The helper compares that entire snapshot before making changes and refuses
unfinished mutations or existing staged edits. Updates explicitly remove deleted
services and verify the complete resulting configuration before and after apply.

The superseded generated draft `7eec8e95-dc52-49b8-a8ed-26d542bb012a` (code `t_GPKU`)
is unpublished and missing literal defaults and the intended branch; do not use
it. It and the configuration-only project remain pending cleanup; no deletion
was requested. The original PowerSync starter is unchanged. See the
[research notes](../docs/railway-template-research.md) for the API distinction.

| Service | Source image | Volume | Public port | Health check |
| --- | --- | --- | --- | --- |
| `postgres` | `ghcr.io/kobiebotha/powerbin-postgres:latest` | `/var/lib/postgresql` | None | None (no HTTP endpoint) |
| `powersync` | `ghcr.io/kobiebotha/powerbin-powersync:latest` | None | 8080 | `/probes/startup` |
| `powerbin` | `ghcr.io/kobiebotha/powerbin:latest` | `/data` | 8080 | `/health` |

Image sources do not need `RAILWAY_DOCKERFILE_PATH`.
Leave start commands unset: each image supplies its command. Use one replica per
service. Keep the services in one region. The PowerBin image runs as root, so it can
write the mounted `/data` volume; the signing-key helper restricts its parent to
0700 and creates the private key with mode 0600. Do not set a non-root run UID
without provisioning matching volume ownership.

## Template variable defaults

These are the authored defaults in `template.json`. Railway resolves
[reference variables](https://docs.railway.com/variables) and
[secret functions](https://docs.railway.com/templates/create#template-variable-functions)
when a user creates a deployment. Names in the references must match the service
names above. Generated passwords use URL-safe alphanumeric characters.

`postgres`:

```dotenv
POSTGRES_DB=powerbin
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${{secret(48)}}
POWERBIN_APP_PASSWORD=${{secret(48)}}
POWERBIN_REPLICATION_PASSWORD=${{secret(48)}}
POWERBIN_STORAGE_PASSWORD=${{secret(48)}}
```

`powersync`:

```dotenv
PORT=8080
PS_DATA_SOURCE_URI=postgresql://powerbin_sync:${{postgres.POWERBIN_REPLICATION_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/powerbin
PS_STORAGE_SOURCE_URI=postgresql://powerbin_storage:${{postgres.POWERBIN_STORAGE_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/powerbin
PS_JWKS_URI=http://${{powerbin.RAILWAY_PRIVATE_DOMAIN}}:8080/api/keys
PS_ADMIN_TOKEN=${{secret(48)}}
```

`powerbin`:

```dotenv
PORT=8080
HOST=::
TRUST_PROXY_HEADER=x-real-ip
DATABASE_URL=postgresql://powerbin_app:${{postgres.POWERBIN_APP_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/powerbin
API_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
ALLOWED_ORIGINS=
POWERSYNC_URL=https://${{powersync.RAILWAY_PUBLIC_DOMAIN}}
BOOTSTRAP_TOKEN=${{secret(48)}}
JWT_PRIVATE_JWK_FILE=/data/signing-key.json
```

The configuration requests public domains for `powerbin` and `powersync`. `HOST=::`
allows PowerBin to accept Railway private-network IPv6 requests from PowerSync.
`TRUST_PROXY_HEADER=x-real-ip` enables Railway's client-IP and HTTPS forwarding
headers. Railway must overwrite `X-Real-IP` and `X-Forwarded-Proto`, and the public
backend must be reachable only through that trusted edge. The setting is off by
default outside this template. A single immediate proxy that appends the real
peer address as the rightmost `X-Forwarded-For` entry can instead use
`TRUST_PROXY_HEADER=x-forwarded-for`. Pairing, bootstrap, and reveal each have
their own per-client budget of 30 requests per minute. Existing installations
must set the variable when adopting the updated image; this source change does
not update running projects.

Postgres initializes the application schema, `powerbin_app` restricted write role,
`powerbin_sync` replication/read role, and `powerbin_storage` storage role only on
a fresh volume. PowerSync's source and storage connections use the same `powerbin`
database with their respective roles. The storage role owns the `powersync`
schema and has database connection permission, without superuser privileges,
database-wide schema creation permission, or access to the application tables.
The `powersync` publication explicitly lists only `devices` and `items`; never
create it with `FOR ALL TABLES`, which would also publish PowerSync's own storage
tables. Keep Postgres on the private network.

Existing initialized volumes and environment variables are not changed
automatically. An existing four-service installation needs a coordinated storage,
role, and environment migration before adopting these defaults. Changing the
storage URI does not move the old bucket state: preserve the existing `bucket`
service and volume until the migration and client recovery have been verified.
Fresh deployments use the shared layout directly.

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

## Custom domains

The server accepts browser requests whose HTTPS origin matches the hostname
Railway routes to the `powerbin` service. A custom domain serving both the app
and API does not need an `ALLOWED_ORIGINS` entry with this server code.
`ALLOWED_ORIGINS` permits additional cross-origin frontends, such as an app hosted
separately from its API. It accepts comma-separated full HTTPS origins with no
spaces, paths, or trailing slashes; the `API_ORIGIN` origin is already allowed.

1. In the `powerbin` service variables, pin `API_ORIGIN` to its current resolved
   HTTPS URL, such as `https://your-service.up.railway.app`. It is also the session
   JWT issuer. The template starts with a `RAILWAY_PUBLIC_DOMAIN` reference;
   pinning the existing value keeps that identity stable when Railway refreshes
   domain variables during a redeploy.
2. Add the custom domain to the `powerbin` service with target port `8080`, then
   add the DNS records Railway shows at your DNS provider. Railway handles the
   public TLS certificate and forwards requests to the app's HTTP port.
3. Apply any variable changes and redeploy `powerbin`. Open the HTTPS URL after
   Railway has provisioned its certificate. Keep `TRUST_PROXY_HEADER=x-real-ip`
   so the server recognizes Railway's HTTPS forwarding; the backend must be
   reachable only through that trusted edge.

Verify an actual JavaScript asset with the browser's origin header, using a
filename from the deployed page:

```sh
curl -i -H 'Origin: https://powerbin.example.com' \
  'https://powerbin.example.com/<javascript-filename-from-page>.js'
```

Expect `200` and `Access-Control-Allow-Origin: https://powerbin.example.com`.
Images released before the automatic same-origin fix reject new custom origins
until the process is reconfigured. An optional template variable and README
update alone cannot change an already published container image. If JavaScript
still returns `403` with `Origin not allowed`, add the custom origin explicitly
and apply the variables to redeploy the service:

```dotenv
ALLOWED_ORIGINS=https://powerbin.example.com
```

Preserve any existing comma-separated entries. This workaround needs no image
rebuild. To use the automatic behavior, publish the updated PowerBin image and
redeploy from it; the template uses `ghcr.io/kobiebotha/powerbin:latest`.

A certificate name mismatch is a separate TLS problem; follow Railway's
[SSL troubleshooting guide](https://docs.railway.com/networking/troubleshooting/ssl).

Template edits apply to new installations. Existing deployments keep their
running image and configuration until updated and redeployed.

## Scheduled bucket cleanup

The PowerSync image starts its sync service and a supervised compaction schedule
together. After the service becomes ready, it runs the upstream `compact`
command, then starts each subsequent successful cycle one hour after the
previous job started. Job duration does not shift that hourly cadence, and jobs
do not overlap;
a failed run retries after five minutes and emits a failure status without
connection strings. A job that runs for 30 minutes is terminated and retried,
so a stalled database connection cannot stop cleanup indefinitely. Shutdown
stops both the service and any running job.
The local Docker stack builds this same image. The Railway template uses its
default image entrypoint, so the schedule runs without a separate Railway cron
service or start-command override. Existing deployments need the new image and
a redeploy to adopt it; no running deployment is changed by editing the template.

[Compaction](https://docs.powersync.com/maintenance-ops/compacting-buckets)
removes superseded ciphertext from active sync bucket history after the burn
has replicated. Cleanup is asynchronous: a normal successful cycle leaves up to
about one hour plus replication and job duration before history is compacted;
failed or stopped jobs can extend that period. Monitor the compaction success
and failure messages. This is not immediate secure erasure: source/storage WAL,
database backups, and copies already downloaded by clients have independent
retention. Set backup/WAL retention for the deployment's requirements.

This stack uses Postgres bucket storage (storage version 2). The faster chunked
compaction described for storage version 4 requires MongoDB bucket storage in
self-hosted deployments; it does not apply to this Postgres configuration.

## Build and verification

The web builder uses Rust 1.99.1, Node 24, standalone pnpm 12.18.0, wasm-bindgen 0.2.129,
and the checksum-verified [official NSH 0.4.0 Linux x86_64 SDK](https://github.com/longbridge/nsh/releases/tag/v0.4.0).
Build Linux amd64; NSH does not provide a Linux ARM64 release archive. Debian
Trixie provides the GTK 4.14+ and glibc required by NSH's host descriptor.
The final image contains Node, production server dependencies, and the packaged
site. The strict `.dockerignore` allows source files only: no `.env`, `.tools`,
local node_modules, generated site, target directory, or private keys enter builds.
The browser derives its API URL from its own origin; no deployment secrets or
domain-specific `.env` file are needed to build the site.
PowerSync uses the audit-tested `journeyapps/powersync-service:1.26.0`. The lockfile
includes pnpm's platform packages as well as the frozen application dependencies.
The Docker build includes the current `app/App.tsx` and `app/ui/` views; generated
Native Shell files are rebuilt inside the image.

```sh
docker build --platform linux/amd64 -t powerbin:release .
docker build --platform linux/amd64 -f railway/postgres.Dockerfile -t powerbin-postgres:release .
docker build --platform linux/amd64 -f railway/powersync.Dockerfile -t powerbin-powersync:release .
docker pull postgres:18
pnpm test
node railway/smoke.mjs
node railway/compaction-smoke.mjs
```

The [release smoke check](smoke.mjs) creates its own labeled containers, network,
fresh database volumes, signing-key volume, and random loopback ports. It generates
temporary credentials and removes its resources on completion or failure. It does
not reuse the development stack. Docker and Node.js 22+ are required. It verifies
the current TSX entry and descriptor assets, PowerSync workers and SQLite WASM,
HTTP MIME types, the shared database and restricted roles, the explicit
publication excluding PowerSync storage tables, health checks, authenticated
bootstrap, JWT/JWKS, and signing-key persistence after container replacement. It
also sends browser module, API, and preflight requests through a new HTTPS
hostname without an `ALLOWED_ORIGINS` entry and confirms unrelated origins remain
blocked. The runtime image is also checked for accidentally retained development
files or secrets.

The [compaction check](compaction-smoke.mjs) uses one disposable Postgres database
for source tables and PowerSync storage. It reproduces retained superseded
ciphertext without the schedule, restarts only its own test service with the
image's default supervisor,
then checks that automatic compaction removes the old payload while preserving
live ciphertext. It never reads `.env` or modifies a running installation. The
[scheduler tests](powersync-supervisor.test.mjs) exercise hourly scheduling,
readiness, retries, non-overlap, and signal handling without Docker.

On 2026-11-16, the shared-database release smoke and compaction checks passed using
locally rebuilt Postgres and PowerSync images and the existing `powerbin:readiness`
application image. The release check verified storage-role isolation and confirmed
that only `public.devices` and `public.items` remain published after PowerSync
creates its storage tables. No native-client sync test or Railway deployment was
run for this change. The [template helper tests](template-api.test.mjs) use an
isolated mocked API to check updates, database removal, interrupted runs, and
refusal to overwrite unexpected changes.

With the repository's native Rust prerequisites installed, exercise two real SDK
clients against the same disposable stack:

```sh
node railway/smoke.mjs --native
```

The native fixture uses the supplied disposable database URL and skips the local
`.env`. Images can be overridden with `SMOKE_POWERBIN_IMAGE`, `SMOKE_POSTGRES_IMAGE`,
and `SMOKE_POWERSYNC_IMAGE`; by default these are the three release tags above.
The compaction check uses `SMOKE_STORAGE_IMAGE` (default `postgres:18`) for its
single disposable database.

On 13 November 2026, PowerBin built locally for Linux amd64 from merged `master`
commit `7372576`, and the default release container/API smoke check passed,
including all 65 served assets and signing-key persistence. This check did not use
`--native`. The full [Docker Compose setup](../docs/docker.md) also passed a fresh,
isolated stack check, and its Docker-only credential setup command was verified.
Actionlint passed, and all 28 unit tests passed in the GitHub merge run. That run
failed during image building before publishing; the same PowerBin Docker build
passed locally. A successful GitHub publishing run and anonymous GHCR pulls are
still required before deploying the template.

On 11 November 2026, all three release images built successfully for
Linux amd64, including a frozen pnpm 12.18.0 install and the mixed TSX/Rust/WASM
frontend. `node railway/smoke.mjs --native` passed against fresh databases:

- Source and storage Postgres initialized; PowerBin and PowerSync health checks passed.
- The current TSX entry and all descriptor assets were present. All 65 served
  JavaScript/WASM/manifest/data assets passed HTTP checks, including PowerSync's
  adapter, workers, and SQLite WASM. No development environment files, private
  keys, or build toolchains were retained in the runtime image.
- `/api/keys` exposed only the public key. Bootstrap required authentication and
  succeeded once; session JWTs verified against that key.
- Two native SDK clients synced the device directory. A disconnected insert
  stayed local, survived closing and reopening SQLite, and uploaded to Postgres
  and the recipient after reconnecting.
- Consumption synced an empty tombstone; stale uploads could not resurrect it.
  Permanent rejection drained correctly, allowing later uploads and deletion.
- Replacing the PowerBin container retained the mounted signing key and existing
  device authentication. Key permissions were 0600 inside a 0700 directory.
- The disposable containers, network, and database/key volumes were removed;
  the existing development stack was left untouched.

That earlier smoke run used PowerSync Service 1.25.0. The current Dockerfile uses
`latest`; the later release and Compose checks are recorded above. No Railway
application retest was performed during API authoring.

The 17 backend/domain/web/signing-key tests and browser adapter type-check also
passed. Browser/macOS pairing, saved snippets, and one-use guest reveal were
verified separately against the local development stack; see the
[TSX migration validation](../docs/tsx-migration-validation.md). No Railway
deployment or template publication has been performed.

The layout follows the official [PowerSync Railway starter](https://railway.com/deploy/powersync-starter-postgres)
and [Postgres bucket-storage example](https://github.com/powersync-ja/self-host-demo/tree/main/demos/nodejs-postgres-bucket-storage),
with PowerBin's authenticated backend and shared native/web frontend.
