import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HOUR_MS, COMPACTION_TIMEOUT_MS, supervise } from './powersync-supervisor.mjs';

function harness(options = {}) {
  const children = [], timers = new Map(), exits = [], logs = [];
  const signals = new EventEmitter();
  let nextTimer = 0, healthy = true, clock = 0;
  const supervisor = supervise({
    spawn(executable, args, settings) {
      const child = new EventEmitter();
      Object.assign(child, { executable, args, settings, killed: [], kill(signal) { this.killed.push(signal); } });
      children.push(child);
      return child;
    },
    setTimer(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    now: () => clock,
    ready: async () => healthy,
    signals,
    exit: code => exits.push(code),
    log: message => logs.push(message),
    ...options
  });
  return {
    children, timers, exits, logs, signals, supervisor,
    healthy(value) { healthy = value; },
    elapse(milliseconds) { clock += milliseconds; },
    async tick(expectedDelay) {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      assert.equal(timer.delay, expectedDelay);
      timers.delete(id);
      clock += timer.delay;
      await timer.fn();
    }
  };
}

test('compacts after readiness and hourly thereafter without overlapping jobs', async () => {
  const h = harness();
  assert.deepEqual(h.children[0].args, ['service/lib/entry.js', 'start', '-r', 'unified']);
  h.healthy(false);
  await h.tick(0);
  assert.equal(h.children.length, 1);
  h.healthy(true);
  await h.tick(5000);
  assert.deepEqual(h.children[1].args, ['service/lib/entry.js', 'compact']);
  assert.equal(h.children[1].settings.stdio, 'ignore');
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [COMPACTION_TIMEOUT_MS], 'only the active job deadline is scheduled');
  h.children[1].emit('close', 0);
  await h.tick(HOUR_MS);
  assert.equal(h.children.length, 3);
  assert.deepEqual(h.children[2].args, ['service/lib/entry.js', 'compact']);
  assert.deepEqual(h.logs, ['PowerSync bucket compaction starting', 'PowerSync bucket compaction completed', 'PowerSync bucket compaction starting']);
});

test('failed compaction retries in five minutes and then resumes hourly cleanup', async () => {
  const h = harness();
  await h.tick(0);
  h.children[1].emit('close', 1);
  await h.tick(5 * 60 * 1000);
  h.children[2].emit('close', 0);
  await h.tick(HOUR_MS);
  assert.equal(h.children.length, 4);
  assert.match(h.logs[1], /failed; retrying/);
});

test('job duration does not make the hourly schedule drift', async () => {
  const h = harness();
  await h.tick(0);
  h.elapse(10 * 60 * 1000);
  h.children[1].emit('close', 0);
  await h.tick(50 * 60 * 1000);
  assert.equal(h.children.length, 3);
});

test('a hung compactor is terminated and cannot prevent future cleanup', async () => {
  const h = harness();
  await h.tick(0);
  await h.tick(COMPACTION_TIMEOUT_MS);
  assert.deepEqual(h.children[1].killed, ['SIGTERM']);
  await h.tick(10_000);
  assert.deepEqual(h.children[1].killed, ['SIGTERM', 'SIGKILL']);
  h.children[1].emit('close', 0);
  await h.tick(5 * 60 * 1000);
  assert.deepEqual(h.children[2].args, ['service/lib/entry.js', 'compact']);
  assert.match(h.logs.at(-2), /failed; retrying/);
});

test('shutdown stops both children and cancels maintenance before exiting', async () => {
  const h = harness();
  await h.tick(0);
  h.signals.emit('SIGTERM');
  assert.deepEqual(h.children.map(child => child.killed), [['SIGTERM'], ['SIGTERM']]);
  assert.deepEqual(h.exits, []);
  h.children[0].emit('close', 0);
  assert.deepEqual(h.exits, []);
  h.children[1].emit('close', 0);
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.timers.size, 0);
  assert.equal(h.signals.listenerCount('SIGTERM'), 0);
});

test('an unexpected service exit stops the compactor and propagates failure', async () => {
  const h = harness();
  await h.tick(0);
  h.children[0].emit('close', 2);
  assert.deepEqual(h.children[1].killed, ['SIGTERM']);
  await h.tick(10_000);
  assert.deepEqual(h.children[1].killed, ['SIGTERM', 'SIGKILL']);
  h.children[1].emit('close', null);
  assert.deepEqual(h.exits, [2]);
});

test('an unsolicited clean service exit fails so container restart restores cleanup', () => {
  const h = harness();
  h.children[0].emit('close', 0);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.timers.size, 0);
});

test('one-shot image commands execute without creating a schedule', () => {
  const h = harness({ args: ['compact'] });
  assert.deepEqual(h.children[0].args, ['service/lib/entry.js', 'compact']);
  assert.equal(h.timers.size, 0);
  h.children[0].emit('close', 0);
  assert.deepEqual(h.exits, [0]);
});

test('real service and maintenance processes receive shutdown and leave no workers', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-supervisor-'));
  const events = join(directory, 'events.jsonl');
  await mkdir(join(directory, 'service', 'lib'), { recursive: true });
  await writeFile(join(directory, 'service', 'lib', 'entry.js'), `
    const fs = require('node:fs');
    const event = type => fs.appendFileSync(process.env.EVENTS_FILE,
      JSON.stringify({type, command: process.argv[2], pid: process.pid}) + '\\n');
    event('start');
    process.on('SIGTERM', () => { event('stop'); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  const module = new URL('./powersync-supervisor.mjs', import.meta.url).href;
  const worker = spawn(process.execPath, ['--input-type=module', '-e',
    `import {supervise} from ${JSON.stringify(module)}; supervise({ready: async () => true});`],
  { cwd: directory, env: { ...process.env, EVENTS_FILE: events }, stdio: 'ignore' });
  const completed = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    worker.kill('SIGKILL');
    await completed;
    await rm(directory, { recursive: true, force: true });
  });
  const records = async () => (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  let started = [];
  for (let i = 0; i < 300; i++) {
    try { started = await records(); } catch { /* children are still starting */ }
    if (started.length === 2) break;
    await delay(10);
  }
  assert.deepEqual(started.map(event => event.command).sort(), ['compact', 'start']);
  worker.kill('SIGTERM');
  assert.deepEqual(await completed, { code: 0, signal: null });
  const stopped = (await records()).filter(event => event.type === 'stop');
  assert.deepEqual(stopped.map(event => event.command).sort(), ['compact', 'start']);
  for (const event of stopped) assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
});
