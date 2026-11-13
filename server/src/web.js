import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.wmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2'
};

export function webPath(url) {
  try {
    const path = decodeURIComponent(url.split('?')[0]);
    return path.startsWith('/') && !/[\0\\]/.test(path) && !path.split('/').includes('..') ? path : null;
  } catch { return null; }
}

export async function webFiles(directory) {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error('WEB_DIST must be a directory');
  async function file(name) {
    try {
      const path = await realpath(join(root, name));
      if (!path.startsWith(root + sep)) return null;
      const info = await stat(path);
      return info.isFile() ? { path, size: info.size } : null;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    }
  }
  return async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    const path = webPath(request.url);
    if (path === null) {
      response.writeHead(400); response.end(); return true;
    }
    if (path === '/api' || path.startsWith('/api/') || path === '/health') return false;
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!await file(name)) return false;
    const encodings = new Map((request.headers['accept-encoding'] || '').split(',').map(value => {
      const [encoding, quality] = value.trim().split(/;\s*q=/);
      return [encoding, quality === undefined ? 1 : Number(quality)];
    }));
    const quality = encoding => encodings.get(encoding) ?? (encoding === 'identity' ? 1 : encodings.get('*') ?? 0);
    const variants = [['br', '.br'], ['gzip', '.gz'], ['identity', '']]
      .filter(([encoding]) => quality(encoding) > 0).sort((a, b) => quality(b[0]) - quality(a[0]));
    let selected, encoding;
    for (const [candidate, suffix] of variants) {
      selected = await file(name + suffix);
      if (selected) { encoding = candidate; break; }
    }
    if (!selected) { response.writeHead(406); response.end(); return true; }
    response.setHeader('Content-Type', types[extname(name)] || 'application/octet-stream');
    response.setHeader('Content-Length', selected.size);
    response.setHeader('Vary', [response.getHeader('Vary'), 'Accept-Encoding'].filter(Boolean).join(', '));
    if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding);
    response.setHeader('Cache-Control', /(?:^|\/)index\.html$|\.(?:webmanifest|wmanifest)$|(?:^|\/)manifest\.json$/.test(name)
      ? 'no-cache' : /[-.][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|wasm|woff2?|png|svg|webp)$/.test(name)
        ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    response.writeHead(200);
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(selected.path), response);
    return true;
  };
}
