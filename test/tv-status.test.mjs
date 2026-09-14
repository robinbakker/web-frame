import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

test('TV status probes a validated candidate without changing the saved address', async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/tv-status-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  const path = join(root, '.env');
  const settings = 'AUTH_USER=admin\nAUTH_PASS=tv-status-test-password\nTV_IP=192.0.2.1\nSERVER_HOST=127.0.0.1\n';
  await writeFile(path, settings);
  const values = {
    WEB_FRAME_ENV_FILE: path, SERVER_HOST: '127.0.0.1', SERVER_TLS_CERT: '', SERVER_TLS_KEY: '',
    AUTH_USER: 'admin', AUTH_PASS: 'tv-status-test-password', TV_IP: '192.0.2.1',
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const requests = [];
  let fail = false;
  let status = 200;
  let cancelled = 0;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (String(target).startsWith('http://127.0.0.1:')) return realFetch(target, options);
    requests.push(String(target));
    assert.equal(options.redirect, 'manual', 'reachability must not follow another location');
    assert.ok(options.signal instanceof AbortSignal);
    if (fail) throw new Error('Unreachable or timed out');
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status });
  });
  const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.js')).href);
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api/tv-status`;
  const headers = { Authorization: `Basic ${Buffer.from('admin:tv-status-test-password').toString('base64')}` };
  const check = ip => fetch(base + (ip === undefined ? '' : `?ip=${encodeURIComponent(ip)}`), { headers });
  assert.equal((await fetch(base + '?ip=192.0.2.2')).status, 401);
  assert.deepEqual(requests, []);
  assert.deepEqual(await (await check()).json(), { ok: true, online: true });
  assert.equal(requests.at(-1), 'http://192.0.2.1:8001/api/v2/');
  assert.deepEqual(await (await check('192.0.2.2')).json(), { ok: true, online: true });
  assert.equal(requests.at(-1), 'http://192.0.2.2:8001/api/v2/');
  assert.deepEqual(await (await check('2001:db8::1')).json(), { ok: true, online: true });
  assert.equal(requests.at(-1), 'http://[2001:db8::1]:8001/api/v2/');
  status = 503; // The check asks whether it responds, not whether it is paired/in Art Mode.
  assert.deepEqual(await (await check('192.0.2.2')).json(), { ok: true, online: true });
  assert.equal(cancelled, 4);
  fail = true;
  assert.deepEqual(await (await check('192.0.2.3')).json(), { ok: true, online: false });
  const count = requests.length;
  for (const ip of ['', 'not-an-ip', 'example.com', '192.0.2.2:9999', '192.0.2.2/path', 'user@192.0.2.2']) {
    assert.equal((await check(ip)).status, 400);
  }
  assert.equal(requests.length, count, 'invalid candidates never reach the network');
  assert.equal(process.env.TV_IP, '192.0.2.1');
  assert.equal(await readFile(path, 'utf8'), settings);
});

test('connection UI checks the entered IP and saves only after successful reachability', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const checkSource = html.slice(html.indexOf('    async function checkTvConnection('), html.indexOf('    async function attemptConnection('));
  const clickSource = html.slice(html.indexOf("    document.getElementById('btn-try-again').addEventListener"), html.indexOf("    document.getElementById('btn-scan-connect').addEventListener"));
  let click;
  let online = false;
  let failCheck = false;
  let failSave = false;
  const requests = [];
  const screens = [];
  const messages = [];
  let initializations = 0;
  const context = vm.createContext({
    encodeURIComponent, tvIp: '192.0.2.1', tvConnected: false,
    initialTvIpInput: { value: ' 192.0.2.2 ' }, MAIN_SCREEN: 'main-screen',
    document: { getElementById: () => ({ addEventListener: (_event, callback) => { click = callback; } }) },
    api: async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === 'GET') {
        if (failCheck) throw new Error('API unavailable');
        return { ok: true, online };
      }
      if (failSave) throw new Error('Write failed');
      return { ok: true };
    },
    toast: message => messages.push(message), showScreen: screen => screens.push(screen),
    initMainApp: () => { initializations++; },
  });
  vm.runInContext(checkSource + clickSource, context);
  await click();
  assert.equal(requests[0].path, '/api/tv-status?ip=192.0.2.2');
  assert.equal(requests.length, 1, 'ok:true, online:false must not save');
  assert.deepEqual(screens, []);
  assert.equal(context.tvIp, '192.0.2.1');
  online = true;
  failSave = true;
  await click();
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(context.tvIp, '192.0.2.1', 'failed save retains the previous address');
  assert.equal(context.tvConnected, false);
  assert.deepEqual(screens, []);
  failSave = false;
  await click();
  assert.equal(requests.at(-1).path, '/api/config');
  assert.equal(requests.at(-1).body.TV_IP, '192.0.2.2');
  assert.equal(context.tvIp, '192.0.2.2');
  assert.equal(context.tvConnected, true);
  assert.deepEqual(screens, ['main-screen']);
  assert.equal(initializations, 1);
  failCheck = true;
  assert.equal(await vm.runInContext('checkTvConnection("192.0.2.3")', context), false);
  failCheck = false;
  await vm.runInContext('checkTvConnection("2001:db8::1")', context);
  assert.equal(requests.at(-1).path, '/api/tv-status?ip=2001%3Adb8%3A%3A1');
  const count = requests.length;
  context.initialTvIpInput.value = '   ';
  await click();
  assert.equal(requests.length, count);
  assert.match(messages.at(-1), /enter a TV IP/);
});
