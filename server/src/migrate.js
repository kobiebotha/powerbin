import { readFile, readdir } from 'node:fs/promises';

export async function migrate(pool) {
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
  }
}
