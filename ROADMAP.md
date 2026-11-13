# Multi-tenant PowerBin roadmap

Status: agreed design; implementation pending.
Agreed on: 12 November 2026.

## Goal

Anyone can deploy their own PowerBin instance on Railway and invite friends and
family to use it. One deployment hosts multiple private tenants. Each tenant is
one person's trusted device group, with its own encryption key, device directory,
saved snippets, and transfers.

The existing four-service stack remains the foundation: application Postgres,
PowerSync storage Postgres, PowerSync, and the PowerBin API/web service. The main
work is enforcing ownership consistently across database constraints, API access,
sync, and device lifecycle operations.

## Agreed scope

- Each person gets a private tenant. Pairing adds that person's own devices to
  their existing tenant; inviting a new person creates a separate tenant.
- Preserve end-to-end encryption. The server receives encrypted content, not
  plaintext or unwrapped content keys. Browser users continue to trust the
  JavaScript/WASM served by their chosen instance.
- One native app build can connect to any compatible instance by URL, without
  rebuilding for that deployment.
- Only the deployment owner can issue expiring, single-use invitations.
- Access remains device-based, without email/password login or recovery. Losing
  every device key loses access to the tenant's encrypted saved snippets.
- Direct Send is strictly within the tenant. Existing one-use guest links remain
  the only sharing mechanism between people, including across deployments.
- Keep one remembered identity per native app and per browser origin. Joining
  another identity requires the explicit forget/sign-out flow.
- Owner administration uses a small CLI authenticated with a deployment-held
  admin secret. Ordinary paired-device credentials confer no operator authority.
- Target fresh installations. There are no production users to migrate, and
  automatic conversion of existing demo databases is outside this release.
- Device removal stops future server access. It does not rotate encryption keys
  or retract downloaded content. A removed device retains its keys and could
  decrypt later ciphertext if obtained elsewhere.
- Suspension is reversible and blocks tenant API access, sync, pairing, and guest
  link availability/reveal. It preserves server data and pending local writes.
  Re-enabling restores enrolled, non-revoked devices and still-valid links;
  consumed or expired links remain unavailable.
- Forgetting a device clears its local credentials and cached data. Pending
  uploads must finish or be explicitly discarded. Forgetting the last device
  requires a clear data-loss confirmation.
- Online forgetting attempts to revoke the device's server credential after
  pending uploads finish or are explicitly discarded. If revocation is unavailable,
  refused, or unconfirmed, local-only erasure requires an explicit choice and a
  statement that remote revocation has not been confirmed.
- Retain existing message/request limits. Per-tenant storage quotas and billing
  are outside this version; total stored data per tenant remains uncapped.

## User flows

### Deploy and invite

1. The owner deploys a fresh Railway instance with generated, instance-specific
   secrets and persistent storage.
2. The owner uses the admin CLI to create an invitation, including for their own
   first tenant. The CLI also supports revoking invitations, listing the metadata
   needed for administration, and suspending/re-enabling tenants.
3. The recipient opens the invitation in the instance's browser app or pastes the
   same URL into native setup. Opening the page alone does not consume the invite.
4. On explicit enrollment, the first device generates and persists its own
   identity and independent tenant encryption key. The server atomically redeems
   the invitation and creates the tenant and first device.
5. If the successful response is lost, retrying with that saved identity recovers
   the result without creating another tenant or allowing another device to reuse
   the invitation.

### Add devices and share

1. Additional devices join through the existing verified pairing flow, scoped to
   the approver's tenant.
2. Direct transfers target only devices in that tenant. Saved snippets synchronize
   only across that tenant's devices.
3. Sharing with another person uses an existing one-use guest link. No cross-tenant
   device directory, direct delivery, or recipient inbox is introduced.
4. An invitation redeemed in the browser cannot be redeemed again in native setup;
   the native app subsequently pairs with that browser device.

### Suspend or forget

- Suspension pauses server access, including guest links, without discarding
  pending writes. Re-enabling lets pending writes resume. Link expiry continues
  during suspension, and suspension denial does not consume a link.
- Forgetting stops active work and erases the active local identity and database.
  The user either finishes pending uploads or explicitly discards them first.
  Discarding a queued send or burn does not apply that operation on the server.
- Online forgetting attempts self-revocation before erasing credentials. A refused
  or unconfirmed request, including while suspended, uses the same explicit
  local-only wipe path as offline forgetting. Another paired device can remove
  that server entry later when tenant access is available.
- A remembered identity must not be overwritten, or an invitation consumed, merely
  because a paired user opens a new invitation.

## Implementation sequence

### 1. Explicit ownership and fresh-install schema

- [ ] Add tenants with suspension state and invitations with hashed tokens,
  expiry, revocation, and redemption binding.
- [ ] Add required tenant ownership to devices and items. Bind pairing sessions
  to the approver's tenant when claimed.
- [ ] Use database constraints, including composite foreign keys where needed,
  to enforce that an item's sender and recipient belong to its tenant.
- [ ] Update fresh-install SQL, database image inputs, application-role grants,
  publication, and replication-role access. Tenant state must be replicated so
  existing sync sessions can respond to suspension.

### 2. API and sync isolation

- [ ] Derive tenant ownership and status from authenticated server records; never
  trust a client-supplied tenant ID.
- [ ] Scope session issuance, directories, item creation/retries/burns, device
  rename/revoke, and pairing lookup/transcripts/approval to the tenant.
- [ ] Reject cross-tenant direct transfers even when the caller knows valid
  foreign device or item IDs.
- [ ] Replace installation-wide saved-item and device-directory sync queries with
  active-device, tenant-scoped queries that consult live suspension state.
- [ ] Gate guest availability and atomic reveal by the owning tenant's status.
  Serialize suspension and competing writes/reveals consistently.
- [ ] Align native and browser upload error handling: suspension and transient
  failures preserve queued work; only committed uploads and acknowledged
  permanent validation rejections complete it.
- [ ] Ship schema, API authorization, and sync configuration together so a partial
  rollout cannot leave installation-wide reads enabled.

### 3. Administration and invitation enrollment

- [ ] Implement admin-secret authentication separately from device access.
- [ ] Add CLI commands to create/revoke invitations and suspend/re-enable tenants.
- [ ] Atomically redeem each invitation into exactly one tenant and first device.
- [ ] Preserve the existing pattern of saving generated keys before enrollment,
  with safe same-device retries after a lost HTTP response.
- [ ] Keep first-person enrollment distinct from pairing another personal device.

### 4. Universal client and device lifecycle

- [ ] Support invitation links in the browser and pasting them into native setup,
  without OS deep-link registration. Parse the instance origin separately from
  the invitation token and consume only on explicit enrollment.
- [ ] Discover public API/web/sync information at runtime as appropriate. Generate
  guest links for the selected instance rather than a build-time web origin.
- [ ] Report incompatible instance/app versions clearly; backward compatibility
  with pre-tenancy demo servers is not a release requirement.
- [ ] Implement upload drain or explicit discard, online self-revocation, explicit
  local-only forgetting when revocation cannot be confirmed, and last-device
  confirmation.
- [ ] Stop tasks, watches, connections, and workers before clearing the active
  credential and local database/cache. Reset the runtime before another identity
  is enrolled, with no prior tenant data remaining visible.

### 5. Verification and Railway packaging

- [ ] Extend database-backed API tests and real PowerSync/client tests. API tests
  that merely verify JWTs cannot establish sync read isolation.
- [ ] Update the disposable four-service smoke check for multiple tenants,
  invitation enrollment, suspension, and runtime URL discovery.
- [ ] Use a tested PowerSync runtime version for release packaging and update the
  Railway template/configuration and fresh-install instructions.
- [ ] Verify a fresh hosted Railway instance, including instance URLs, private
  networking, persistent signing keys, and browser/native enrollment.

## Acceptance criteria

The central invariant is: **tenant A cannot read, send to, rename, revoke, or burn
anything belonging to tenant B, even when given B's IDs.** Guest links are the
deliberate, narrowly scoped sharing exception.

- **Isolation:** two tenants with two real sync clients each see only their own
  device directory, saved items, and relevant transfers. Forged tenant/sender IDs,
  foreign recipients, item-ID retries, management requests, and pairing transcript
  access cannot expose foreign metadata or mutate foreign state. Database
  constraints independently reject cross-tenant sender/recipient relationships.
- **Invitations:** expired, revoked, and spent invitations fail. Concurrent
  redemption creates exactly one tenant/device. A lost successful response is
  recoverable using the same saved identity; another identity cannot reuse it.
  Device credentials cannot perform operator administration.
- **Suspension:** suspend a client with an open sync session and a valid issued
  JWT. API access, pairing, guest-link access, and subsequent sync delivery stop.
  Pending local writes survive disconnection and restart, then resume on
  re-enabling. Revoked devices and consumed/expired links do not revive.
- **Guest links:** outsiders can reveal only link-kind items, once. Saved or
  transfer IDs do not work. Concurrent reveal remains atomic, suspension denial
  does not consume the link, and expiry still applies during suspension.
- **Forgetting:** uploads finish before successful online self-revocation, or the
  user explicitly discards pending changes. Local-only erasure works after an
  offline, refused, or unconfirmed revocation without promising remote revocation.
  Last-device and unsynced-data warnings remain
  accurate, including concurrent device removal. Relaunching or enrolling another
  identity exposes no prior active credentials or cached rows.
- **Portability:** the same native build enrolls against separate compatible
  deployments without rebuilding, and generated guest links use the chosen
  deployment's public web URL.

## Explicit exclusions

Recovery codes or key escrow; email/password login; cross-tenant direct sending;
contacts, shared household vaults, or recipient inboxes; multiple remembered
accounts; automatic migration of existing demo databases; encryption key rotation;
permanent tenant deletion or self-delete; an admin dashboard; per-tenant storage
quotas and billing; OS deep-link integration; and multi-region or horizontal
scaling work.

This roadmap records the agreed tenancy work. It does not change the encryption
protocol or include implementation and deployment work by itself.
