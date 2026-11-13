# Needs validation

> These are the original audit leads. Current local fixes, regression checks,
> deployment requirements, and residual risks are recorded in
> [REPORT.md, section 8](REPORT.md#8-local-remediation--13-november-2026).

These are source-grounded leads whose decisive check is outside what this audit could observe. They carry no severity and are not confirmed vulnerabilities. Do not send audit traffic to a live deployment; the deployment checks below are things the owner observes on their own systems.

## App accepts a plain-HTTP server origin for any host and sends the setup token and device bearer over it

Fingerprint: `app/src/controller.rs:new_session:http-origin-any-host`

The setup screen takes a server URL from the user. The only check is that the scheme is http or https and that a host is present. When the URL is http on a non-loopback host, the first-device flow sends the new device token as a bearer to /api/session, then the installation setup token as a bearer to /api/bootstrap with the device token again in the JSON body, all in cleartext. Every later API call and sync-credential refresh repeats the device bearer in cleartext. The project's own CLI refuses this transport and allows http only for localhost, 127.0.0.1 and [::1]. A network observer on the path would obtain the device bearer, which carries that device's API authority: listing, renaming and revoking devices, burning items, uploading rows, and minting sync tokens that expose all ciphertext and metadata. Item plaintext and keys stay protected by client-side encryption. Browser builds are less exposed because Web Crypto storage needs a secure context outside localhost. Native builds use reqwest's own socket and TLS stack, so OS policies such as iOS App Transport Security, which apply to the platform URL APIs, would not normally block the request. The shipped default origin is loopback, so exposure depends on a user entering a remote http URL.

**Claimed root cause:** new_session() validates the entered origin only with `matches!(url.scheme(), "http" | "https")` and a host-presence test, and request_with_method() and the native sync backend attach the bearer to whatever origin was stored. Cleartext transport to a remote host is never refused.

**Source trace**

- entrypoint: `app/src/bridge.rs:220` (Field::set). The `origin` field from the native-to-JS bridge (the PowerBin server input) is stored in UI state without any check.
- propagation: `app/src/controller.rs:483` (Controller::new_session). The origin is accepted if its scheme is http or https and it has a host. An http URL for a remote host passes and becomes Session.origin.
- propagation: `app/src/controller.rs:521` (Controller::bootstrap). The freshly generated device token is sent as the bearer for GET /api/session on that origin.
- propagation: `app/src/controller.rs:548` (Controller::bootstrap). The setup token is passed as the bearer for POST /api/bootstrap on that origin, with the device token in the JSON body built by identity().
- sink: `app/src/controller.rs:924` (request_with_method). The token is attached with bearer_auth and the request is sent to `origin + path` with no transport check.

**Evidence**

- `app/src/controller.rs:483`: Scheme allow-list accepts http for any host. There is no loopback restriction.
- `cli/src/client.ts:32`: Sibling control in the CLI: http is rejected unless the host is localhost, 127.0.0.1 or [::1].
- `app/src/controller.rs:1176`: identity() places device_token in the JSON body used by POST /api/bootstrap and POST /api/pairings.
- `app/src/db_native.rs:202`: The native sync backend re-sends the device bearer to `{origin}/api/session` on every credential refresh, and to /api/upload at line 254.
- `docs/docker.md:64`: Operator guidance says to put an HTTPS reverse proxy in front of a server deployment. The client does not enforce it.

**Blockers**

- The app crate does not build in the approved offline sandbox (it depends on the nsh git repository), so acceptance of an http non-loopback origin and the cleartext Authorization header were not observed locally. Source reading alone is unambiguous on the check, but no local reproduction exists.
- Exposure depends on a deployment and user fact outside source: whether any installation gives a native client a non-loopback http origin. The default origin is loopback and the documentation recommends HTTPS, but nothing in the client prevents the alternative.

**Local check:** On an isolated machine, start a dummy HTTP listener on a non-loopback test address (for example a host-only interface address), build the native app, enter http://<test-address>:<port> as the PowerBin server with a dummy device name and dummy setup token, and press Create my PowerBin. Confirm the listener receives GET /api/session with an Authorization: Bearer header and POST /api/bootstrap whose Authorization bearer is the dummy setup token and whose JSON body contains device_token. Once the crate builds, a unit test that sets ui.origin to http://192.0.2.1 and calls new_session() should return Ok, which settles the check itself.

**Owner check:** The owner checks the server URL stored on each paired device (shown on the setup or session state) and confirms every one is https or a loopback address.

## Burned ciphertext stays in PowerSync bucket storage because the deployment never runs compaction

Fingerprint: `powersync/sync-config.yaml:personal-stream:burned-payload-in-bucket-history`

Burn, expiry, and guest-link reveal set items.payload to NULL in the primary Postgres table, and the app tells the user the server copy has burned. Before that, the row version holding the payload was replicated through the powersync publication and written into the sync engine's Postgres bucket storage, because every items query in the personal stream is SELECT *. In PowerSync Service 1.26.0 (the sandbox image, read in check-4.log and check-5.log), the Postgres storage writer only inserts new bucket_data rows. A superseded PUT keeps its data column until PostgresCompactor rewrites it to a MOVE with data = NULL, and that compactor runs only from the separate 'compact' CLI command. Postgres storage has no scheduled or incremental compaction in that version. The repository runs only 'start -r unified' against Postgres storage and defines no compact job. On 1.26.0, then, the ciphertext of a burned transfer, saved snippet, or one-use link stays in the bucket storage database and its backups indefinitely. It is also re-sent to any client that syncs the bucket from an earlier op id, which getBucketDataBatch serves as op_id > start_op_id. A later reader of that storage who also has the matching key, such as an old guest link URL from a chat history, could decrypt a message the UI reported as burned. The README says the burn clears the server payload and lists only SQLite journals and backups as caveats. The deployed image is ':latest', so whether the running version behaves the same is not settled.

**Claimed root cause:** Burn is an UPDATE of the primary row only. The PowerSync bucket storage keeps the earlier PUT operation, payload included, until a compact run. The repository neither schedules compaction nor keeps payload out of the replicated history.

**Source trace**

- entrypoint: `server/src/server.js:362` (POST /api/links/:id/reveal). An unauthenticated guest reveal sets payload to NULL and burned_at on the primary row. burnItem (line 114) and expireItems (line 122) do the same for transfers and saved snippets.
- propagation: `powersync/docker/modules/database-postgres/init-scripts/01-powersync-publication.sql:1` (publication powersync). The whole items table is published, so the earlier row version with its payload was already streamed to the sync engine.
- propagation: `powersync/sync-config.yaml:11` (personal stream). SELECT * on lines 11-13 puts the payload column into the bucket operations for the recipient, sender, and saved-item queries.
- sink: `railway/powersync.Dockerfile:5` (service command). The service runs only 'start -r unified' on journeyapps/powersync-service:latest with Postgres storage (railway/service.yaml line 10). Nothing invokes the 'compact' command, so superseded PUT operations keep their data in bucket_data.

**Evidence**

- `server/src/server.js:114`: burnItem clears the payload with an UPDATE on the primary items table only.
- `server/src/server.js:122`: expireItems clears the payload with an UPDATE on the primary table only.
- `powersync/sync-config.yaml:11`: All three items queries (lines 11-13) select every column, including payload.
- `railway/service.yaml:10`: Bucket storage type is postgresql. In 1.26.0, PostgresSyncRulesStorage.compact reports that incremental compacting is unsupported on Postgres storage, and compaction runs only through the compact CLI command (check-3.log, check-4.log).
- `compose.yaml:65`: The powersync service definition has no compact command and no companion job. The image tag defaults to latest.
- `app/src/controller.rs:891`: After a reveal the client reports 'Revealed here. The server copy has burned.'
- `README.md:149`: Lines 149-152 say the burn clears the server payload and propagates through sync. The caveats name SQLite journals and backups, not sync-engine history.

**Blockers**

- The repository deploys journeyapps/powersync-service:latest. The insert-only bucket_data writes, the MOVE-with-data-NULL rewrite done only by the compact command, and the absence of automatic Postgres-storage compaction were read from 1.26.0 source only (check-2.log to check-5.log). The deployed version may differ.
- No PowerSync service or Postgres can run in the sandbox, so neither the stored bucket_data row nor its re-delivery to a fresh client was observed end to end.
- How long the old row image also survives in source-Postgres WAL, the replication slot, or storage backups depends on deployment settings that are not in source.

**Local check:** With dummy data only, start the compose stack on the pinned PowerSync image version. Create a guest link and a saved snippet whose ciphertext contains a recognisable placeholder. Reveal the link and delete the snippet. Then, in the bucket storage database, run SELECT op, data FROM bucket_data WHERE row_id IN ('<link-id>','<snippet-id>') and record whether a PUT row still has the placeholder in data. Connect a freshly paired dummy device and record whether the sync stream delivers that PUT. Run 'compact' with the same service config and repeat both checks; the rows should become MOVE with data NULL.

**Owner check:** The owner checks which PowerSync service version the running :latest container reports and whether any compact job is scheduled. For one known burned item id, the owner checks the sync storage database (and its backups) for a bucket_data PUT row with that row_id whose data is not null.

## Web app shell is served without frame-ancestors or X-Frame-Options while exposing click-only device unpair and delete actions

Fingerprint: `server/src/server.js:response-headers:app-shell-framable`

The server sends no Content-Security-Policy frame-ancestors or X-Frame-Options header on any response, including the web app shell, and nothing in the app or the pinned Native Shell (NSH) web runtime prevents framing. The NSH runtime actively supports being embedded: it renders DOM elements (buttons, not a canvas-only surface) and switches to an 'nsh-embedded' mode when window.top !== window (nsh.js:814 in the pinned nsh checkout). The CSP meta tag the nsh build emits only sets connect-src (nsh-cli/src/web.rs:1120), and frame-ancestors is ignored in meta tags anyway. A paired browser session can unpair any device with two presses (Unpair, then 'Unpair device') and delete an item with one press, so a page that frames the app with the victim's session could try to trick the victim into those clicks (clickjacking). Current Chrome, Firefox and Safari partition IndexedDB for cross-site frames, so a framed copy on an unrelated site gets an empty, unpaired storage and has nothing to act on; the app never calls the Storage Access API. The attack remains possible only for a same-site embedder (an attacker-controlled sibling subdomain under the same registrable domain) or a browser without storage partitioning. Worst outcome: a victim unknowingly revokes one of their own devices or deletes an item (recoverable by re-pairing; no plaintext or key disclosure). Whether that situation exists depends on deployment and browser, so this is not asserted as a vulnerability.

**Claimed root cause:** The global response headers (server/src/server.js:151-153) and the static file responder (server/src/web.js:58-65) set no framing restriction for the HTML shell that hosts state-changing, bearer-authenticated UI actions.

**Source trace**

- entrypoint: `server/src/server.js:151` (request handler). Every response, including GET / for the app shell, gets only Cache-Control, X-Content-Type-Options and Referrer-Policy; no frame-ancestors or X-Frame-Options.
- propagation: `server/src/web.js:58` (webFiles responder). index.html is served with Content-Type, Content-Length, Vary, encoding and cache headers only (lines 58-65), so any origin may embed it in a frame.
- propagation: `app/web/src/vault.ts:11` (load). The web client restores the device session (token and keys) from the origin's IndexedDB on load, if the browser gives the framed document first-party storage (same-site frame or no storage partitioning).
- propagation: `app/ui/pairing.tsx:126` (Devices panel). After pressing Unpair (line 88), one press on 'Unpair device' dispatches unpairDevice with no typed confirmation; app/ui/workspace.tsx:106 exposes a one-press Delete.
- sink: `server/src/server.js:320` (DELETE /api/devices/:id). The dispatched action sends the bearer-authenticated DELETE (app/src/controller.rs:276-285), which sets revoked_at for the chosen device.

**Evidence**

- `server/src/server.js:151`: The only security headers set are Cache-Control, X-Content-Type-Options and Referrer-Policy (lines 151-153); no framing header anywhere in server/src.
- `server/src/web.js:58`: Static responder adds no framing header to index.html.
- `app/ui/pairing.tsx:126`: Destructive 'Unpair device' action is a plain press after one earlier press (line 88).
- `app/ui/workspace.tsx:106`: Item Delete is a single press dispatching burn.
- `app/web/src/vault.ts:4`: Session material lives in IndexedDB database 'powerbin-device'; whether a framed document can read it is decided by browser storage partitioning.

**Blockers**

- Whether a framed PowerBin document gets the victim's first-party IndexedDB session depends on browser policy outside the repository: current Chrome, Firefox and Safari partition storage for cross-site frames (which blocks the attack), while same-site frames and browsers without partitioning do not. No browser is available in the sandbox to observe this.
- Whether any attacker-controlled host shares the PowerBin deployment's registrable domain (the only case that defeats partitioning in current browsers) is a deployment fact not visible in source.
- Whether the deployed reverse proxy or hosting edge adds a framing header is a deployment fact not visible in source.

**Local check:** With dummy devices on a local test stack, serve the packaged web build through WEB_DIST at app.powerbin.test, pair two dummy devices in a current browser, then load the app in an iframe from (a) evil.example.test (cross-site) and (b) evil.powerbin.test (same-site). In each case record whether the framed Devices panel shows the paired session and whether pressing Unpair then 'Unpair device' inside the frame produces DELETE /api/devices/:id. Expected: (a) shows an unpaired app; (b) shows the session and the DELETE succeeds. Adding 'Content-Security-Policy: frame-ancestors 'none'' and 'X-Frame-Options: DENY' to responses in server.js should make both frames fail to render.

**Owner check:** The owner checks the response headers of the public app origin (in their own browser's developer tools) for Content-Security-Policy frame-ancestors or X-Frame-Options, and confirms whether any host they do not control shares the app's registrable domain (for example a shared PaaS domain not on the Public Suffix List).
