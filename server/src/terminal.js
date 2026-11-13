import { Rejected, uuid } from './domain.js';

export function wantsTerminal(request) {
  const accepted = new Map((request.headers.accept || '').split(',').map(entry => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(';');
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    return [type, quality === undefined ? 1 : Number(quality.slice(2))];
  }));
  const plain = accepted.get('text/plain');
  const html = accepted.get('text/html') || 0;
  if (plain !== undefined) return plain > 0 && plain >= html;
  if (html > 0) return false;
  return /^curl\//i.test(request.headers['user-agent'] || '');
}

export async function terminalLink(pool, request, response, url) {
  let id;
  try {
    const ids = url.searchParams.getAll('link');
    if (ids.length !== 1) throw new Rejected('Invalid id');
    id = uuid(ids[0]);
  } catch (error) {
    if (!(error instanceof Rejected)) throw error;
    return send(request, response, 400, 'Invalid link. Paste the complete original PowerBin link.');
  }
  const { rows } = await pool.query(
    'SELECT expires_at, burned_at FROM items WHERE id = $1 AND kind = \'link\'', [id]
  );
  const item = rows[0];
  if (!item) return send(request, response, 404, 'This link is unavailable.');
  if (item.burned_at || new Date(item.expires_at).getTime() <= Date.now()) {
    return send(request, response, 410, 'This link has been consumed or has expired.');
  }
  return send(request, response, 200, [
    'Status:  Available',
    `Expires: ${new Date(item.expires_at).toISOString()}`,
    '',
    'This request has not consumed the message.',
    '',
    'Reveal and burn with local decryption:',
    "  pnpx powerbin reveal '<paste the complete original link, including #key>'",
    '',
    'The decryption key stays on your device. curl does not send the #key.'
  ].join('\n'));
}

function send(request, response, status, message) {
  const output = `PowerBin · One-time message\n\n${message}\n`;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(output));
  response.writeHead(status);
  response.end(request.method === 'HEAD' ? undefined : output);
}
