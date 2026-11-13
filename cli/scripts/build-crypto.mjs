import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const localCargo = join(root, '.tools', 'cargo');
const localRustup = join(root, '.tools', 'rustup');
const localBindgen = join(root, '.tools', 'wasm-bindgen');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const environment = { ...process.env };

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

const toolPaths = [];
if (await exists(join(localCargo, 'bin', `cargo${executableSuffix}`))) {
  toolPaths.push(join(localCargo, 'bin'));
  environment.CARGO_HOME ??= localCargo;
  environment.RUSTUP_HOME ??= localRustup;
}
if (await exists(join(localBindgen, `wasm-bindgen${executableSuffix}`))) {
  toolPaths.push(localBindgen);
}
environment.PATH = [...toolPaths, process.env.PATH].filter(Boolean).join(delimiter);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    throw new Error(`Could not run ${command}: install Rust, the wasm32-unknown-unknown target, and wasm-bindgen-cli 0.2.129.`, { cause: result.error });
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

const version = run('wasm-bindgen', ['--version'], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim();
if (version !== 'wasm-bindgen 0.2.129') {
  throw new Error(`Expected wasm-bindgen 0.2.129; found ${version}`);
}

const target = join(packageRoot, 'crypto', 'target');
run('cargo', [
  'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', join(packageRoot, 'crypto', 'Cargo.toml'), '--target-dir', target,
]);

const output = join(packageRoot, 'dist', 'crypto');
await mkdir(output, { recursive: true });
run('wasm-bindgen', [
  join(target, 'wasm32-unknown-unknown', 'release', 'powerbin_cli_crypto.wasm'),
  '--target', 'nodejs', '--out-dir', output, '--out-name', 'powerbin_crypto',
]);
await rename(join(output, 'powerbin_crypto.js'), join(output, 'powerbin_crypto.cjs'));
await rename(join(output, 'powerbin_crypto.d.ts'), join(output, 'powerbin_crypto.d.cts'));
const bindings = join(output, 'powerbin_crypto.cjs');
await writeFile(bindings, (await readFile(bindings, 'utf8')).replace(
  '@ts-self-types="./powerbin_crypto.d.ts"',
  '@ts-self-types="./powerbin_crypto.d.cts"',
));
