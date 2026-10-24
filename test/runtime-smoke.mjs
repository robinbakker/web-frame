import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { bytes } from './runtime-mocks.mjs';
const require = createRequire(import.meta.url);
for (const name of ['playwright', 'playwright-core', 'tsx', 'typescript']) {
  assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
}
assert.equal(process.env.NODE_PATH, '');
await assert.rejects(readdir(process.env.PLAYWRIGHT_BROWSERS_PATH), { code: 'ENOENT' });
const { startServer } = await import('./dist/server.js');
const app = await import('./dist/app.js');
const server = startServer(0); await once(server, 'listening');
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Basic ${Buffer.from('admin:runtime-testing-password').toString('base64')}` };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200);
  headers['X-CSRF-Token'] = (await (await fetch(`${base}/api/csrf`, { headers })).json()).token;
  assert.equal((await fetch(`${base}/api/image`, { method: 'POST', headers })).status, 200);
  const preview = await fetch(`${base}/preview.png`, { headers });
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
  await app.listTvImages();
  await app.uploadAndSelect(app.getDefaultImage());
  assert.deepEqual(await readFile(app.getDefaultImage()), bytes);
  const { screenshotUrl } = await import('./dist/screenshot.js');
  await assert.rejects(screenshotUrl('https://example.test/', app.getDefaultImage(), {
    PLAYWRIGHT_NETWORK_CACHE_DIR: './output/cache',
  }), /Playwright is not installed.*optional dependencies/);
  // The admin remains usable after a missing-package acquisition failure.
  assert.equal((await fetch(`${base}/api/config`, { headers })).status, 200);
} finally {
  await new Promise((done) => { server.close(done); server.closeAllConnections(); });
}
