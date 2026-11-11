import { cp, mkdir } from 'node:fs/promises';
const destination = new URL('../.nsh/out/PowerBin/web/dist/', import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL('../app/web/dist/', import.meta.url), destination, { recursive: true });
