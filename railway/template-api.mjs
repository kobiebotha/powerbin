#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv, isDeepStrictEqual } from 'node:util';

const root = new URL('../', import.meta.url);
const statePath = new URL('.tools/railway-template-authoring-state.json', root);
const exportPath = new URL('.tools/railway-template-authoring-export.json', root);
// Railway's editor uses this endpoint. The public /graphql/v2 schema omits
// template change sets. This is an undocumented API and may change.
const endpoint = 'https://backboard.railway.com/graphql/internal';
const [command = 'plan', ...args] = process.argv.slice(2);
const options = new Map();
let invalidOptions = args.length % 2 !== 0;
for (let i = 0; i < args.length; i += 2) {
  const [key, value] = args.slice(i, i + 2);
  if (!['--template', '--expected-config'].includes(key) || !value || value.startsWith('--') || options.has(key)) invalidOptions = true;
  options.set(key, value);
}
const templateId = options.get('--template');
const expectedConfigPath = options.get('--expected-config');
if (!['plan', 'apply'].includes(command) || invalidOptions || (command === 'plan' && args.length)) {
  console.error('Usage: node railway/template-api.mjs plan | apply --template TEMPLATE_ID [--expected-config PATH]');
  process.exit(2);
}

const configText = await readFile(new URL('template.json', import.meta.url), 'utf8');
const config = JSON.parse(configText);
const digest = createHash('sha256').update(configText).digest('hex');
const services = Object.values(config.services || {});
if (!isDeepStrictEqual(services.map(service => service.name).sort(), ['postgres', 'powerbin', 'powersync'].sort())) {
  throw new Error('Expected the postgres, powersync, and powerbin services in railway/template.json');
}
if (command === 'plan') {
  console.log('Applies the three-service shared-database configuration to an unpublished PowerBin draft matching a verified or explicit expected snapshot, or an empty draft.');
  for (const service of services) {
    console.log(`${service.name}: ${service.source.repo || service.source.image}; ${Object.keys(service.variables || {}).length} variables`);
  }
  console.log('Stages and reads back a template change set before applying it. No publication or deployment.');
  console.log('Apply: node railway/template-api.mjs apply --template TEMPLATE_ID [--expected-config PATH]');
  process.exit(0);
}

let localEnv = {};
try { localEnv = parseEnv(await readFile(new URL('.env', root), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const token = process.env.RAILWAY_API_TOKEN || localEnv.RAILWAY_API_TOKEN;
if (!templateId || !token) throw new Error('Apply requires --template and RAILWAY_API_TOKEN in the environment or ignored root .env.');
const redact = value => String(value).replaceAll(token, '[redacted]');
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (state && state.templateId !== templateId) {
  throw new Error('Saved authoring state belongs to a different template. Inspect it before continuing.');
}
if (state?.pending) throw new Error(`Previous ${state.pending} operation has an unknown outcome. Inspect the draft before retrying; mutations are not repeated automatically.`);
let previousConfig;
if (expectedConfigPath) {
  if (state && (!state.applied || !state.verified)) {
    throw new Error('Saved authoring state contains an unfinished configuration. Finish or inspect it before supplying a new expected configuration.');
  }
  // An explicit snapshot can refresh stale local history, but it must match the
  // entire remote draft before any new mutation is authorized.
  previousConfig = JSON.parse(await readFile(expectedConfigPath, 'utf8'));
} else if (state && state.digest !== digest) {
  if (!state.applied || !state.verified) {
    throw new Error('Saved authoring state contains an unfinished configuration. Inspect it before starting a revision.');
  }
  // Keep the verified state intact until the remote draft matches this snapshot.
  // A changed local template alone never authorizes overwriting remote edits.
  previousConfig = JSON.parse(await readFile(exportPath, 'utf8'));
}
if (previousConfig && (!previousConfig.services || typeof previousConfig.services !== 'object' || Array.isArray(previousConfig.services))) {
  throw new Error('The expected configuration is missing its service configuration. Inspect it before starting a revision.');
}
if ((expectedConfigPath || (state && state.digest !== digest)) && !previousConfig) throw new Error('The expected configuration is empty.');
const previousDigest = state?.digest;
state ||= { templateId, digest };

async function save() {
  await mkdir(new URL('.tools/', root), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}
async function graphql(query, variables = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`Railway authoring API returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data;
}
async function mutate(label, query, variables, record) {
  state.pending = label;
  await save();
  const result = await graphql(query, variables);
  record(result);
  delete state.pending;
  await save();
}
function decode(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
// Railway merges config patches even with merge:false (that flag replaces the
// staged patch). Omitting a field preserves it; nulls request deletion.
function mergePatch(before, after) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return after;
  const previous = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const patch = {};
  for (const key of Object.keys(previous)) {
    if (!Object.hasOwn(after, key)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(after)) {
    if (!isDeepStrictEqual(previous[key], value)) patch[key] = mergePatch(previous[key], value);
  }
  return patch;
}
function verify(actual, expected = config, path = 'config') {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) ||
        !isDeepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort())) {
      throw new Error(`Read-back has unexpected or missing fields at ${path}; no values were printed.`);
    }
    for (const [key, value] of Object.entries(expected)) verify(actual?.[key], value, `${path}.${key}`);
  } else if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Read-back differs at ${path}; no values were printed.`);
  }
}
async function readDraft() {
  const result = await graphql(`query Draft($id: String!) {
    template(id: $id) { id name status workspaceId serializedConfig }
  }`, { id: templateId });
  if (result.template.status !== 'UNPUBLISHED') throw new Error('This helper only edits unpublished drafts.');
  return { ...result.template, serializedConfig: decode(result.template.serializedConfig) };
}
async function readChangeSet(id) {
  const result = await graphql(`query ChangeSet($id: String!) {
    templateChangeSet(id: $id) { id status patch draftView lastAppliedError }
  }`, { id });
  return result.templateChangeSet;
}

try {
  const draft = await readDraft();
  if (previousConfig) {
    if (draft.name !== 'PowerBin') throw new Error('Expected the previously verified PowerBin draft.');
    verify(draft.serializedConfig, previousConfig, expectedConfigPath ? 'explicit expected configuration' : 'previous verified configuration');
    state = { templateId, digest, ...(previousDigest && { previousDigest }) };
  }
  if (!state.changeSetId) {
    if (draft.name !== 'PowerBin' || (!previousConfig && (
        Object.keys(draft.serializedConfig?.services || {}).length ||
        Object.keys(draft.serializedConfig?.buckets || {}).length))) {
      throw new Error('Expected the existing empty PowerBin draft; refusing to overwrite another configuration.');
    }
    const staged = await graphql(`query Staged($id: String!) {
      templateChangeSets(templateId: $id, first: 1) { edges { node { id status } } }
    }`, { id: templateId });
    if (staged.templateChangeSets.edges.some(({ node }) => node.status !== 'APPLIED')) {
      throw new Error('The draft has staged edits or an unknown change-set status. Inspect it before applying this configuration.');
    }
    state.workspaceId = draft.workspaceId;
    await mutate('staging template changes', `mutation Stage($id: String!, $patch: TemplatePatch!) {
      templateChangeSetStage(templateId: $id, patch: $patch, merge: false) { id status }
    }`, { id: templateId, patch: { config: mergePatch(draft.serializedConfig, config) } }, result => {
      state.changeSetId = result.templateChangeSetStage.id;
    });
  }
  if (!state.applied) {
    const changeSet = await readChangeSet(state.changeSetId);
    if (changeSet.status !== 'STAGED') throw new Error(`Unexpected change-set status ${changeSet.status}; inspect it before continuing.`);
    // Railway retains lastAppliedError after replacing a failed staged patch.
    // The exact new draftView is checked below before another apply is allowed.
    const patch = decode(changeSet.patch);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => key !== 'config')) {
      throw new Error('The staged patch changes fields outside the template configuration. Inspect it before applying.');
    }
    // The API minimizes its stored merge patch, so only the resulting full view
    // can establish that every requested addition and deletion took effect.
    const view = decode(changeSet.draftView);
    let stagedConfig = view?.config;
    if (stagedConfig?.services && typeof stagedConfig.services === 'object' && !Array.isArray(stagedConfig.services)) {
      // Railway's staged view retains deleted services as null tombstones.
      // Only those entries are omitted here; final serializedConfig is checked
      // without normalization after apply, and all nonnull services stay exact.
      stagedConfig = { ...stagedConfig, services: Object.fromEntries(Object.entries(stagedConfig.services).filter(([, service]) => service !== null)) };
    }
    verify(stagedConfig);
    await mutate('applying template changes', `mutation Apply($id: String!) {
      templateChangeSetApply(changeSetId: $id) { id status }
    }`, { id: state.changeSetId }, result => {
      state.applied = true;
      state.applyStatus = result.templateChangeSetApply.status;
    });
  }
  const applied = await readDraft();
  verify(applied.serializedConfig);
  await writeFile(exportPath, JSON.stringify(applied.serializedConfig, null, 2) + '\n', { mode: 0o600 });
  state.verified = true;
  await save();
  console.log(`Updated unpublished draft: https://railway.com/workspace/templates/${templateId}/settings`);
  console.log('Read-back matches all three services, sources, variable defaults, health checks, domains, and volumes.');
  console.log('No deployment or publication was requested.');
} catch (error) {
  console.error(redact(error.message));
  console.error(`Draft retained for inspection: ${templateId}`);
  process.exitCode = 1;
}
