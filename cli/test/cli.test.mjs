import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { revealLink, terminalText } from '../dist/client.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/guest.json', import.meta.url), 'utf8'));
const executable = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function service(t, handler, { metadataHandler } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const observed = {
      method: request.method, path: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    };
    requests.push(observed);
    if (request.method === 'GET' && request.url === `/api/links/${fixture.id}`) {
      if (metadataHandler) return metadataHandler(request, response);
      return json(response, 200, { expires_at: '2099-01-01T00:00:00Z', protocol_version: 2 });
    }
    handler(request, response, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/?link=${fixture.id}#${fixture.key}`, requests };
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function command(args, { input, bin = executable } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.end(input);
  });
}

test('help and version work without a link', async () => {
  const help = await command(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout.toString(), /powerbin reveal.*#key/);
  assert.equal(help.stderr, '');
  const version = await command(['--version']);
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version.code, 0);
  assert.equal(version.stdout.toString(), `${packageInfo.version}\n`);
});

test('reveals a Rust-created message with one POST and keeps the key local', async t => {
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }));
  const result = await command(['reveal', endpoint.url]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout, Buffer.from(fixture.plaintext));
  assert.equal(result.stderr, '');
  assert.equal(endpoint.requests.length, 2);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
  assert.equal(endpoint.requests[0].path, `/api/links/${fixture.id}`);
  const observed = endpoint.requests[1];
  assert.equal(observed.method, 'POST');
  assert.equal(observed.path, `/api/links/${fixture.id}/reveal`);
  assert.equal(observed.body, '{}');
  assert.equal(observed.headers['content-type'], 'application/json');
  assert.equal(observed.headers.accept, 'application/json');
  assert.ok(!JSON.stringify(endpoint.requests).includes(fixture.key));
  assert.ok(!result.stderr.includes(fixture.key));
  assert.ok(!result.stderr.includes(fixture.plaintext));
});

test('--stdin and --raw preserve Unicode, whitespace and absence of a final newline', async t => {
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }));
  const result = await command(['reveal', '--stdin', '--raw'], { input: `${endpoint.url}\n` });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout, Buffer.from(fixture.plaintext));
  assert.equal(result.stderr, '');
  assert.equal(endpoint.requests.length, 2);
});

test('rejects malformed links and arguments before making a consuming request', async t => {
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }));
  const invalid = [
    endpoint.url.split('#')[0],
    endpoint.url.replace(fixture.key, 'short'),
    endpoint.url.replace(fixture.key, `${fixture.key.slice(0, -1)}B`),
    endpoint.url.replace(`?link=${fixture.id}`, `?link=${fixture.id}&link=${fixture.id}`),
    endpoint.url.replace(fixture.id, 'not-a-uuid'),
    endpoint.url.replace('/?link=', '/other?link='),
    endpoint.url.replace('http://', 'ftp://'),
    endpoint.url.replace('http://', 'http://user:password@'),
    `\n${endpoint.url}`,
    `http://example.com/?link=${fixture.id}#${fixture.key}`
  ];
  for (const url of invalid) {
    const result = await command(['reveal', url]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout.length, 0);
    assert.ok(!result.stderr.includes(fixture.key));
    assert.ok(!result.stderr.includes(url));
  }
  for (const args of [ ['reveal'], ['reveal', endpoint.url, '--stdin'], ['reveal', endpoint.url, '--unknown'], ['reveal', endpoint.url, endpoint.url] ]) {
    const result = await command(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout.length, 0);
  }
  assert.equal(endpoint.requests.length, 0);
});

test('unsupported or missing protocol metadata prevents consumption, including old servers', async t => {
  for (const protocol_version of [1, null, 0, 3, '2', undefined]) {
    const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
      metadataHandler: (_request, response) => json(response, 200, { expires_at: '2099-01-01T00:00:00Z', protocol_version })
    });
    const result = await command(['reveal', endpoint.url]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /unsupported encryption format/);
    assert.match(result.stderr, /Update PowerBin server\/browser, then create a new link/);
    assert.match(result.stderr, /This request did not consume the message/);
    assert.deepEqual(endpoint.requests.map(request => request.method), ['GET']);
    assert.ok(!JSON.stringify(endpoint.requests).includes(fixture.key));
  }
});

test('malformed availability metadata never reaches the consuming endpoint', async t => {
  for (const body of ['not JSON', 'null', '[]', '{"protocol_version":']) {
    const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
      metadataHandler: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(body);
      }
    });
    const result = await command(['reveal', endpoint.url]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /This request did not consume the message/);
    assert.deepEqual(endpoint.requests.map(request => request.method), ['GET']);
  }
});

test('availability errors are readable and prevent any consuming POST', async t => {
  for (const [status, expected] of [[404, /unavailable/], [410, /consumed/], [429, /too many/], [503, /could not check this link/]]) {
    const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
      metadataHandler: (_request, response) => json(response, status, { error: `${fixture.key} server supplied text` })
    });
    const result = await command(['reveal', endpoint.url]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, expected);
    assert.match(result.stderr, /This request did not consume the message/);
    assert.ok(!result.stderr.includes(fixture.key));
    assert.ok(!result.stderr.includes('server supplied text'));
    assert.deepEqual(endpoint.requests.map(request => request.method), ['GET']);
  }
});

test('availability redirects are neither followed nor consumed', async t => {
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
    metadataHandler: (_request, response) => {
      response.writeHead(307, { Location: '/redirected' });
      response.end();
    }
  });
  const result = await command(['reveal', endpoint.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /No redirect was followed/);
  assert.match(result.stderr, /This request did not consume the message/);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET']);
});

test('lost or stalled availability responses never consume or retry', async t => {
  const lost = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
    metadataHandler: request => request.socket.destroy()
  });
  const result = await command(['reveal', lost.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /availability check was lost or timed out/);
  assert.match(result.stderr, /This request did not consume the message/);
  assert.deepEqual(lost.requests.map(request => request.method), ['GET']);
  const stalled = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }), {
    metadataHandler: (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"protocol_version":');
    }
  });
  await assert.rejects(revealLink(stalled.url, { timeoutMs: 80 }), /metadata.*incomplete or invalid.*did not consume/);
  assert.deepEqual(stalled.requests.map(request => request.method), ['GET']);
});

test('only one simultaneous reveal receives the message', async t => {
  let consumed = false;
  const endpoint = await service(t, (_request, response) => {
    if (consumed) return json(response, 410, { error: 'consumed' });
    consumed = true;
    json(response, 200, { payload: fixture.payload });
  });
  const results = await Promise.all([command(['reveal', endpoint.url, '--raw']), command(['reveal', endpoint.url, '--raw'])]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  assert.deepEqual(results.find(result => result.code === 0).stdout, Buffer.from(fixture.plaintext));
  assert.equal(results.find(result => result.code === 1).stdout.length, 0);
  assert.match(results.find(result => result.code === 1).stderr, /consumed or has expired/);
  assert.equal(endpoint.requests.filter(request => request.method === 'POST').length, 2);
});

test('HTTP errors are readable and never echo server text or secrets', async t => {
  for (const [status, expected] of [[404, /unavailable/], [410, /consumed/], [429, /too many/], [503, /may already have burned/]]) {
    const endpoint = await service(t, (_request, response) => json(response, status, { error: `${fixture.key}\u001b[2Jserver supplied text` }));
    const result = await command(['reveal', endpoint.url]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, expected);
    assert.ok(!result.stderr.includes(fixture.key));
    assert.ok(!result.stderr.includes('server supplied text'));
    assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
  }
});

test('redirects are not followed or retried', async t => {
  const endpoint = await service(t, (_request, response) => {
    response.writeHead(307, { Location: '/redirected' });
    response.end();
  });
  const result = await command(['reveal', endpoint.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /No redirect was followed/);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
});

test('a lost response reports ambiguous consumption and is not retried', async t => {
  const endpoint = await service(t, (request, _response) => request.socket.destroy());
  const result = await command(['reveal', endpoint.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /may already have burned/);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
});

test('a stalled response times out without retrying the consuming POST', async t => {
  const endpoint = await service(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"payload":"');
  });
  await assert.rejects(revealLink(endpoint.url, { timeoutMs: 80 }), /claimed.*incomplete or invalid/);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
});

test('broken crypto packaging fails before the server can burn anything', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'powerbin-missing-wasm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  await Promise.all([
    copyFile(new URL('../dist/client.js', import.meta.url), join(directory, 'dist/client.js')),
    copyFile(new URL('../dist/index.js', import.meta.url), join(directory, 'dist/index.js')),
    writeFile(join(directory, 'package.json'), '{"type":"module","version":"0.0.0"}')
  ]);
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: fixture.payload }));
  const result = await command(['reveal', endpoint.url], { bin: join(directory, 'dist/index.js') });
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /decryption module could not load/);
  assert.equal(endpoint.requests.length, 0);
});

test('tampered ciphertext fails authentication after the single claim', async t => {
  const bytes = Buffer.from(fixture.payload, 'base64url');
  bytes[bytes.length - 1] ^= 1;
  const endpoint = await service(t, (_request, response) => json(response, 200, { payload: bytes.toString('base64url') }));
  const result = await command(['reveal', endpoint.url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr, /decryption failed/);
  assert.deepEqual(endpoint.requests.map(request => request.method), ['GET', 'POST']);
});

test('terminal rendering escapes active controls while keeping ordinary text readable', () => {
  assert.equal(terminalText('safe\n\t世界\u001b]52;c;data\u0007\r\b\u009b\u202e'), 'safe\n\t世界\\x1b]52;c;data\\x07\\x0d\\x08\\x9b\\u202e');
});
