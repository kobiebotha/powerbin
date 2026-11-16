import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const templateId = 'test-powerbin-draft';
const config = { services: Object.fromEntries(['postgres', 'powersync', 'powerbin'].map(name =>
  [name, { name, source: { image: `test/${name}:new` } }])) };
const previousConfig = { services: { ...config.services, bucket: { name: 'bucket', source: { image: 'postgres:18' } } } };
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const digest = value => createHash('sha256').update(serialize(value)).digest('hex');
const verifiedState = () => ({ templateId, digest: digest(previousConfig), changeSetId: 'old-change', applied: true, verified: true });

// Copied into each temporary project and loaded before the real CLI entry point.
// Replacing fetch prevents these subprocesses from accessing the network.
const mockFetch = `
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
const path = new URL('./mock-api.json', import.meta.url);
function applyMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = target && typeof target === 'object' && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyMerge(result[key], value);
  }
  return result;
}
function minimize(before, after) {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return after;
  const prior = before && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const result = Object.fromEntries(Object.keys(prior).filter(key => !Object.hasOwn(after, key)).map(key => [key, null]));
  for (const [key, value] of Object.entries(after)) {
    if (!isDeepStrictEqual(prior[key], value)) result[key] = minimize(prior[key], value);
  }
  return result;
}
globalThis.fetch = async (url, options) => {
  if (url !== 'https://backboard.railway.com/graphql/internal') throw new Error('Unexpected URL');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const {query, variables} = JSON.parse(options.body);
  const operation = query.match(/(?:query|mutation)\\s+(\\w+)/)[1];
  state.calls.push(operation);
  if (state.failBefore === operation) {
    delete state.failBefore;
    await writeFile(path, JSON.stringify(state));
    throw new Error('Interrupted read');
  }
  let data;
  if (operation === 'Draft') data = {template: {id: '${templateId}', name: 'PowerBin', status: 'UNPUBLISHED', workspaceId: 'workspace', serializedConfig: JSON.stringify(state.remote)}};
  else if (operation === 'Staged') data = {templateChangeSets: {edges: (state.changeSets || []).map(status => ({node: {id: 'existing-change', status}}))}};
  else if (operation === 'Stage') {
    state.submittedPatch = variables.patch;
    const currentView = {config: state.remote};
    const draftView = applyMerge(currentView, variables.patch);
    // Railway preserves requested service deletions as nulls in staged views.
    for (const [id, service] of Object.entries(variables.patch.config?.services || {})) {
      if (service === null) draftView.config.services[id] = null;
    }
    if (state.retainBucket) draftView.config.services.bucket = state.remote.services.bucket;
    state.staged = {id: 'new-change', status: 'STAGED', patch: minimize(currentView, draftView), draftView};
    data = {templateChangeSetStage: {id: state.staged.id, status: state.staged.status}};
  } else if (operation === 'ChangeSet') data = {templateChangeSet: state.staged};
  else if (operation === 'Apply') {
    state.remote = structuredClone(state.staged.draftView.config);
    if (!state.retainFinalTombstones) state.remote.services = Object.fromEntries(Object.entries(state.remote.services).filter(([, service]) => service !== null));
    state.staged.status = 'APPLIED';
    data = {templateChangeSetApply: {id: state.staged.id, status: state.staged.status}};
  } else throw new Error('Unexpected operation ' + operation);
  await writeFile(path, JSON.stringify(state));
  if (state.failAfter === operation) throw new Error('Lost mutation response');
  return {ok: true, json: async () => ({data})};
};
`;

async function fixture(t, { state, exported, remote = { services: {} }, ...api } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-template-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'railway'));
  await mkdir(join(directory, '.tools'));
  await copyFile(new URL('./template-api.mjs', import.meta.url), join(directory, 'railway/template-api.mjs'));
  await writeFile(join(directory, 'railway/template.json'), serialize(config));
  await writeFile(join(directory, 'mock-fetch.mjs'), mockFetch);
  await writeFile(join(directory, 'mock-api.json'), JSON.stringify({ remote, calls: [], ...api }));
  const statePath = join(directory, '.tools/railway-template-authoring-state.json');
  const exportPath = join(directory, '.tools/railway-template-authoring-export.json');
  if (state) await writeFile(statePath, serialize(state));
  if (exported) await writeFile(exportPath, serialize(exported));
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  return {
    state: () => read(statePath),
    exported: () => read(exportPath),
    api: () => read(join(directory, 'mock-api.json')),
    async expected(value) {
      const path = join(directory, 'expected-config.json');
      await writeFile(path, serialize(value));
      return ['--expected-config', path];
    },
    run: (args = []) => new Promise(resolve => {
      execFile(process.execPath, ['--import', join(directory, 'mock-fetch.mjs'), join(directory, 'railway/template-api.mjs'), 'apply', '--template', templateId, ...args],
        { cwd: directory, env: { ...process.env, RAILWAY_API_TOKEN: 'test-token-never-print' }, timeout: 10_000 },
        (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr }));
    })
  };
}

test('applies an initial empty draft and saves the verified configuration', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).calls, ['Draft', 'Staged', 'Stage', 'ChangeSet', 'Apply', 'Draft']);
  assert.deepEqual(await f.exported(), config);
  assert.equal((await f.state()).verified, true);
  assert.equal((await f.state()).digest, digest(config));
  assert.ok(!result.stdout.includes('test-token-never-print'));
});

test('revises an unchanged verified draft and permits its previous applied change set', async t => {
  const f = await fixture(t, { state: verifiedState(), exported: previousConfig, remote: previousConfig, changeSets: ['APPLIED'] });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).remote, config, 'replacement removes the extra database service');
  assert.deepEqual((await f.api()).submittedPatch, { config: { services: { bucket: null } } }, 'omitted database is explicitly deleted by the merge patch');
  assert.deepEqual((await f.api()).staged.patch, { config: { services: { bucket: null } } }, 'minimized stored patch need not contain the full desired configuration');
  assert.equal((await f.api()).staged.draftView.config.services.bucket, null, 'staged service tombstone is accepted before final exact verification');
  assert.equal((await f.state()).previousDigest, digest(previousConfig));
  assert.equal((await f.state()).verified, true);
  assert.deepEqual(await f.exported(), config);
});

test('revision merge patches explicitly delete obsolete nested configuration fields', async t => {
  const remote = structuredClone(previousConfig);
  remote.services.postgres.variables = { OBSOLETE: { defaultValue: 'old' } };
  const f = await fixture(t, { remote });
  const result = await f.run(await f.expected(remote));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).remote, config);
  assert.deepEqual((await f.api()).submittedPatch.config.services, { bucket: null, postgres: { variables: null } });
});

test('refuses to apply if the full staged view still contains the removed database', async t => {
  const f = await fixture(t, { remote: previousConfig, retainBucket: true });
  const result = await f.run(await f.expected(previousConfig));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unexpected or missing fields at config.services/);
  assert.ok(!(await f.api()).calls.includes('Apply'));
  assert.equal((await f.state()).changeSetId, 'new-change', 'known staged result remains inspectable');
  assert.ok(!(await f.state()).pending);
});

test('final verification refuses service tombstones retained in serializedConfig', async t => {
  const f = await fixture(t, { remote: previousConfig, retainFinalTombstones: true });
  const result = await f.run(await f.expected(previousConfig));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unexpected or missing fields at config.services/);
  assert.ok((await f.api()).calls.includes('Apply'));
  assert.equal((await f.state()).applied, true, 'known apply outcome is retained');
  assert.ok(!(await f.state()).verified, 'final tombstone is never silently accepted');
});

test('an explicit exact baseline permits an intentional refresh of stale verified history', async t => {
  const remote = { ...previousConfig, description: 'updated outside this checkout' };
  const f = await fixture(t, { state: verifiedState(), exported: previousConfig, remote, changeSets: ['APPLIED'] });
  const result = await f.run(await f.expected(remote));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).remote, config);
  assert.equal((await f.state()).verified, true);
});

test('an explicit exact baseline can adopt a nonempty draft without saved local state', async t => {
  const f = await fixture(t, { remote: previousConfig });
  const result = await f.run(await f.expected(previousConfig));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).remote, config);
});

test('an explicit stale baseline refuses remote drift before changing local history', async t => {
  const state = verifiedState();
  const f = await fixture(t, { state, exported: previousConfig, remote: { ...previousConfig, unexpected: true } });
  const result = await f.run(await f.expected(previousConfig));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /explicit expected configuration/);
  assert.deepEqual((await f.api()).calls, ['Draft']);
  assert.deepEqual(await f.state(), state);
});

test('an explicit baseline cannot bypass pending or unfinished mutation history', async t => {
  for (const extra of [{ pending: 'applying template changes' }, { verified: false }, { templateId: 'another-draft' }]) {
    const state = { ...verifiedState(), ...extra };
    const f = await fixture(t, { state, remote: previousConfig });
    assert.equal((await f.run(await f.expected(previousConfig))).code, 1);
    assert.deepEqual((await f.api()).calls, []);
    assert.deepEqual(await f.state(), state);
  }
});

test('refuses remote drift without replacing the prior verified state', async t => {
  const state = verifiedState();
  const f = await fixture(t, { state, exported: previousConfig, remote: { ...previousConfig, unexpected: true } });
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /previous verified configuration/);
  assert.deepEqual((await f.api()).calls, ['Draft']);
  assert.deepEqual(await f.state(), state);
});

test('refuses pending mutations or unfinished prior configurations before making requests', async t => {
  for (const extra of [{ pending: 'staging template changes' }, { applied: false }, { verified: false }]) {
    const state = { ...verifiedState(), ...extra };
    const f = await fixture(t, { state, exported: previousConfig, remote: previousConfig });
    assert.equal((await f.run()).code, 1);
    assert.deepEqual((await f.api()).calls, []);
    assert.deepEqual(await f.state(), state);
  }
});

test('refuses active or unknown change sets before staging a revision', async t => {
  for (const status of ['STAGED', 'UNKNOWN']) {
    const state = verifiedState();
    const f = await fixture(t, { state, exported: previousConfig, remote: previousConfig, changeSets: [status] });
    const result = await f.run();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /staged edits or an unknown/);
    assert.deepEqual((await f.api()).calls, ['Draft', 'Staged']);
    assert.deepEqual(await f.state(), state);
  }
});

test('resumes a saved staged configuration after an interrupted read without restaging', async t => {
  const f = await fixture(t, { failBefore: 'ChangeSet' });
  assert.equal((await f.run()).code, 1);
  assert.equal((await f.state()).changeSetId, 'new-change');
  assert.ok(!(await f.state()).pending);
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const calls = (await f.api()).calls;
  assert.equal(calls.filter(call => call === 'Stage').length, 1);
  assert.equal(calls.filter(call => call === 'Apply').length, 1);
  assert.equal((await f.state()).verified, true);
});

test('does not repeat a mutation whose response was lost', async t => {
  const f = await fixture(t, { failAfter: 'Stage' });
  assert.equal((await f.run()).code, 1);
  assert.equal((await f.state()).pending, 'staging template changes');
  const calls = (await f.api()).calls;
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown outcome/);
  assert.deepEqual((await f.api()).calls, calls, 'retry makes no requests');
  assert.equal(calls.filter(call => call === 'Stage').length, 1);
  assert.ok(!calls.includes('Apply'));
});

test('retrying an already verified current configuration only reads back the draft', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).code, 0);
  const before = (await f.api()).calls.length;
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.api()).calls.slice(before), ['Draft', 'Draft']);
});
