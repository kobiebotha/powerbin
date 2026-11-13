# Run the full stack with Docker

This path runs the packaged browser app, API, PowerSync, and two PostgreSQL
databases from published images. It needs Docker Engine or Docker Desktop with
Compose v2.20.3+, and this checkout. No host Rust, Native Shell, pnpm, or Node.js
installation is required. The custom images are `linux/amd64`; ARM64 hosts need
Docker's x86 emulation enabled.

Clone the repository, then generate a separate, ignored `.env.docker` with unique
credentials. This command runs the setup script in a disposable Node container:

```sh
git clone https://github.com/kobiebotha/powerbin.git
cd powerbin
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/workspace" --workdir /workspace \
  node:24-alpine node scripts/setup-docker.mjs
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d --wait --wait-timeout 180
```

On Windows, run the setup command in WSL, or use an installed Node.js 22.12+
with `node scripts/setup-docker.mjs`. The setup script preserves an existing
`.env.docker` and never reads or modifies the source-development `.env`.

Open <http://localhost:18088>. Retrieve `POWERBIN_BOOTSTRAP_TOKEN` from your local
`.env.docker` and enter it to initialize the first device. Pair subsequent
devices from an existing device. PowerSync is available at
<http://localhost:18080>; neither database has a public host port.

The default ports match the source-development stack, so stop that stack first
or change `POWERBIN_HTTP_PORT`, `POWERBIN_SYNC_PORT`, and their corresponding
`POWERBIN_API_ORIGIN` and `POWERBIN_POWERSYNC_URL` values in `.env.docker`.

## Persistence and updates

Compose stores application data, PowerSync storage, and the signing key in three
named volumes under the `powerbin-selfhost` project. Keep the same project name
and `.env.docker` on subsequent starts. `docker compose --env-file .env.docker down`
stops the stack while retaining the data. Adding `--volumes` deletes the data and
signing key, and should only be used for an intentional fresh installation.

The source schema and restricted database roles initialize on a fresh volume.
Changing passwords in `.env.docker` does not change passwords in an existing
database. Preserve the generated credentials; rotate them with coordinated
database changes. This stack uses separate volumes from the CLI development
stack and does not migrate an existing installation.

To adopt newly published images:

```sh
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d --wait --wait-timeout 180
```

The three custom images share `POWERBIN_IMAGE_TAG`. Set it to
`sha-<full Git commit SHA>` in `.env.docker` to pin a tested release instead of
following `latest`. Review schema changes before updating an existing database;
image updates do not rerun PostgreSQL initialization scripts. Back up the two
database volumes, key volume, and `.env.docker` before an upgrade.

## Your own server

The default HTTP endpoints bind only to loopback. For a server, put a reverse
proxy with HTTPS in front of both PowerBin and PowerSync. Set
`POWERBIN_API_ORIGIN` and `POWERBIN_POWERSYNC_URL` to the two public HTTPS
origins before initializing a device, then restart with the `up` command above.
The PowerSync proxy must support WebSocket upgrades (used by the browser app),
streaming responses, and long-lived connections.
If your proxy runs in another container, connect it to this Compose network or
set `POWERBIN_BIND_ADDRESS` to a private interface reachable by the proxy.

Keep the database ports private. Browser encryption requires HTTPS outside
localhost. Native clients also need their public API/web URLs configured when
they are built; see [the app instructions](../app/README.md).

Check startup with:

```sh
docker compose --env-file .env.docker ps
docker compose --env-file .env.docker logs --tail 100 powerbin powersync
```
