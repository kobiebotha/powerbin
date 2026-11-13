import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...process.env };
const localCargo = join(root, '.tools', 'cargo');
try {
  await access(join(localCargo, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  environment.PATH = [join(localCargo, 'bin'), process.env.PATH].filter(Boolean).join(delimiter);
  environment.CARGO_HOME ??= localCargo;
  environment.RUSTUP_HOME ??= join(root, '.tools', 'rustup');
} catch { /* Use the developer's installed Rust toolchain. */ }

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root, env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

const metadata = JSON.parse(run('cargo', [
  'metadata', '--offline', '--locked', '--format-version', '1',
  '--manifest-path', join(packageRoot, 'crypto', 'Cargo.toml'),
  '--filter-platform', 'wasm32-unknown-unknown',
]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dependency of nodes.get(id).deps) {
    if (dependency.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dependency.pkg);
  }
}
visit(metadata.resolve.root);

const licenseTexts = [];
const textIds = new Map();
function licenseReference(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) throw new Error('A bundled license or notice file is empty.');
  let id = textIds.get(normalized);
  if (!id) {
    id = licenseTexts.length + 1;
    textIds.set(normalized, id);
    licenseTexts.push(normalized);
  }
  return `[L${id}](#license-text-l${id})`;
}

async function noticeFiles(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await noticeFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const packages = metadata.packages
  .filter(packageInfo => included.has(packageInfo.id) && packageInfo.source)
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
const rows = [];
for (const packageInfo of packages) {
  const directory = dirname(packageInfo.manifest_path);
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!/^(license|copying|notice|unlicense)/i.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await noticeFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  if (packageInfo.license_file) files.push(resolve(directory, packageInfo.license_file));
  const references = [];
  for (const path of [...new Set(files)].sort()) {
    const reference = licenseReference(await readFile(path, 'utf8'));
    references.push(`\`${relative(directory, path).replaceAll('\\', '/')}\` ${reference}`);
  }
  if (!references.length) throw new Error(`No source license files found for ${packageInfo.name} ${packageInfo.version}`);
  rows.push(`| ${packageInfo.name} | ${packageInfo.version} | ${packageInfo.license ?? 'See notices'} | ${references.join(', ')} |`);
}

function decodeHtml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' };
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return named[name] ?? entity;
  });
}

const rustVersion = run('rustc', ['--version']);
const sysroot = run('rustc', ['--print', 'sysroot']);
const rustNoticesPath = join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html');
let rustNotices;
try { rustNotices = await readFile(rustNoticesPath, 'utf8'); }
catch { throw new Error('The installed Rust distribution must include share/doc/rust/COPYRIGHT-library.html to generate standard-library notices.'); }
// Keep the distribution's complete attribution text while storing repeated license
// blocks once. This conservatively includes standard-library notices for all targets.
rustNotices = rustNotices
  .replace(/<head>[\s\S]*?<\/head>/gi, '')
  .replace(/<pre>([\s\S]*?)<\/pre>/gi, (_match, text) => `\n${licenseReference(decodeHtml(text))}\n`)
  .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, url, label) => `${label} (${url})`)
  .replace(/<h([1-6])[^>]*>/gi, (_match, level) => `\n${'#'.repeat(Math.min(Number(level) + 2, 6))} `)
  .replace(/<li[^>]*>/gi, '\n- ')
  .replace(/<\/(?:p|h[1-6]|summary|details|div|ul|li)>/gi, '\n')
  .replace(/<[^>]*>/g, '');
rustNotices = decodeHtml(rustNotices).split('\n').map(line => line.trim()).filter(Boolean).join('\n\n');

const textSections = licenseTexts.map((text, index) => {
  const longestBackticks = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longestBackticks + 1);
  return `### License text L${index + 1}\n\n${fence}text\n${text}\n${fence}`;
});
const document = `# Third-party notices

Generated by \`node scripts/build-notices.mjs\` using \`cli/crypto/Cargo.lock\` and the Rust distribution used for the build. Identical license texts are stored once and referenced from each attribution. No generation timestamp or machine-specific source paths are included.

## Rust crate dependencies

The following registry crates are reachable through normal or build dependencies for \`wasm32-unknown-unknown\`. Development-only dependencies are excluded. Build tools and code removed by optimization are conservatively included. PowerBin's own wrapper and shared crypto code are covered by the accompanying \`LICENSE\` file.

| Crate | Version | Declared license | Source notice files and full texts |
| --- | --- | --- | --- |
${rows.join('\n')}

## Rust standard library

Build toolchain: \`${rustVersion}\`.

The following attribution text comes from the Rust distribution's \`COPYRIGHT-library.html\`. It includes notices for the standard library and its bundled dependencies across all supported targets. Full license blocks are referenced in the license-text section below.

${rustNotices}

## Full license texts

${textSections.join('\n\n')}
`;
await writeFile(join(packageRoot, 'THIRD_PARTY_NOTICES.md'), document);
console.log(`Generated notices for ${packages.length} crates and the Rust standard library (${licenseTexts.length} distinct license texts).`);
