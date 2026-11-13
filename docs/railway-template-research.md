# Publishing a PowerBin Railway template

Research checked 2026-11-11 against Railway and PowerSync primary sources, with
the GHCR draft update verified on 2026-11-13. This
note describes the authoring workflow and its current state. The four-service
configuration has been applied to the original unpublished PowerBin draft and
confirmed by final API read-back. No running Railway deployment or marketplace
publication has been requested.

## Recommendation

Publish a separate **PowerBin** template using the PowerSync starter's architecture
as a reference. Keep the four services already described in
[the deployment preparation](../railway/README.md): application Postgres,
PowerSync bucket-storage Postgres, PowerSync, and the PowerBin relay/web app.
Replace the starter's todo backend and schema scripts with PowerBin's backend
and schema initialization. Omit diagnostics from the initial listing, or document
it as an optional addition.

The official [PowerSync Starter (Postgres)](https://railway.com/deploy/powersync-starter-postgres)
currently contains six services: `postgres`, `bucket`, `service` (PowerSync),
`backend`, `sync-diagnostics-client`, and `scripts`. Its databases use
`ghcr.io/railwayapp-templates/postgres-ssl:17`; PowerSync and diagnostics use
JourneyApps images. PowerSync's [integration guide](https://docs.powersync.com/maintenance-ops/self-hosting/railway)
explicitly presents it as a configurable starting point, and explains that its
demo backend is unsecured and its scripts create `lists`, `todos`, and the
publication. Those demo components should not be carried into PowerBin unchanged.

## Direct API authoring

Railway documents creating a template from scratch or generating one from an
existing project. I found no documented marketplace-template inheritance or
`extends` relationship that keeps a derived service graph synchronized with the
PowerSync template. Treat derivation as a copied, independently maintained stack;
this is an inference from the documented creation model, rather than a claimed
explicit prohibition. [Create a template](https://docs.railway.com/templates/create)

The PowerSync starter's complete `serializedConfig` was read through the live
public GraphQL API. Its actual service, variable, networking, and volume format
is the basis for [railway/template.json](../railway/template.json). The existing
PowerBin draft supplied by the operator has ID
`a22b8e33-dd36-455d-9887-1e93d2168810`.

Live mutation introspection and the
[official CLI schema](https://raw.githubusercontent.com/railwayapp/cli/master/src/gql/schema.json)
expose template reading, cloning, generation, publication, and limited volume-size
editing, but omit the app's direct template-authoring mutations. The current
Railway app uses `https://backboard.railway.com/graphql/internal` with
`templateChangeSetStage(templateId, patch, merge)`, `templateChangeSets`, and
`templateChangeSetApply(changeSetId)`. Its patch contains `config` and optional
`metadata`; service variables retain template `defaultValue` fields. This route
is visible in the official
[template editor asset](https://railway.com/assets/useTemplateEditor-OEqlO1md.js)
and [shared app asset](https://railway.com/assets/modal-D5tuZPNc.js), but is
undocumented and may change.

The [API helper](../railway/template-api.mjs) now edits the specified unpublished
draft directly. `plan` inspects the local configuration; `apply --template ID`
stages `{config: ...}`, checks the staged `draftView`, applies that change set,
and compares the template's final `serializedConfig` with the authored file. It
uses the existing workspace token from `RAILWAY_API_TOKEN` and records progress
under ignored `.tools/`. No Railway UI or browser was used.

Each independently derived template needs unique service and volume IDs.
Reusing the starter's IDs caused collisions in this authoring flow; PowerBin
now has its own canonical IDs in the local configuration and remote draft.

The initial configuration targeted the repository's `init` branch for three
services. On 13 November 2026 the unpublished draft was updated to the three
GHCR image sources and current PowerBin database/role defaults in
[railway/template.json](../railway/template.json), with final API read-back.
The PowerSync Dockerfile uses
`journeyapps/powersync-service:latest`. Template passwords and tokens use literal
`${{secret(48)}}` defaults and service references, rather than exported deployment
credentials. [Variable functions](https://docs.railway.com/templates/create#template-variable-functions),
[reference variables](https://docs.railway.com/variables)

The GHCR change set on the original PowerBin draft is `APPLIED`. Final read-back
confirmed all four services, image sources, literal and generated variable
defaults, service references, healthchecks, public-domain settings, and volumes
against the authored configuration. Obsolete repository sources and variables
were explicitly cleared with null deletion markers. The PowerSync starter remains unchanged.
Applying template changes is separate from marketplace publication and deploying
the stack.
[Publish and share](https://docs.railway.com/templates/publish-and-share)

## Superseded resources

The earlier project-export route created a separate configuration-only project,
[`8f5b7f87-5f5d-4d1e-88e0-6038a724b7ea`](https://railway.com/project/8f5b7f87-5f5d-4d1e-88e0-6038a724b7ea).
It has four configured services, no deployments, and no repository deployment
triggers. Its generated draft `7eec8e95-dc52-49b8-a8ed-26d542bb012a` (code `t_GPKU`)
is unpublished and lacks required literal defaults and the intended branch;
do not use it. These resources are retained pending cleanup; no deletion was
requested. The original PowerSync starter remains unchanged.

The documented CLI `templates create --project` exports a new draft, while
`templates update` changes marketplace metadata; neither repairs that export's
service graph. The direct authoring route above supersedes this workaround.
[CLI template commands](https://docs.railway.com/cli/templates)

## Runtime details that matter

Generate public HTTPS domains for PowerBin and PowerSync; browser/native clients
need these public URLs. Use private service hostnames for Postgres and internal
JWKS requests, within the same project environment. The composer supports
networking, healthchecks, root/start configuration, and volume attachment.
Private networking is automatically isolated per environment.
[Public networking](https://docs.railway.com/networking/public-networking),
[private networking](https://docs.railway.com/networking/private-networking)

Persist both databases and PowerBin's `/data` signing key with explicit volume
mounts. Volumes expose persistent directories to the running service. Migrations
can use a pre-deploy command, which has variables and private-network access,
but runs in a separate container without mounted volumes or persistent filesystem
changes. Generate the signing key during application startup, where `/data` is
mounted. [Volumes](https://docs.railway.com/volumes),
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)

Railway infers startup dependencies from reference variables for batched template
deploys. It does not apply that ordering to independent GitHub push deployments
or single-service redeploys; circular references deploy in parallel. PowerBin's
prepared `POWERSYNC_URL` reference and PowerSync's JWKS reference form such a
cycle. Application startup must tolerate dependency unavailability and recover;
canvas connections alone are insufficient proof of successful bootstrap.
[Deployment dependencies](https://docs.railway.com/deployments/deployment-actions#deployment-dependencies---startup-ordering)

## GitHub sources or prebuilt images

Both are supported. A public GitHub source makes customization/ejection and
Railway's opt-in source-update notifications straightforward. Docker image
sources skip Railway's build step; the GitHub-template update mechanism does
not cover them. A versioned, tested Linux amd64 image is therefore an attractive
launch option for PowerBin's heavier Rust/NSH/WASM build, while retaining public
source and an explicit image-upgrade policy. It is an option, not a prerequisite.
[Deployment behavior](https://docs.railway.com/deployments/reference),
[template updates](https://docs.railway.com/templates/updates)

Railway currently lists service build timeouts of 20 minutes during trial,
10 minutes on Free afterward, 40 minutes on Hobby, and 90 minutes on Pro.
Measure a cold build against the intended tier before choosing GitHub builds
for the public template. The current build documentation does not establish a
fixed builder CPU/RAM guarantee, so runtime service resource limits should not
be presented as compiler resources. [Plan comparison](https://railway.com/pricing),
[build configuration](https://docs.railway.com/builds/build-configuration)

Template infrastructure edits and source-code updates are separate maintenance
paths. Railway's August 2026 editor adds staged template changes and activity
history/reverts. Source updates from GitHub notify existing consumers and are
opt-in; the documentation does not promise automatic propagation of later
template service-graph edits to already deployed projects.
[Editor update](https://railway.com/changelog/2026-08-14-access-groups),
[source updates](https://docs.railway.com/templates/updates)
