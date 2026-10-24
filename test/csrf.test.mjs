import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

test('CSRF protection rejects forged mutations before settings or TV operations run', async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/csrf-test-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  const settingsPath = join(root, '.env');
  const settings = 'AUTH_USER=admin\nAUTH_PASS=csrf-testing-password\nSERVER_HOST=127.0.0.1\n';
  await writeFile(settingsPath, settings);
  const keys = ['AUTH_USER', 'AUTH_PASS', 'SERVER_HOST', 'SERVER_TLS_CERT', 'SERVER_TLS_KEY', 'WEB_FRAME_ENV_FILE', 'TV_IP'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  process.env.WEB_FRAME_ENV_FILE = settingsPath;
  delete process.env.SERVER_TLS_CERT;
  delete process.env.SERVER_TLS_KEY;
  const calls = [];
  t.mock.module(pathToFileURL(join(root, 'dist', 'app.js')).href, { exports: {
    getDefaultImage: () => join(root, 'preview.png'), ImageNotFoundError: class extends Error {},
    generateImage: async () => { calls.push('image'); },
    uploadAndSelect: async () => { calls.push('upload'); return 'id'; },
    runOnce: async () => { calls.push('run'); return { skipped: true }; },
    cleanupTvImages: async () => { calls.push('cleanup'); },
    scanTvs: async () => { calls.push('scan'); return []; },
    listTvImages: async () => [],
  } });
  const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.js')).href);
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = password => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
  const auth = { Authorization: authorization('csrf-testing-password') };
  const post = (path, headers = {}, body = '{}') => fetch(base + path, {
    method: 'POST', headers: { ...auth, ...headers }, body,
  });
  assert.equal((await fetch(`${base}/api/csrf`)).status, 401);
  assert.equal((await fetch(`${base}/api/config`, { headers: auth })).status, 200);
  const tokenResponse = await fetch(`${base}/api/csrf`, { headers: auth });
  assert.equal(tokenResponse.headers.get('cache-control'), 'no-store');
  assert.equal(tokenResponse.headers.get('access-control-allow-origin'), null);
  const { token } = await tokenResponse.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const valid = { 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
  const routes = ['/api/config', '/api/image', '/api/screenshot', '/api/upload', '/api/run', '/api/cleanup', '/api/scan'];
  for (const route of routes) {
    for (const headers of [
      {},
      { Origin: 'https://attacker.test', 'Content-Type': 'text/plain' },
      { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' },
      { 'Content-Type': 'application/json' },
      { 'X-CSRF-Token': 'bad-token' },
      { 'X-CSRF-Token': '0'.repeat(64) },
      { ...valid, 'Sec-Fetch-Site': 'cross-site' },
      { ...valid, 'Sec-Fetch-Site': 'same-site' },
    ]) {
      assert.equal((await post(route, headers, '{"TV_IP":"192.0.2.9"}')).status, 403, route);
    }
  }
  assert.deepEqual(calls, []);
  assert.equal(await readFile(settingsPath, 'utf8'), settings);
  for (const site of ['same-site', 'cross-site']) {
    assert.equal((await fetch(`${base}/api/csrf`, { headers: { ...auth, 'Sec-Fetch-Site': site } })).status, 403);
  }
  const preflight = await fetch(`${base}/api/config`, { method: 'OPTIONS', headers: {
    ...auth, Origin: 'https://attacker.test', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-csrf-token',
  } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(preflight.headers.get('access-control-allow-headers'), null);
  // Tokens in a form body or query string never satisfy the header requirement.
  assert.equal((await post(`/api/config?token=${token}`, {}, JSON.stringify({ token }))).status, 403);
  assert.equal((await post('/api/config', { ...valid, Origin: base, 'Sec-Fetch-Site': 'same-origin' }, '{"TV_IP":"192.0.2.1"}')).status, 200);
  for (const route of routes.slice(1)) {
    assert.equal((await post(route, valid)).status, 200, 'scripts without Origin/Fetch Metadata can use tokens');
  }
  assert.deepEqual(calls, ['image', 'image', 'upload', 'run', 'cleanup', 'scan']);
  assert.equal((await post('/api/config', valid, '{"AUTH_PASS":"changed-csrf-password"}')).status, 200);
  assert.equal((await post('/api/config', valid)).status, 401, 'token does not replace authentication');
  const newAuth = { Authorization: authorization('changed-csrf-password') };
  assert.equal((await post('/api/config', { ...valid, ...newAuth })).status, 403, 'credential changes revoke old tokens');
  const fresh = (await (await fetch(`${base}/api/csrf`, { headers: newAuth })).json()).token;
  assert.notEqual(fresh, token);
  assert.equal((await post('/api/config', { ...valid, ...newAuth, 'X-CSRF-Token': fresh })).status, 200);
});

test('admin UI fetches a fresh token for each mutation and stops when token retrieval fails', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const apiSource = html.slice(html.indexOf('    async function api('), html.indexOf('    function togglePassword('));
  const requests = [];
  let generation = 0;
  let rejectToken = false;
  const context = vm.createContext({ fetch: async (path, options) => {
    requests.push({ path, options });
    return { json: async () => path === '/api/csrf'
      ? rejectToken ? { ok: false, error: 'denied' } : { ok: true, token: `token-${++generation}` }
      : { ok: true } };
  } });
  const api = vm.runInContext(apiSource + '; api', context);
  await api('GET', '/api/config');
  assert.equal(requests.length, 1);
  await api('POST', '/api/config', { TV_IP: '192.0.2.1' });
  assert.equal(requests[1].path, '/api/csrf');
  assert.equal(requests[2].options.headers['X-CSRF-Token'], 'token-1');
  assert.equal(requests[2].options.body, '{"TV_IP":"192.0.2.1"}');
  await api('POST', '/api/run');
  assert.equal(requests[4].options.headers['X-CSRF-Token'], 'token-2');
  rejectToken = true;
  await assert.rejects(api('POST', '/api/upload'), /denied/);
  assert.equal(requests.at(-1).path, '/api/csrf');
  assert.equal(requests.length, 6);
});
