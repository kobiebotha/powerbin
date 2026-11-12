#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../', import.meta.url);
const configPath = new URL('template.json', import.meta.url);
const statePath = new URL('.tools/railway-template-api-state.json', root);
const exportPath = new URL('.tools/railway-template-export.json', root);
const endpoint = 'https://backboard.railway.com/graphql/v2';
const sourceCode = 'powersync-starter-postgres';
const [command = 'plan', ...args] = process.argv.slice(2);
const workspaceIndex = args.indexOf('--workspace');
const workspaceId = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
if (!['plan', 'generate'].includes(command) ||
    (args.length && (args.length !== 2 || workspaceIndex !== 0 || !workspaceId))) {
  console.error('Usage: node railway/template-api.mjs plan | generate --workspace WORKSPACE_ID');
  process.exit(2);
}

const configText = await readFile(configPath, 'utf8');
const config = JSON.parse(configText);
const services = Object.values(config.services || {});
const digest = createHash('sha256').update(configText).digest('hex');
if (services.length !== 4 || services.some(service => !service.name)) {
  throw new Error('Expected the four named PowerBin services in railway/template.json');
}

if (command === 'plan') {
  console.log('Creates a new, unpublished PowerBin draft through a configuration-only project.');
  console.log('The existing PowerBin draft is not changed. Deployments remain disabled.');
  for (const service of services) {
    console.log(`${service.name}: ${service.source.repo || service.source.image}; ${Object.keys(service.variables || {}).length} variables`);
  }
  console.log('Generate: node railway/template-api.mjs generate --workspace WORKSPACE_ID');
  process.exit(0);
}

let localEnv = {};
try { localEnv = parseEnv(await readFile(new URL('.env', root), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = process.env.RAILWAY_API_TOKEN || localEnv.RAILWAY_API_TOKEN;
if (!workspaceId || !token) {
  console.error('Generation requires --workspace and RAILWAY_API_TOKEN in the environment or ignored root .env.');
  process.exit(1);
}

const redact = value => String(value).replaceAll(token, '[redacted]');
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (state && (state.workspaceId !== workspaceId || state.digest !== digest)) {
  throw new Error('Saved API state belongs to a different workspace or configuration. Inspect it before starting another run.');
}
state ||= { workspaceId, digest, variablesRestored: [] };
if (state.pending) {
  throw new Error(`The previous ${state.pending} operation did not return a saved result. Inspect the configuration project before retrying; mutations are not automatically repeated.`);
}

async function save() {
  await mkdir(new URL('.tools/', root), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function graphql(query, variables = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`Railway API returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}
async function mutate(label, query, variables, record) {
  state.pending = label;
  await save();
  const result = await graphql(query, variables);
  try { record(result); }
  catch (error) { await save(); throw error; }
  delete state.pending;
  await save();
}
async function waitFor(label, read) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${label}. Progress is saved; no mutation was repeated.`);
}

try {
  const identity = await graphql(`query Workspace($id: String!) {
    workspace(workspaceId: $id) { id name }
  }`, { id: workspaceId });
  console.log(`Workspace: ${identity.workspace.name}`);

  if (!state.projectId) {
    await mutate('project creation', `mutation Create($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id environments { edges { node { id name } } } }
    }`, { input: {
      name: 'PowerBin', description: 'Configuration-only project for generating the PowerBin template; deployments intentionally disabled.',
      defaultEnvironmentName: 'template', isPublic: false, prDeploys: false, workspaceId
    } }, result => {
      const project = result.projectCreate;
      state.projectId = project.id;
      state.environmentId = project.environments.edges.find(edge => edge.node.name === 'template')?.node.id;
      if (!state.environmentId) throw new Error('The configuration project did not return its template environment.');
    });
  }
  console.log(`Configuration project: https://railway.com/project/${state.projectId}`);

  // Retry a completed failure only if it left no services or pending changes.
  if (state.stagingWorkflowId && !state.stagingComplete) {
    const previous = await graphql(`query Workflow($id: String!) {
      workflowStatus(workflowId: $id) { status error }
    }`, { id: state.stagingWorkflowId });
    if (previous.workflowStatus.status === 'Error') {
      const project = await graphql(`query RetryState($projectId: String!, $environmentId: String!) {
        project(id: $projectId) { services { edges { node { id } } } }
        environmentPatches(environmentId: $environmentId, first: 20) { edges { node { status } } }
      }`, { projectId: state.projectId, environmentId: state.environmentId });
      if (project.project.services.edges.length || project.environmentPatches.edges.some(edge => edge.node.status !== 'COMMITTED')) {
        throw new Error('The failed staging workflow left resources or pending changes. Inspect them before retrying.');
      }
      state.staged = false;
      delete state.stagingWorkflowId;
      await save();
      console.log('The previous staging workflow failed without creating services; retrying in the same configuration project.');
    }
  }
  if (!state.staged) {
    const source = await graphql(`query Source($code: String!) { template(code: $code) { id } }`, { code: sourceCode });
    const inputConfig = structuredClone(config);
    for (const service of Object.values(inputConfig.services)) {
      for (const variable of Object.values(service.variables || {})) {
        if (variable?.defaultValue != null) variable.value = variable.defaultValue;
      }
    }
    await mutate('staging the four services', `mutation Stage($input: TemplateDeployV2Input!) {
      templateDeployV2(input: $input) { projectId workflowId }
    }`, { input: {
      projectId: state.projectId, environmentId: state.environmentId, workspaceId,
      templateId: source.template.id, serializedConfig: inputConfig, stageOnly: true
    } }, result => {
      const staged = result.templateDeployV2;
      state.stagingWorkflowId = staged.workflowId;
      if (staged.projectId !== state.projectId) throw new Error('Railway staged the template in an unexpected project; inspect the returned workflow before continuing.');
      state.staged = true;
    });
  }
  if (state.stagingWorkflowId && !state.stagingComplete) {
    await waitFor('the template staging workflow', async () => {
      const result = await graphql(`query Workflow($id: String!) {
        workflowStatus(workflowId: $id) { status error }
      }`, { id: state.stagingWorkflowId });
      if (result.workflowStatus.status === 'Error') {
        await writeFile(new URL('.tools/railway-template-workflow-error.json', root), JSON.stringify(result.workflowStatus, null, 2) + '\n', { mode: 0o600 });
        throw new Error('Railway template staging failed. Diagnostics were saved to ignored .tools/railway-template-workflow-error.json.');
      }
      return result.workflowStatus.status === 'Complete';
    });
    state.stagingComplete = true;
    await save();
  }

  if (!state.patchId) {
    const patch = await waitFor('the staged configuration', async () => {
      const result = await graphql(`query Patches($id: String!) {
        environmentPatches(environmentId: $id, first: 20) { edges { node { id status } } }
      }`, { id: state.environmentId });
      const staged = result.environmentPatches.edges.filter(edge => edge.node.status === 'STAGED');
      if (staged.length > 1) throw new Error('Unexpected multiple staged patches in the configuration project.');
      return staged[0]?.node;
    });
    state.patchId = patch.id;
    await save();
  }
  if (!state.commitRequested) {
    await mutate('committing configuration without deployments', `mutation Commit($environmentId: String!) {
      environmentPatchCommitStaged(environmentId: $environmentId, skipDeploys: true,
        commitMessage: "Prepare PowerBin template without deploying")
    }`, { environmentId: state.environmentId }, () => { state.commitRequested = true; });
  }
  if (!state.committed) {
    await waitFor('the configuration commit', async () => {
      const result = await graphql(`query Patch($id: String!) {
        environmentPatch(id: $id) { status lastAppliedError }
      }`, { id: state.patchId });
      if (result.environmentPatch.lastAppliedError) throw new Error('Railway could not apply the configuration patch. Inspect the configuration project before continuing.');
      return result.environmentPatch.status === 'COMMITTED';
    });
    state.committed = true;
    await save();
  }

  // Template staging resolves secret() calls. Restore their authored expressions
  // in the configuration-only project's raw variables before exporting it.
  const projectResult = await graphql(`query Services($id: String!) {
    project(id: $id) { services { edges { node { id name } } } }
  }`, { id: state.projectId });
  const actualServices = projectResult.project.services.edges.map(edge => edge.node);
  if (actualServices.length !== services.length) throw new Error('Unexpected services in the configuration-only project.');
  for (const service of services) {
    if (state.variablesRestored.includes(service.name)) continue;
    const matches = actualServices.filter(actual => actual.name === service.name);
    if (matches.length !== 1) throw new Error(`Cannot uniquely identify ${service.name} in the configuration project.`);
    const variables = Object.fromEntries(Object.entries(service.variables || {}).map(([name, variable]) => [name, variable.defaultValue]));
    await mutate(`restoring ${service.name} template expressions`, `mutation Variables($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`, { input: {
      projectId: state.projectId, environmentId: state.environmentId,
      serviceId: matches[0].id, variables, replace: true, skipDeploys: true
    } }, () => { state.variablesRestored.push(service.name); });
  }

  if (!state.templateId) {
    await mutate('generating the replacement draft', `mutation Generate($input: TemplateGenerateInput!) {
      templateGenerate(input: $input) { id code status }
    }`, { input: { projectId: state.projectId, environmentId: state.environmentId } }, result => {
      state.templateId = result.templateGenerate.id;
      state.templateCode = result.templateGenerate.code;
    });
  }

  const result = await graphql(`query Draft($id: String!) {
    template(id: $id) { id name status serializedConfig }
  }`, { id: state.templateId });
  const draft = result.template;
  const exported = typeof draft.serializedConfig === 'string' ? JSON.parse(draft.serializedConfig) : draft.serializedConfig;
  await writeFile(exportPath, JSON.stringify(exported, null, 2) + '\n', { mode: 0o600 });
  if (draft.status !== 'UNPUBLISHED') throw new Error(`Unexpected template status ${draft.status}; this script requires an unpublished draft.`);
  const exportedServices = Object.values(exported?.services || {});
  if (exportedServices.length !== services.length) throw new Error('The generated draft has an unexpected service count.');
  for (const service of services) {
    const target = exportedServices.find(actual => actual.name === service.name);
    if (!target) throw new Error(`The generated draft is missing ${service.name}.`);
    for (const [name, variable] of Object.entries(service.variables || {})) {
      if (target.variables?.[name]?.defaultValue !== variable.defaultValue) {
        throw new Error(`Export changed ${service.name}.${name}; the unpublished draft needs correction before use. No values were printed.`);
      }
    }
  }
  state.verified = true;
  await save();
  console.log(`Unpublished draft: https://railway.com/workspace/templates/${draft.id}/settings`);
  console.log('All four services and authored variable defaults survived export. No deployment or publication was requested.');
  console.log('Configuration project and draft are retained; state is saved under ignored .tools/.');
} catch (error) {
  console.error(redact(error.message));
  if (state.templateId) console.error(`Unpublished draft retained for inspection: ${state.templateId}`);
  if (state.projectId) console.error(`Configuration project retained: ${state.projectId}`);
  process.exitCode = 1;
}
