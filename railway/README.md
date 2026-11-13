# Railway images and template

This stack has four services: `postgres` (application data), `bucket` (PowerSync
storage), `powersync`, and `powerbin` (API plus the packaged Native Shell website).
Only `powerbin` and `powersync` need public HTTPS domains. The template uses
prebuilt GHCR images so Railway pulls the runtime images without compiling Rust,
WASM, or the frontend. The unpublished PowerBin draft was updated through the API
on 13 November 2026 and verified against `template.json`, including image sources,
variables, domains, health checks, and volumes. Edits to this checkout do not
automatically update the remote template or existing Railway projects.

## Publish images with GitHub Actions

[publish-images.yml](../.github/workflows/publish-images.yml) runs on pull requests
targeting `master`, pushes to `master` (including merges), and manual runs on
`master`. It installs standalone pnpm, runs `pnpm test`, builds all three custom
images for `linux/amd64`, caches build layers, and runs the disposable
[release smoke check](smoke.mjs) against them. Pull requests
validate without publishing. After a successful `master` check, a separate job
publishes the exact tested images using GitHub's built-in `GITHUB_TOKEN`; no PAT or
Railway credentials are needed. Actions are pinned to commit SHAs.

| Railway service | GHCR image | Dockerfile |
| --- | --- | --- |
| `powerbin` | `ghcr.io/kobiebotha/powerbin` | `Dockerfile` |
| `postgres` | `ghcr.io/kobiebotha/powerbin-postgres` | `railway/postgres.Dockerfile` |
| `powersync` | `ghcr.io/kobiebotha/powerbin-powersync` | `railway/powersync.Dockerfile` |

Each image gets `latest` and `sha-<full Git commit SHA>` tags. Use `latest` for a
moving release channel, or pin all three services to the same commit tag for a
specific release or rollback. The bucket continues to use `postgres:18` directly.
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
has the GHCR configuration applied and confirmed by final API read-back. It remains
unpublished for template testing. A separate
[configuration-only project](https://railway.com/project/8f5b7f87-5f5d-4d1e-88e0-6038a724b7ea)
was created with four configured services and no repository deployment triggers.
That earlier project has not been updated and is not the template source.

The Dockerfiles and settings below define the stack.
[template.json](template.json) is the authored `serializedConfig`, derived from
the actual API response for the PowerSync starter. It is configuration data for
the template API, rather than a file Railway automatically imports from Git.
The draft previously built three services from the `init` branch. Its sources
now use GHCR images, and its defaults use the current `powerbin` database and
roles. No existing running project was changed.

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
or requests a running deployment. This initial authoring helper is for an empty
draft. Updating an existing draft also requires explicit null deletion markers
for obsolete source fields and variables; Railway merges template patches
recursively. The GHCR update's change set is `APPLIED`, and final read-back
confirmed all four services and current defaults. No template publication or
running deployment was requested.

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

The superseded generated draft `7eec8e95-dc52-49b8-a8ed-26d542bb012a` (code `t_GPKU`)
is unpublished and missing literal defaults and the intended branch; do not use
it. It and the configuration-only project remain pending cleanup; no deletion
was requested. The original PowerSync starter is unchanged. See the
[research notes](../docs/railway-template-research.md) for the API distinction.

| Service | Source image | Volume | Public port | Health check |
| --- | --- | --- | --- | --- |
| `postgres` | `ghcr.io/kobiebotha/powerbin-postgres:latest` | `/var/lib/postgresql` | None | None (no HTTP endpoint) |
| `bucket` | Docker image `postgres:18` | `/var/lib/postgresql` | None | None (no HTTP endpoint) |
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
PS_DATA_SOURCE_URI=postgresql://powerbin_sync:${{postgres.POWERBIN_REPLICATION_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/powerbin
PS_STORAGE_SOURCE_URI=postgresql://powersync:${{bucket.POSTGRES_PASSWORD}}@${{bucket.RAILWAY_PRIVATE_DOMAIN}}:5432/powersync
PS_JWKS_URI=http://${{powerbin.RAILWAY_PRIVATE_DOMAIN}}:8080/api/keys
PS_ADMIN_TOKEN=${{secret(48)}}
```

`powerbin`:

```dotenv
PORT=8080
HOST=::
DATABASE_URL=postgresql://powerbin_app:${{postgres.POWERBIN_APP_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/powerbin
API_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
POWERSYNC_URL=https://${{powersync.RAILWAY_PUBLIC_DOMAIN}}
BOOTSTRAP_TOKEN=${{secret(48)}}
JWT_PRIVATE_JWK_FILE=/data/signing-key.json
```

The configuration requests public domains for `powerbin` and `powersync`. `HOST=::`
allows PowerBin to accept Railway private-network IPv6 requests from PowerSync.
The source database initializes the schema, `powerbin_app` restricted write role,
`powerbin_sync` replication/read role, and `powersync` publication only on a fresh
volume. The storage database is separate. Never expose either database publicly.
Existing initialized volumes and environment variables are not renamed
automatically. An existing installation needs a coordinated database/role and
environment migration before adopting these defaults.

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

The web builder uses Rust 1.99.1, Node 24, standalone pnpm 12.18.0, wasm-bindgen 0.2.129,
and the checksum-verified [official NSH 0.4.0 Linux x86_64 SDK](https://github.com/longbridge/nsh/releases/tag/v0.4.0).
Build Linux amd64; NSH does not provide a Linux ARM64 release archive. Debian
Trixie provides the GTK 4.14+ and glibc required by NSH's host descriptor.
The final image contains Node, production server dependencies, and the packaged
site. The strict `.dockerignore` allows source files only: no `.env`, `.tools`,
local node_modules, generated site, target directory, or private keys enter builds.
The browser derives its API URL from its own origin; no deployment secrets or
domain-specific `.env` file are needed to build the site.
PowerSync uses `journeyapps/powersync-service:latest`. The lockfile
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
```

The [release smoke check](smoke.mjs) creates its own labeled containers, network,
fresh database volumes, signing-key volume, and random loopback ports. It generates
temporary credentials and removes its resources on completion or failure. It does
not reuse the development stack. Docker and Node.js 22+ are required. It verifies
the current TSX entry and descriptor assets, PowerSync workers and SQLite WASM,
HTTP MIME types, schema/publication/roles, health checks, authenticated bootstrap,
JWT/JWKS, and signing-key persistence after container replacement. The runtime
image is also checked for accidentally retained development files or secrets.

With the repository's native Rust prerequisites installed, exercise two real SDK
clients against the same disposable stack:

```sh
node railway/smoke.mjs --native
```

The native fixture uses the supplied disposable database URL and skips the local
`.env`. Images can be overridden with `SMOKE_POWERBIN_IMAGE`, `SMOKE_POSTGRES_IMAGE`,
`SMOKE_POWERSYNC_IMAGE`, and `SMOKE_STORAGE_IMAGE`; by default these are the three
release tags above and `postgres:18`.

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
