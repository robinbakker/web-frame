import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('missing Chromium has an installation hint; launch and capture errors retain their meaning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-browser-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launchError = new Error("browserType.launch: Executable doesn't exist at /missing/browser");
  let closed = false;
  t.mock.module('playwright', { namedExports: { chromium: { launch: async (options) => {
    assert.equal(options.chromiumSandbox, true);
    if (launchError) throw launchError;
    return { newPage: async () => ({
      route: async () => {}, on() {}, goto: async () => { throw new Error('Page navigation timed out'); },
    }), close: async () => { closed = true; } };
  } } } });
  const { screenshotUrl } = await import('../dist/screenshot.js');
  const acquire = () => screenshotUrl('https://example.test/', join(root, 'image.png'), { PLAYWRIGHT_NETWORK_CACHE_DIR: join(root, 'cache') });
  await assert.rejects(acquire(), /Chromium headless shell is not installed.*npx playwright install/);
  launchError = new Error('No usable sandbox!');
  await assert.rejects(acquire(), /No usable sandbox!/);
  launchError = undefined;
  await assert.rejects(acquire(), /Page navigation timed out/);
  assert.equal(closed, true);
});
