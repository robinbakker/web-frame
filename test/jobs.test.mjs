import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('scheduler, manual actions, and configuration changes share one complete-operation queue', { timeout: 10000 }, async (t) => {
  // Copy only application code into a disposable workspace; never touch real artwork or .env.
  // Keep it beneath the project so copied modules can resolve installed dependencies.
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/job-test-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  await mkdir(join(root, 'output'));
  const moduleUrl = (name) => pathToFileURL(join(root, 'dist', name)).href;
  const screenshotStarted = deferred();
  const releaseScreenshot = deferred();
  const selectionStarted = deferred();
  const releaseSelection = deferred();
  t.after(() => { releaseScreenshot.resolve(); releaseSelection.resolve(); });
  const environment = {
    CONTENT_URL: 'https://example.test/first', TV_IP: '192.0.2.1', SCHEDULE_INTERVAL: '10m',
    AUTH_USER: 'admin', AUTH_PASS: 'valid-testing-password',
  };
  for (const [key, value] of Object.entries(environment)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
  t.mock.module(moduleUrl('env.js'), { namedExports: { loadEnv: () => {} } });
  let screenshots = 0;
  let failScreenshot = false;
  const urls = [];
  t.mock.module(moduleUrl('screenshot.js'), { namedExports: {
    screenshotUrl: async (url, path) => {
      screenshots++;
      urls.push(url);
      if (screenshots === 1) {
        screenshotStarted.resolve();
        await releaseScreenshot.promise;
      }
      await writeFile(path, `image-${screenshots}`);
      if (failScreenshot) throw new Error('render failed');
      return path;
    },
  } });
  let sessions = 0;
  let maxSessions = 0;
  const uploads = [];
  const realTv = await import(moduleUrl('tv.js'));
  t.mock.module(moduleUrl('tv.js'), { namedExports: {
    ...realTv,
    createClient: async () => {
      sessions++;
      maxSessions = Math.max(maxSessions, sessions);
      return {
        inArtMode: async () => true,
        upload: async (buffer) => { uploads.push(buffer.toString()); return `app-${uploads.length}`; },
        setCurrentArt: async () => {
          if (uploads.length === 1) {
            selectionStarted.resolve();
            await releaseSelection.promise;
          }
        },
        getAvailableArt: async () => [],
        close: async () => { sessions--; },
      };
    },
  } });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true }));
  // Keep the scheduler's next timer controlled; no real minute-long background loop.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = await import(moduleUrl('app.js'));
  const { applicationJobs } = await import(moduleUrl('job-queue.js'));
  const { SettingsStore } = await import(moduleUrl('settings.js'));
  const settings = new SettingsStore(join(root, '.env'));
  await writeFile(app.DEFAULT_IMAGE, 'previous-preview');

  const first = app.runOnce();
  await screenshotStarted.promise;
  const save = applicationJobs.run(() => settings.save({ CONTENT_URL: 'https://example.test/second' }));
  const second = app.generateScreenshot();
  const upload = app.uploadAndSelect(app.DEFAULT_IMAGE);
  const cleanup = app.cleanupTvImages(5);
  const list = app.listTvImages();
  const scheduler = app.runScheduler();
  assert.equal(await readFile(app.DEFAULT_IMAGE, 'utf8'), 'previous-preview');
  assert.equal(screenshots, 1);
  assert.equal(sessions, 0);
  assert.equal(process.env.CONTENT_URL, environment.CONTENT_URL);

  releaseScreenshot.resolve();
  await selectionStarted.promise;
  assert.equal(screenshots, 1, 'the next screenshot must wait through TV selection');
  assert.equal(sessions, 1);
  assert.equal(process.env.CONTENT_URL, environment.CONTENT_URL);
  releaseSelection.resolve();
  await Promise.all([first, save, second, upload, cleanup, list, scheduler]);
  assert.equal(maxSessions, 1);
  assert.equal(sessions, 0);
  assert.deepEqual(uploads, ['image-1', 'image-2', 'image-3']);
  assert.deepEqual(urls, [environment.CONTENT_URL, 'https://example.test/second', 'https://example.test/second']);

  failScreenshot = true;
  await assert.rejects(app.generateScreenshot(), /render failed/);
  assert.equal(await readFile(app.DEFAULT_IMAGE, 'utf8'), 'image-3', 'failed rendering preserves the last preview');
  failScreenshot = false;
  await app.runOnce();
  assert.equal(await readFile(app.DEFAULT_IMAGE, 'utf8'), 'image-5', 'queue recovers after failure');
  assert.equal((await readdir(join(root, 'output'))).some((name) => name.startsWith('.screenshot-')), false);
});
