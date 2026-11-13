import { createRequire } from 'node:module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CliError';
  }
}

export interface GuestLink {
  id: string;
  endpoint: string;
  key: Uint8Array;
}

interface GuestCrypto {
  openGuest(key: Uint8Array, itemId: string, ciphertext: Uint8Array): Uint8Array;
}

export function parseLink(input: string): GuestLink {
  // URL() normalizes whitespace and credentials; validate those before any I/O.
  if (!input || input.length > 8192 || /[\u0000-\u0020\u007f]/u.test(input)) {
    throw new CliError('Expected the complete original PowerBin link, including its #key.', 2);
  }
  let url: URL;
  try { url = new URL(input); }
  catch { throw new CliError('Invalid PowerBin URL.', 2); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('PowerBin links must use HTTPS. HTTP is allowed only for local development.', 2);
  }
  if (url.username || url.password) throw new CliError('PowerBin URLs cannot contain credentials.', 2);
  if (url.pathname !== '/' || url.searchParams.size !== 1 || url.searchParams.getAll('link').length !== 1) {
    throw new CliError('Expected a PowerBin link with the form https://host/?link=<id>#<key>.', 2);
  }
  const id = url.searchParams.get('link')!;
  if (!UUID.test(id)) throw new CliError('The link contains an invalid message ID.', 2);
  const secret = url.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    throw new CliError('The link is missing a valid decryption key. Paste the complete original link, including #key.', 2);
  }
  const key = Buffer.from(secret, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== secret) {
    key.fill(0);
    throw new CliError('The link contains an invalid decryption key.', 2);
  }
  // UUIDs are stored and used as authenticated crypto context in canonical form.
  const canonicalId = id.toLowerCase();
  return { id: canonicalId, endpoint: `${url.origin}/api/links/${canonicalId}/reveal`, key };
}

function loadCrypto(): GuestCrypto {
  try {
    const crypto = createRequire(import.meta.url)('./crypto/powerbin_crypto.cjs') as GuestCrypto;
    if (typeof crypto.openGuest !== 'function') throw new Error();
    return crypto;
  } catch {
    throw new CliError('The bundled decryption module could not load. Reinstall this package before revealing the message.');
  }
}

function statusError(status: number): CliError {
  switch (status) {
    case 400: return new CliError('The server rejected this link. Check that you pasted the complete original URL.');
    case 401:
    case 403: return new CliError('This service denied access to the message.');
    case 404: return new CliError('This link is unavailable or does not exist.');
    case 410: return new CliError('This link has already been consumed or has expired.');
    case 429: return new CliError('This service is receiving too many reveal requests. Try again shortly.');
    default: return new CliError('The server could not complete the reveal. The message may already have burned; do not automatically retry.');
  }
}

async function responseBody(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export interface RevealOptions {
  timeoutMs?: number;
}

async function checkProtocol(link: GuestLink, timeoutMs: number): Promise<void> {
  let response: Response;
  try {
    response = await fetch(link.endpoint.slice(0, -'/reveal'.length), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new CliError('The link availability check was lost or timed out. This request did not consume the message.');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new CliError('The service redirected the availability check. No redirect was followed. This request did not consume the message.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const reason = [400, 401, 403, 404, 410, 429].includes(response.status)
      ? statusError(response.status).message
      : 'The server could not check this link.';
    throw new CliError(`${reason} This request did not consume the message.`);
  }
  let metadata: unknown;
  try { metadata = JSON.parse(await responseBody(response)); }
  catch {
    throw new CliError('The link metadata response was incomplete or invalid. This request did not consume the message.');
  }
  if (!metadata || typeof metadata !== 'object' || !('protocol_version' in metadata) || metadata.protocol_version !== 2) {
    throw new CliError('This link/server uses an unsupported encryption format. Update PowerBin server/browser, then create a new link. This request did not consume the message.');
  }
}

/** Check compatibility without consuming, then make a single consuming request. */
export async function revealLink(input: string, options: RevealOptions = {}): Promise<Uint8Array> {
  const link = parseLink(input);
  try {
    const crypto = loadCrypto();
    await checkProtocol(link, options.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await fetch(link.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
      });
    } catch {
      throw new CliError('The reveal response was lost or timed out. The message may already have burned; do not automatically retry.');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new CliError('The service redirected the reveal request. No redirect was followed. The message may already have burned.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    let payload: Uint8Array;
    try {
      const body: unknown = JSON.parse(await responseBody(response));
      if (!body || typeof body !== 'object' || !('payload' in body) || typeof body.payload !== 'string'
        || !/^[A-Za-z0-9_-]+$/u.test(body.payload)) throw new Error();
      const bytes = Buffer.from(body.payload, 'base64url');
      if (bytes.length < 29 || bytes.length > 32 * 1024 + 29 || bytes.toString('base64url') !== body.payload) throw new Error();
      payload = bytes;
    } catch {
      throw new CliError('The message was claimed, but its encrypted response was incomplete or invalid. It cannot be revealed again.');
    }
    try {
      const plaintext = crypto.openGuest(link.key, link.id, payload);
      try { new TextDecoder('utf-8', { fatal: true }).decode(plaintext); }
      catch { plaintext.fill(0); throw new Error(); }
      return plaintext;
    } catch {
      throw new CliError('The message was claimed, but decryption failed. Check the original link; the message cannot be revealed again.');
    } finally {
      payload.fill(0);
    }
  } finally {
    link.key.fill(0);
  }
}

/** Escape controls only in human terminal output; raw and piped bytes stay exact. */
export function terminalText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, character => {
    const code = character.charCodeAt(0);
    return code < 256 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}
