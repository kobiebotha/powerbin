/** Validate before credentials are attached or a connection is opened. */
export function endpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Server URLs must use HTTPS. HTTP is allowed only for localhost development.');
  }
  if (url.username || url.password || url.hash) throw new Error('Server URLs cannot contain credentials or fragments.');
  return url;
}

export function origin(value: string): URL {
  const url = endpoint(value);
  if (url.pathname !== '/' || url.search) throw new Error('Enter the PowerBin server origin without a path or query.');
  return url;
}

export function syncEndpoint(serverOrigin: string, value: string): URL {
  const api = origin(serverOrigin);
  const sync = endpoint(value);
  if (api.protocol === 'https:' && sync.protocol !== 'https:') {
    throw new Error('An HTTPS PowerBin server requires an HTTPS sync endpoint.');
  }
  return sync;
}

/** Used by both Rust/WASM API actions and the browser sync connector. */
export async function request(serverOrigin: string, token: string, path: string, method: string, body?: string | null): Promise<string> {
  const base = origin(serverOrigin);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('API requests must stay on the configured server origin.');
  const response = await fetch(url, {
    method,
    redirect: 'error',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body == null ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body == null ? {} : { body })
  });
  const text = await response.text();
  if (!response.ok) {
    const value = JSON.parse(text) as { error?: string };
    throw new Error(value.error || `PowerBin backend returned ${response.status}`);
  }
  return text;
}
