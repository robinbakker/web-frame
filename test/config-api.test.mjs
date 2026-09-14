import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('config API saves to .env and manual .env edits take precedence on reload', { timeout: 10000 }, async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/config-api-test-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  // Avoid the global dotenv/config side effect against the developer's own cwd.
  t.mock.module('dotenv/config', { namedExports: {} });
  const base = 'AUTH_USER=admin\nAUTH_PASS=original-test-password\nCONTENT_WIDTH=1920\nDOTENV_CONFIG_QUIET=true\n';
  await writeFile(join(root, '.env'), base);
  const keys = ['AUTH_USER', 'AUTH_PASS', 'CONTENT_WIDTH', 'DOTENV_CONFIG_QUIET', 'WEB_FRAME_ENV_FILE', 'SERVER_HOST', 'SERVER_TLS_CERT', 'SERVER_TLS_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  delete process.env.WEB_FRAME_ENV_FILE;
  delete process.env.SERVER_TLS_CERT;
  delete process.env.SERVER_TLS_KEY;
  process.env.SERVER_HOST = '127.0.0.1';
  const { startServer } = await import(pathToFileURL(join(root, 'dist', 'server.js')).href);
  const server = startServer(0);
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let password = 'original-test-password';
  const { token } = await (await fetch(`${origin}/api/csrf`, {
    headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
  })).json();
  const request = (method, body) => fetch(`${origin}/api/config`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const invalid = await request('POST', { CONTENT_WIDTH: '3840', CONTENT_URL: 'https://example.test\nAUTH_USER=injected' });
  assert.equal(invalid.status, 400);
  assert.equal(process.env.CONTENT_WIDTH, '1920');
  const special = 'exact # $& " \' ` \\n password';
  const saved = await request('POST', { AUTH_PASS: special, CONTENT_WIDTH: '3840' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).config.AUTH_PASS, '');
  assert.equal((await request('GET')).status, 401, 'old credentials stop working after commit');
  password = special;
  assert.equal((await request('GET')).status, 200);
  const { loadEnv } = await import(pathToFileURL(join(root, 'dist', 'env.js')).href);
  process.env.AUTH_PASS = 'simulate-a-restart';
  process.env.CONTENT_WIDTH = '1';
  loadEnv();
  assert.equal(process.env.AUTH_PASS, special);
  assert.equal(process.env.CONTENT_WIDTH, '3840');
  assert.notEqual(await readFile(join(root, '.env'), 'utf8'), base);
  // Manual edits to the same .env file take effect when configuration is reloaded.
  await writeFile(join(root, '.env'), base.replace('1920', '2560'));
  loadEnv();
  assert.equal(process.env.CONTENT_WIDTH, '2560');
  assert.equal(process.env.AUTH_PASS, 'original-test-password');
});
