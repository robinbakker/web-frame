import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { png, changedPng } from './png-fixtures.mjs';

test('URL acquisition shares atomic publication, API aliases, queue, scheduler, and delivery retry behavior', async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/url-flow-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  const url = (name) => pathToFileURL(join(root, 'dist', name)).href;
  const environment = { IMAGE_SOURCE: 'png-image-url', IMAGE_URL: 'https://example.test/first', CONTENT_URL: '',
    AUTH_USER: 'admin', AUTH_PASS: 'testing-valid-password', TV_IP: '192.0.2.1', SERVER_HOST: '127.0.0.1' };
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  t.mock.module(url('env.js'), { namedExports: { loadEnv() {}, getSettingsPath: () => join(root, '.env'), getDataDir: () => join(root, 'output') } });
  t.mock.module(url('screenshot.js'), { namedExports: { screenshotUrl() { throw new Error('Browser must not load'); } } });
  const realTv = await import(url('tv.js'));
  const uploads = [];
  let failSelection = false;
  t.mock.module(url('tv.js'), { namedExports: { ...realTv, createClient: async () => ({
    inArtMode: async () => true,
    upload: async (bytes) => { uploads.push(bytes); return `id-${uploads.length}`; },
    setCurrentArt: async () => { if (failSelection) throw new Error('Selection failed'); },
    getAvailableArt: async () => [], close: async () => {},
  }) } });
  let bytes = png;
  let fail = false, release, started;
  let gate;
  const requests = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    if (String(target).startsWith('http://127.0.0.1:')) return realFetch(target, options);
    if (String(target).startsWith('http://192.0.2.1:')) return new Response('{}');
    requests.push(target);
    if (gate) { started(); await gate; gate = undefined; }
    return fail ? new Response('no', { status: 500 }) : new Response(bytes);
  });
  const app = await import(url('app.js'));
  await mkdir(join(root, 'output'));
  await writeFile(app.getDefaultImage(), 'previous-preview');
  gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const pending = app.generateImage();
  await began;
  assert.equal(await readFile(app.getDefaultImage(), 'utf8'), 'previous-preview');
  const { SettingsStore } = await import(url('settings.js'));
  const { applicationJobs } = await import(url('job-queue.js'));
  const save = applicationJobs.run(() => new SettingsStore(join(root, '.env')).save({ IMAGE_URL: 'https://example.test/second' }));
  const next = app.generateScreenshot();
  release();
  const [generated] = await Promise.all([pending, save, next]);
  assert.deepEqual(requests, ['https://example.test/first', 'https://example.test/second']);
  assert.equal(generated.hash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(app.getDefaultImage()), bytes);
  await app.runOnce();
  assert.equal((await app.runOnce()).skipped, true);
  assert.equal(uploads.length, 1);
  bytes = changedPng;
  failSelection = true;
  await assert.rejects(app.runOnce(), /Selection failed/);
  failSelection = false;
  assert.equal((await app.runOnce()).skipped, false);
  assert.equal(uploads.length, 3);
  fail = true;
  await assert.rejects(app.runOnce(), /HTTP 500/);
  assert.equal(uploads.length, 3, 'failed acquisition never uploads stale preview');
  assert.deepEqual(await readFile(app.getDefaultImage()), bytes);
  assert.equal((await readdir(join(root, 'output'))).some((name) => name.endsWith('.png') && name !== 'web-frame.png'), false);
  fail = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await app.runScheduler();
  assert.equal(uploads.length, 3, 'scheduler deduplicates downloaded bytes');
  t.mock.timers.reset();
  const { startServer } = await import(url('server.js'));
  const server = startServer(0); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Basic ${Buffer.from('admin:testing-valid-password').toString('base64')}` };
  headers['X-CSRF-Token'] = (await (await fetch(`${origin}/api/csrf`, { headers })).json()).token;
  assert.equal((await fetch(`${origin}/api/image`, { method: 'POST' })).status, 401);
  for (const route of ['/api/image', '/api/screenshot']) {
    const response = await fetch(origin + route, { method: 'POST', headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['generated_at', 'ok']);
    assert.ok(Date.parse(result.generated_at));
  }
  const preview = await fetch(`${origin}/preview.png`, { headers });
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  const config = (await (await fetch(`${origin}/api/config`, { headers })).json()).config;
  assert.equal(config.IMAGE_SOURCE, 'png-image-url'); assert.equal(config.AUTH_PASS, '');
});
