import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { png } from './png-fixtures.mjs';
import { downloadImage, validatePngHeader, IMAGE_LIMITS } from '../dist/image-download.js';

test('PNG header checks reject other formats, incomplete headers and excessive declared dimensions', () => {
  validatePngHeader(png);
  const sized = (width, height) => {
    const bytes = Buffer.from(png);
    bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const wrongHeader = Buffer.from(png); wrongHeader.write('IDAT', 12);
  const wrongLength = Buffer.from(png); wrongLength.writeUInt32BE(12, 8);
  for (const bytes of [Buffer.from('<html>'), Buffer.from([255, 216, 255]), png.subarray(0, 32),
    wrongHeader, wrongLength, sized(0, 2), sized(2, 0), sized(16385, 1), sized(1, 16385), sized(8192, 8192)]) {
    assert.throws(() => validatePngHeader(bytes));
  }
});

test('header checks intentionally do not validate PNG payload or checksums', () => {
  const corrupt = Buffer.from(png); corrupt[40] ^= 1;
  validatePngHeader(corrupt);
  validatePngHeader(png.subarray(0, 33));
});

test('downloads preserve bytes, accept MIME fallbacks and revalidate through HTTPS relative redirects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mime of ['image/png', 'application/octet-stream', null]) {
    let calls = 0;
    const redirectBody = new ReadableStream({ cancel() { calls += 10; } });
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.cache, 'no-store');
      assert.match(options.headers['Cache-Control'], /no-cache/);
      if (calls++ === 0) return new Response(redirectBody, { status: 302, headers: { Location: '/extensionless?signature=private' } });
      assert.equal(url, 'https://example.test/extensionless?signature=private');
      return new Response(png, { headers: mime ? { 'Content-Type': mime } : {} });
    });
    const path = join(root, 'image.png');
    await downloadImage('https://example.test/image', path);
    assert.deepEqual(await readFile(path), png);
    assert.equal(calls, 12, 'unused redirect body cancelled');
    fetchMock.mock.restore();
  }
});

test('download failures reject without writing an image or exposing upstream secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    () => new Response('failure', { status: 503 }),
    () => new Response(png, { status: 206 }),
    () => new Response(null),
    () => new Response(png, { headers: { 'Content-Length': String(IMAGE_LIMITS.bytes + 1) } }),
    () => new Response(png, { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(png, { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(Buffer.from([255, 216, 255])),
    () => new Response(null, { status: 302, headers: { Location: 'http://example.test/?secret=private' } }),
    () => new Response(null, { status: 302, headers: { Location: 'https://user:private@example.test/' } }),
    () => new Response(null, { status: 302, headers: { Location: '/loop' } }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(png); c.error(new Error('Image private secret')); } })),
    () => { throw new Error('Image private secret'); },
    () => { let count = 0; return new Response(new ReadableStream({ pull(c) {
      if (count++ < 33) c.enqueue(new Uint8Array(1024 * 1024)); else c.close();
    } }), { headers: { 'Content-Length': '1' } }); },
  ];
  for (const [index, response] of cases.entries()) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => response());
    const path = join(root, `${index}.png`);
    await assert.rejects(downloadImage('https://example.test/?secret=private', path), (error) => !error.message.includes('private'));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    fetchMock.mock.restore();
  }
  for (const url of ['http://example.test/', 'https://user:private@example.test/', 'bad']) {
    await assert.rejects(downloadImage(url, join(root, 'invalid.png')), /IMAGE_URL/);
  }
});

test('one deadline covers fetch, redirects, and a stalled body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => { assert.equal(ms, 60_000); return timeout(20); });
  // AbortSignal.timeout is unref'd; keep the test process alive while waiting.
  const timer = setInterval(() => {}, 1000); t.after(() => clearInterval(timer));
  for (const bodyStalls of [false, true]) {
    let calls = 0;
    const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
      if (calls++ === 0) return new Response(null, { status: 302, headers: { Location: '/next' } });
      if (!bodyStalls) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(png); signal.addEventListener('abort', () => c.error(signal.reason));
      } }));
    });
    await assert.rejects(downloadImage('https://example.test/', join(root, 'image.png')), /timed out/);
    fetchMock.mock.restore();
  }
});
