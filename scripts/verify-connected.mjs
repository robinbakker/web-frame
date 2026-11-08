// Checks the connected-mode render guards (docs/frame-this-protocol.md, "Guards") in a real browser,
// against a local mock Frame This that serves a hostile display page. Run after `npm run build`:
//   node scripts/verify-connected.mjs              Playwright, as in Docker and the CLI
//   npx electron scripts/verify-connected.mjs      Electron's offscreen capture, as in the desktop app
// The page tries to reach a second local server (standing in for the LAN) in every way that works
// without JavaScript, and runs a script. None of it may arrive. An error page is never captured either.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function verify(isElectron) {
  const hits = [];
  const lan = createServer((req, res) => {
    hits.push(`lan ${req.method} ${req.url}`);
    res.end('lan');
  });
  const lanPort = await listen(lan);
  const lanUrl = `http://127.0.0.1:${lanPort}`;

  const frameThis = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    hits.push(`frame-this ${path}`);
    if (path === '/@test/guards') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': `frame-src 'none'; report-uri ${lanUrl}/csp-report`,
      });
      res.end(`<!doctype html>
        <meta http-equiv="refresh" content="1;url=${lanUrl}/meta-refresh">
        <link rel="stylesheet" href="/style.css">
        <img src="/allowed.png">
        <img src="${lanUrl}/direct">
        <img src="http://localhost:${lanPort}/direct-localhost">
        <img src="/redirect">
        <iframe src="${lanUrl}/frame"></iframe>
        <script>new Image().src = '/js-ran'; document.title = 'js';</script>`);
    } else if (path === '/style.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(`body { background: url(${lanUrl}/css-background) }`);
    } else if (path === '/redirect') {
      res.writeHead(302, { Location: `${lanUrl}/via-redirect` });
      res.end();
    } else if (path === '/@test/missing') {
      // A 404 page with a body, which renders like any other page
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><body style="background: #c33"><h1>404 Not Found</h1>');
    } else if (path === '/@test/moved') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><meta http-equiv="refresh" content="0;url=/@test/found"><h1>Moved</h1>');
    } else if (path === '/@test/found') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><h1>Found</h1>');
    } else if (path === '/allowed.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  // localhost, like wrangler dev (BETTER_AUTH_URL)
  const origin = `http://localhost:${await listen(frameThis)}`;

  // The bridge's origins point at the mock (only a loopback origin is accepted for this).
  process.env.FRAME_THIS_DEV_ORIGIN = origin;
  const { connectedRenderPolicy } = await import('../dist/frame-this.js');
  const capture = isElectron
    ? (await import('../dist/electron/offscreen-capture.js')).captureOffscreen
    : (await import('../dist/screenshot.js')).screenshotUrl;

  const root = await mkdtemp(join(tmpdir(), 'web-frame-guards-'));
  try {
    const output = join(root, 'guards.png');
    const settings = {
      CONTENT_WIDTH: '1280',
      CONTENT_HEIGHT: '720',
      OUTPUT_WIDTH: '640',
      PLAYWRIGHT_NETWORK_CACHE_DIR: join(root, 'cache'),
    };
    const policy = connectedRenderPolicy();

    await assert.rejects(capture(`${lanUrl}/@test/guards`, output, settings, { policy }), /allowed origins/);
    await capture(`${origin}/@test/guards?exp=1&sig=test`, output, settings, { policy });
    // The meta refresh fires a second after load: give it time to try.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const image = await readFile(output);
    assert.equal(image.readUInt32BE(16), 640, 'rendered at OUTPUT_WIDTH');
    for (const path of ['/@test/guards', '/style.css', '/allowed.png', '/redirect']) {
      assert.ok(hits.includes(`frame-this ${path}`), `${path} loads from the allowed origin`);
    }
    assert.ok(!hits.includes('frame-this /js-ran'), 'the page script did not run');
    assert.deepEqual(hits.filter((hit) => hit.startsWith('lan ')), [], 'nothing reached the "LAN" server');

    const missing = join(root, 'missing.png');
    await assert.rejects(capture(`${origin}/@test/missing?exp=1&sig=test`, missing, settings, { policy }), {
      name: 'PageStatusError',
      status: 404,
    });
    await assert.rejects(stat(missing), { code: 'ENOENT' }, 'the 404 page was not captured');
    // The page on screen counts: this 404 page sends the browser on to a working one.
    await capture(`${origin}/@test/moved?exp=1&sig=test`, join(root, 'moved.png'), settings, { policy });
    assert.ok(hits.includes('frame-this /@test/found'), 'the meta refresh was followed');
    console.log(`${isElectron ? 'Electron' : 'Playwright'}: the guards held. Requests made:\n  ${hits.join('\n  ')}`);
    return true;
  } catch (error) {
    console.error(error);
    console.error(`Requests made:\n  ${hits.join('\n  ')}`);
    return false;
  } finally {
    lan.close();
    frameThis.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.versions.electron) {
  // Electron holds back 'ready' until this module finishes loading, so don't await it at the top level.
  const { app } = await import('electron');
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => app.exit((await verify(true)) ? 0 : 1));
} else {
  process.exitCode = (await verify(false)) ? 0 : 1;
}
