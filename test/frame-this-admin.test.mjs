import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN = `ftd_${'a'.repeat(43)}`;
const REFUSED_TOKEN = `ftd_${'b'.repeat(43)}`;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PASSWORD = 'admin-ui-test-password';

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

async function tempRoot(t, prefix) {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL(`../output/${prefix}-`, import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  await cp(new URL('../public/', import.meta.url), join(root, 'public'), { recursive: true });
  await cp(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  return { root, moduleUrl: (name) => pathToFileURL(join(root, 'dist', name)).href };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the admin UI links to Frame This, then shows the Frame This page until it unlinks', { timeout: 10000 }, async (t) => {
  const { root, moduleUrl } = await tempRoot(t, 'frame-this-admin');
  // WEB_FRAME_DATA_DIR holds the .env too, next to the token file.
  await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', '.env'), `AUTH_USER=admin\nAUTH_PASS=${PASSWORD}\nDOTENV_CONFIG_QUIET=true\n`);
  setEnv(t, {
    AUTH_USER: undefined, AUTH_PASS: undefined, DOTENV_CONFIG_QUIET: undefined, WEB_FRAME_ENV_FILE: undefined,
    SERVER_HOST: '127.0.0.1', SERVER_TLS_CERT: undefined, SERVER_TLS_KEY: undefined,
    FRAME_THIS_TOKEN: undefined, FRAME_THIS_DEV_ORIGIN: undefined, WEB_FRAME_DATA_DIR: join(root, 'data'),
  });
  t.mock.module('dotenv/config', { exports: {} });

  // The scheduler itself is tested below: here, only whether the server switches it.
  let restarts = 0;
  let forcedRuns = 0;
  const realApp = await import(moduleUrl('app.js'));
  t.mock.module(moduleUrl('app.js'), {
    namedExports: {
      ...realApp,
      restartScheduler: async () => { restarts++; },
      runConnectedCheck: async () => { forcedRuns++; },
    },
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (!String(url).includes('/api/device/v1/')) return realFetch(url, init);
    const accepted = init.headers.Authorization === `Bearer ${TOKEN}`;
    return accepted ? json(200, { protocolVersion: 1, tvs: [] }) : json(401, { error: 'unauthorized' });
  });

  const { startServer } = await import(moduleUrl('server.js'));
  const server = startServer(0, { frameThis: true });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`;
  const { token: csrf } = await (await realFetch(`${origin}/api/csrf`, { headers: { Authorization: authorization } })).json();
  const request = (method, path, body) => realFetch(`${origin}${path}`, {
    method,
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const page = async () => (await request('GET', '/')).text();
  const tokenFile = join(root, 'data', 'frame-this-token');

  const config = await (await request('GET', '/api/config')).json();
  assert.equal(config.version, VERSION);
  assert.deepEqual(config.frameThis, { available: true, connected: false });
  assert.match(await page(), /id="config-form"/);

  const notACode = await request('POST', '/api/frame-this/connect', { token: 'ftd_short' });
  assert.equal(notACode.status, 400);
  assert.match((await notACode.json()).error, /isn't a connect code/);
  const refused = await request('POST', '/api/frame-this/connect', { token: REFUSED_TOKEN });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /doesn't accept this code/);
  assert.equal(existsSync(tokenFile), false, 'a refused code is not saved');
  assert.equal(restarts, 0);

  const linked = await request('POST', '/api/frame-this/connect', { token: ` ${TOKEN} ` });
  assert.equal(linked.status, 200);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), TOKEN);
  assert.equal(restarts, 1, 'the scheduler switches to connected mode');

  const bridge = await page();
  assert.match(bridge, /Connected to Frame This/);
  assert.match(bridge, new RegExp(`src="bridge\\.js\\?v=${VERSION.replace(/\./g, '\\.')}"`));
  const state = await (await request('GET', '/api/frame-this')).json();
  assert.equal(state.connected, true);
  assert.equal(state.version, VERSION);
  assert.ok(!JSON.stringify(state).includes(TOKEN), 'the code never goes back to the browser');
  assert.ok(!JSON.stringify(await (await request('GET', '/api/config')).json()).includes(TOKEN));
  assert.equal((await request('POST', '/api/upload')).status, 409, 'Frame This decides what the TVs show');
  assert.equal((await request('POST', '/api/image')).status, 409);
  assert.equal((await request('POST', '/api/run')).status, 200);
  assert.equal(forcedRuns, 1, 'Run now renders what Frame This says');

  const unlinked = await request('POST', '/api/frame-this/disconnect');
  assert.equal(unlinked.status, 200);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(restarts, 2, 'the scheduler switches back to standalone mode');
  assert.match(await page(), /id="config-form"/);
  assert.equal((await request('POST', '/api/frame-this/disconnect')).status, 409, 'nothing left to unlink');

  // FRAME_THIS_TOKEN belongs to whoever starts Web Frame: the admin UI can't change it.
  process.env.FRAME_THIS_TOKEN = TOKEN;
  assert.deepEqual((await (await request('GET', '/api/config')).json()).frameThis, { available: false, connected: true });
  assert.equal((await request('POST', '/api/frame-this/connect', { token: TOKEN })).status, 409);
  assert.equal((await request('POST', '/api/frame-this/disconnect')).status, 409);
  assert.equal(restarts, 2);
});

test('linking and unlinking switches the scheduler loop without a restart', { timeout: 10000 }, async (t) => {
  const { root, moduleUrl } = await tempRoot(t, 'frame-this-switch');
  setEnv(t, {
    TV_IP: '192.168.1.50', SCHEDULE_INTERVAL: '10m',
    FRAME_THIS_TOKEN: undefined, FRAME_THIS_DEV_ORIGIN: undefined, WEB_FRAME_DATA_DIR: join(root, 'data'),
  });
  const realEnv = await import(moduleUrl('env.js'));
  t.mock.module(moduleUrl('env.js'), { exports: { ...realEnv, loadEnv: () => {} } });
  const realDiscover = await import(moduleUrl('discover.js'));
  t.mock.module(moduleUrl('discover.js'), { exports: { ...realDiscover, findSamsungTvs: async () => [] } });
  // A standalone check asks the TV first; a connected one asks Frame This.
  let tvChecks = 0;
  let configPolls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes(':8001/api/v2/')) {
      tvChecks++;
      throw new Error('offline');
    }
    if (String(url).includes('/api/device/v1/config')) {
      configPolls++;
      return json(200, { protocolVersion: 1, latestVersion: VERSION, minVersion: null, pollAfter: 60, tvs: [] });
    }
    return json(200, {});
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const app = await import(moduleUrl('app.js'));
  const { applicationJobs } = await import(moduleUrl('job-queue.js'));
  const { saveFrameThisToken, removeFrameThisToken } = await import(moduleUrl('frame-this.js'));
  const nextMinute = async () => {
    t.mock.timers.tick(60_000);
    await applicationJobs.run(async () => {});
  };

  await app.runScheduler();
  assert.equal(tvChecks, 1);

  await saveFrameThisToken(TOKEN);
  await app.restartScheduler();
  assert.equal(configPolls, 1, 'connected right away');
  await nextMinute();
  assert.equal(tvChecks, 1, 'the standalone loop stopped');

  await removeFrameThisToken();
  await app.restartScheduler();
  assert.equal(tvChecks, 2, 'standalone again right away');
  const polls = configPolls;
  await nextMinute();
  assert.equal(tvChecks, 3);
  assert.equal(configPolls, polls, 'the connected loop stopped');

  // Starting again replaces the loop rather than adding one.
  await app.restartScheduler();
  assert.equal(tvChecks, 4);
  await nextMinute();
  assert.equal(tvChecks, 5);
});
