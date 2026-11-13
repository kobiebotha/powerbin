import { spawn as spawnProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOUR_MS = 60 * 60 * 1000;
export const COMPACTION_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

// Keep compaction in the same image/configuration as the sync service. Jobs never
// overlap, and a failed job retries instead of silently losing its schedule.
export function supervise({
  args = ['start', '-r', 'unified'],
  spawn = spawnProcess,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  signals = process,
  exit = code => process.exit(code),
  log = message => console.log(message),
  ready = async () => {
    const port = process.env.PORT || process.env.PS_PORT || '8080';
    const response = await fetch(`http://127.0.0.1:${port}/probes/startup`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }
} = {}) {
  const children = new Set();
  let timer, shutdownTimer, stopping = false, finished = false, exitCode = 0;

  function finish() {
    if (finished || !stopping || children.size) return;
    finished = true;
    clearTimer(shutdownTimer);
    signals.removeListener('SIGTERM', terminate);
    signals.removeListener('SIGINT', interrupt);
    exit(exitCode);
  }

  function stop(code = 0, signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    clearTimer(timer);
    // Bound shutdown even when a child stops responding to graceful signals.
    shutdownTimer = setTimer(() => {
      for (const child of children) child.kill('SIGKILL');
    }, 10_000);
    for (const child of children) child.kill(signal);
    finish();
  }

  function schedule(delay) {
    if (!stopping) timer = setTimer(compact, delay);
  }

  function launch(command, compacting = false) {
    const startedAt = now();
    const child = spawn(process.execPath, ['service/lib/entry.js', ...command], {
      // Upstream errors can include connection strings. Only emit the bounded
      // job status below, never its output or the inherited environment.
      stdio: compacting ? 'ignore' : 'inherit'
    });
    children.add(child);
    let jobTimer, killTimer, timedOut = false;
    if (compacting) {
      jobTimer = setTimer(() => {
        timedOut = true;
        log('PowerSync bucket compaction timed out; terminating job');
        child.kill('SIGTERM');
        killTimer = setTimer(() => child.kill('SIGKILL'), 10_000);
      }, COMPACTION_TIMEOUT_MS);
    }
    child.once('error', () => {
      if (!compacting) log('PowerSync service failed to start');
    });
    child.once('close', code => {
      clearTimer(jobTimer);
      clearTimer(killTimer);
      children.delete(child);
      if (!stopping) {
        if (!compacting) stop(code === 0 && args[0] === 'start' ? 1 : (code ?? 1));
        else {
          const success = code === 0 && !timedOut;
          log(success ? 'PowerSync bucket compaction completed' : 'PowerSync bucket compaction failed; retrying in five minutes');
          schedule(success ? Math.max(0, startedAt + HOUR_MS - now()) : RETRY_MS);
        }
      }
      finish();
    });
    return child;
  }

  async function compact() {
    if (stopping) return;
    let healthy = false;
    try { healthy = await ready(); } catch { /* startup is still in progress */ }
    if (stopping) return;
    if (!healthy) { schedule(5000); return; }
    log('PowerSync bucket compaction starting');
    launch(['compact'], true);
  }

  const terminate = () => stop(0, 'SIGTERM');
  const interrupt = () => stop(0, 'SIGINT');
  signals.on('SIGTERM', terminate);
  signals.on('SIGINT', interrupt);
  launch(args);
  // Also compact after startup so restarts do not postpone cleanup indefinitely.
  // Explicit one-shot commands such as `compact` retain their normal behavior.
  if (args[0] === 'start') schedule(0);
  return { stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  supervise({ args: process.argv.slice(2) });
}
