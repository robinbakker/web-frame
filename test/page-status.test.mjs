import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('an error page is never captured: the status of the page on screen counts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-page-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainFrame = { name: 'main' };
  const widgetFrame = { name: 'widget' };
  // The responses each page load gets, in order
  let responses = [];
  let screenshots = 0;
  let closed = 0;
  t.mock.module('playwright', {
    namedExports: {
      chromium: {
        launch: async () => ({
          newPage: async () => {
            const listeners = [];
            return {
              route: async () => {},
              on: (event, listener) => {
                if (event === 'response') listeners.push(listener);
              },
              mainFrame: () => mainFrame,
              goto: async () => {
                for (const { status, url, frame = mainFrame, navigation = true } of responses) {
                  const request = {
                    isNavigationRequest: () => navigation,
                    frame: () => frame,
                    resourceType: () => (navigation ? 'document' : 'image'),
                    method: () => 'GET',
                  };
                  const response = { status: () => status, url: () => url, request: () => request, body: async () => Buffer.alloc(0) };
                  for (const listener of listeners) await listener(response);
                }
              },
              waitForTimeout: async () => {},
              screenshot: async ({ path }) => {
                screenshots++;
                await writeFile(path, 'png');
              },
            };
          },
          close: async () => {
            closed++;
          },
        }),
      },
    },
  });
  const { screenshotUrl } = await import('../dist/screenshot.js');
  const { PageStatusError } = await import('../dist/content-url.js');
  const capture = () =>
    screenshotUrl('https://example.test/', join(root, 'out.png'), { PLAYWRIGHT_NETWORK_CACHE_DIR: join(root, 'cache') });

  // A 404 page, or a CDN's 5xx page: both come with a body that would render.
  for (const status of [404, 503]) {
    responses = [{ status, url: 'https://example.test/' }];
    await assert.rejects(capture(), (error) => {
      assert.ok(error instanceof PageStatusError);
      assert.equal(error.status, status);
      assert.equal(error.message, `Page answered HTTP ${status}: https://example.test/`);
      return true;
    });
  }
  assert.equal(screenshots, 0, 'nothing is captured');
  assert.equal(closed, 2, 'the browser is closed each time');

  // A missing image or a failing widget doesn't count: only the page itself does.
  responses = [
    { status: 200, url: 'https://example.test/' },
    { status: 404, url: 'https://example.test/missing.png', navigation: false },
    { status: 500, url: 'https://widget.test/', frame: widgetFrame },
  ];
  await capture();
  assert.equal(screenshots, 1);

  // A 404 page that sends the browser on to a working one (a meta refresh, or a script) is fine...
  responses = [
    { status: 404, url: 'https://example.test/' },
    { status: 200, url: 'https://example.test/?p=/' },
  ];
  await capture();
  assert.equal(screenshots, 2);

  // ...and a working page that sends it on to an error page isn't.
  responses = [
    { status: 200, url: 'https://example.test/' },
    { status: 410, url: 'https://example.test/gone' },
  ];
  await assert.rejects(capture(), { name: 'PageStatusError', status: 410 });
  assert.equal(screenshots, 2);
});
