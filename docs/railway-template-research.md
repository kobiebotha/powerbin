# Publishing a PowerBin Railway template

Research checked 2026-11-11 against Railway and PowerSync primary sources. This
note describes a proposed workflow; no Railway project, template, or marketplace
listing was created or changed.

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

## Deriving the template and publishing it

Railway documents creating a template from scratch or generating one from an
existing project. I found no documented marketplace-template inheritance or
`extends` relationship that keeps a derived service graph synchronized with the
PowerSync template. Treat derivation as a copied, independently maintained stack;
this is an inference from the documented creation model, rather than a claimed
explicit prohibition. The supported route is to deploy/configure a project and
generate a template from it. [Create a template](https://docs.railway.com/templates/create)

1. Make the release sources available on GitHub, or publish versioned container
   images. Configure an isolated Railway project with the four services and
   validate it with fresh databases and volumes.
2. In project **Settings → Generate Template from Project → Create Template**,
   generate the draft and review its sources, variables, domains, volumes, start
   commands, and healthchecks in the composer. Alternatively create a new draft
   directly in workspace **Templates**. GitHub branches can be selected using
   their full `/tree/branch` URLs. [Creation workflow](https://docs.railway.com/templates/create)
3. Replace copied credentials and deployment-specific values before sharing:
   use `${{secret(48)}}` for generated passwords/tokens and reference the owning
   service's value elsewhere. Reference syntax is `${{SERVICE_NAME.VAR}}`;
   Railway-provided variables can be referenced too. Give inputs helpful
   descriptions. [Variable functions](https://docs.railway.com/templates/create#template-variable-functions),
   [reference variables](https://docs.railway.com/variables),
   [template best practices](https://docs.railway.com/templates/best-practices)
4. Test the draft URL by deploying a second, completely fresh project. Verify
   generated credentials, initial schema/publication, bootstrap/pairing,
   replication, public URLs, and signing-key persistence across a redeploy.
5. Publish the reviewed draft in workspace **Templates → Publish**, with the
   overview, dependencies, setup instructions, and optional demo project. Draft
   creation gives a shareable URL; marketplace publication is a separate action.
   [Publish and share](https://docs.railway.com/templates/publish-and-share)

The current CLI also supports `railway templates create --project <project>`
to create an unpublished draft, and `railway templates publish <id>` to publish.
`railway templates update <id>` updates marketplace metadata on an existing
listing; it is not documented as replacing its service graph from a new project.
Use the template editor for infrastructure changes. Keep the original PowerSync
listing intact and publish PowerBin as a distinct product.
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
