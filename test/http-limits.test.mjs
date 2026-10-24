import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

test('HTTP bodies are bounded before dispatch and receive deadlines do not time out jobs', { timeout: 15_000 }, async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/http-limits-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  const path = join(root, '.env');
  const settings = 'AUTH_USER=admin\nAUTH_PASS=http-limits-password\nSERVER_HOST=127.0.0.1\n';
  await writeFile(path, settings);
  const keys = ['AUTH_USER', 'AUTH_PASS', 'SERVER_HOST', 'SERVER_TLS_CERT', 'SERVER_TLS_KEY', 'WEB_FRAME_ENV_FILE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.WEB_FRAME_ENV_FILE = path;
  delete process.env.SERVER_TLS_CERT;
  delete process.env.SERVER_TLS_KEY;
  const calls = [];
  let jobDelay = 0;
  t.mock.module(pathToFileURL(join(root, 'dist', 'app.js')).href, { exports: {
    getDefaultImage: () => join(root, 'preview.png'), ImageNotFoundError: class extends Error {},
    generateImage: async () => { calls.push('image'); await delay(jobDelay); },
    uploadAndSelect: async () => { calls.push('upload'); return 'id'; },
    runOnce: async () => { calls.push('run'); return { skipped: true }; },
    cleanupTvImages: async () => { calls.push('cleanup'); },
    scanTvs: async () => { calls.push('scan'); return []; }, listTvImages: async () => [],
  } });
  const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.js')).href);
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:http-limits-password').toString('base64')}` };
  const { token } = await (await fetch(`${base}/api/csrf`, { headers: auth })).json();
  const headers = { ...auth, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body });
  const limit = 64 * 1024;
  const routes = ['/api/config', '/api/cleanup', '/api/image', '/api/screenshot', '/api/upload', '/api/run', '/api/scan'];

  // Content-Length rejects immediately; even action endpoints must not run jobs.
  for (const route of routes) {
    const response = await post(route, ' '.repeat(limit - 1) + '{}');
    assert.equal(response.status, 413, route);
    assert.equal(response.headers.get('connection'), 'close');
    assert.equal((await response.json()).ok, false);
  }
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path, 'utf8'), settings);

  const sendChunks = (route, chunks) => new Promise((resolve, reject) => {
    const req = request(base + route, { method: 'POST', headers }, res => {
      const body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  // No Content-Length: enforce the accumulated byte count, including multibyte UTF-8.
  const large = Buffer.from(JSON.stringify({ AUTH_USER: 'é'.repeat(limit / 2) }));
  assert.ok(large.toString().length < limit);
  for (const route of routes) {
    const response = await sendChunks(route, [large.subarray(0, 40_000), large.subarray(40_000)]);
    assert.equal(response.status, 413, route);
    assert.equal(response.headers.connection, 'close');
  }
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path, 'utf8'), settings);
  assert.equal((await post('/api/config', ' '.repeat(limit - 2) + '{}')).status, 200, 'exact byte limit is accepted');
  assert.equal((await post('/api/config', '')).status, 200);
  assert.equal((await post('/api/config', '{')).status, 400, 'invalid JSON retains its error');

  // Raw sockets prove oversize declarations need no body, connections close,
  // and stalled/trickling uploads cannot begin an action.
  let receiveTimeouts = 0;
  const emit = server.emit;
  t.mock.method(server, 'emit', function (name, ...args) {
    if (name === 'clientError' && args[0].code === 'ERR_HTTP_REQUEST_TIMEOUT') receiveTimeouts++;
    return emit.call(this, name, ...args);
  });
  const rawRequest = (initial, trickle = false) => new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let raw = '';
    let reset = false;
    let interval;
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Connection was not closed')); }, 4000);
    socket.on('connect', () => {
      socket.write(initial);
      if (trickle) interval = setInterval(() => socket.write(' '), 30);
    });
    socket.on('data', chunk => { raw += chunk; clearInterval(interval); });
    socket.on('error', error => {
      // Node writes 408 then immediately destroys the socket. On Windows the
      // reset can arrive without that response; verify the native timeout below.
      if (error.code === 'ECONNRESET') reset = true;
      else reject(error);
    });
    socket.on('close', () => { clearTimeout(timeout); clearInterval(interval); resolve({ raw, reset }); });
  });
  const head = `POST /api/image HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${auth.Authorization}\r\nX-CSRF-Token: ${token}\r\n`;
  assert.match((await rawRequest(head + `Content-Length: ${limit + 1}\r\n\r\n`)).raw, /^HTTP\/1\.1 413/);

  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.timeout, 0, 'no socket inactivity cap on completed requests');
  // Shorten native deadlines only in this test; the production checking interval stays in use.
  server.requestTimeout = 100;
  server.headersTimeout = 100;
  for (const initial of [head + 'Content-Length: 10000\r\n\r\n', 'POST /api/image HTTP/1.1\r\nHost: ']) {
    const before = receiveTimeouts;
    const { raw, reset } = await rawRequest(initial, true);
    assert.equal(receiveTimeouts, before + 1, 'native receive deadline must cause the closure');
    if (raw) assert.match(raw, /^HTTP\/1\.1 408/);
    else assert.equal(reset, true);
  }
  assert.deepEqual(calls, [], 'incomplete requests never start a job');

  const abandoned = createConnection({ host: '127.0.0.1', port });
  await once(abandoned, 'connect');
  abandoned.write(head + 'Content-Length: 100\r\n\r\n{');
  await delay(20);
  abandoned.destroy();
  await once(abandoned, 'close');
  jobDelay = 1200; // Cross both the shortened deadline and a timeout-check cycle.
  assert.equal((await post('/api/image', '')).status, 200);
  assert.deepEqual(calls, ['image']);
  assert.equal((await fetch(`${base}/api/config`, { headers: auth })).status, 200, 'server remains healthy after rejections');
});
