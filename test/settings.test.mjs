import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, ConfigValidationError } from '../dist/settings.js';
import { parseEnv } from '../dist/env-file.js';
import { readFileSync } from 'node:fs';

const loadSavedSettings = (path) => ({ ...parseEnv(readFileSync(path, 'utf8')) });

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'web-frame-settings-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, '.env');
  const env = { AUTH_USER: 'admin', AUTH_PASS: 'original-password-123' };
  return { root, path, env, store: new SettingsStore(path, env) };
}

test('passwords and URLs round-trip exactly, including dotenv metacharacters', async (t) => {
  const { path, store, env } = await fixture(t);
  const password = 'secure # $& $` $\' " \\n \\r ` password';
  const url = 'https://example.test/path?q=$&value=%22#fragment';
  await store.save({ AUTH_PASS: password, CONTENT_URL: url });
  assert.deepEqual(loadSavedSettings(path), { AUTH_PASS: password, CONTENT_URL: url });
  assert.equal(env.AUTH_PASS, password);
  await store.save({ AUTH_PASS: '', CONTENT_WIDTH: '1920' });
  assert.equal(loadSavedSettings(path).AUTH_PASS, password);
});

test('invalid payloads cannot change either persisted or runtime settings', async (t) => {
  const { path, store, env } = await fixture(t);
  await store.save({ CONTENT_WIDTH: '1920' });
  const previous = await fs.readFile(path, 'utf8');
  const previousEnv = { ...env };
  for (const input of [
    null, [], 'text', 42,
    { CONTENT_URL: 'https://example.test\nAUTH_USER=injected' },
    { AUTH_PASS: 'long-password\rNEW_KEY=yes' },
    { AUTH_PASS: 123 }, { AUTH_PASS: 'short' }, { AUTH_USER: '' },
    { CONTENT_WIDTH: '0' }, { CONTENT_WIDTH: '-1' }, { CONTENT_HEIGHT: '1.5' },
    { OUTPUT_HEIGHT: '999999999' }, { CONTENT_WIDTH: {} },
    { TV_IP: 'invalid address' }, { CONTENT_URL: 'file:///etc/passwd' },
    { CONTENT_URL: 'http://example.test/' },
    { SCHEDULE_INTERVAL: '0m' }, { SCHEDULE_INTERVAL: '9999999999999999999d' },
    { CONTENT_WIDTH: '3840', SERVER_HOST: '0.0.0.0' },
    JSON.parse('{"__proto__":{"AUTH_USER":"injected"}}'),
  ]) {
    await assert.rejects(store.save(input), ConfigValidationError);
    assert.equal(await fs.readFile(path, 'utf8'), previous);
    assert.deepEqual(env, previousEnv);
  }
});

test('simultaneous saves merge while keeping the existing file identity', async (t) => {
  const { root, path, store, env } = await fixture(t);
  await store.save({ CONTENT_WIDTH: '1920' });
  const linked = join(root, 'linked.env');
  await fs.link(path, linked);
  await Promise.all([
    store.save({ CONTENT_HEIGHT: '1080' }),
    store.save({ OUTPUT_WIDTH: '3840' }),
    store.save({ OUTPUT_HEIGHT: '2160' }),
    store.save({ TV_IP: '192.0.2.1' }),
    store.save({ AUTH_USER: 'new-admin' }),
  ]);
  const saved = loadSavedSettings(path);
  assert.deepEqual(saved, {
    CONTENT_WIDTH: '1920', CONTENT_HEIGHT: '1080', OUTPUT_WIDTH: '3840',
    OUTPUT_HEIGHT: '2160', TV_IP: '192.0.2.1', AUTH_USER: 'new-admin',
  });
  assert.equal(env.AUTH_USER, saved.AUTH_USER);
  assert.deepEqual(loadSavedSettings(linked), saved, 'saves must update the original file, not replace it');
});

test('failed opening preserves the file and runtime and allows retry', async (t) => {
  const { root, path, env } = await fixture(t);
  await fs.writeFile(path, 'CONTENT_WIDTH=1920\n');
  const before = { ...env };
  let fail = true;
  const mocked = t.mock.module('node:fs/promises', {
    namedExports: { ...fs, open: async (...args) => {
      assert.deepEqual(env, before, 'runtime changes must wait for the save');
      if (fail) throw Object.assign(new Error('simulated disk error'), { code: 'EIO' });
      return fs.open(...args);
    } },
  });
  const { SettingsStore: FaultStore } = await import('../dist/settings.js?disk-failure');
  const store = new FaultStore(path, env);
  await assert.rejects(store.save({ CONTENT_WIDTH: '3840' }), /simulated disk error/);
  assert.equal(await fs.readFile(path, 'utf8'), 'CONTENT_WIDTH=1920\n');
  assert.deepEqual(env, before);
  assert.deepEqual(await fs.readdir(root), ['.env']);
  fail = false;
  await store.save({ CONTENT_WIDTH: '3840' });
  assert.equal(env.CONTENT_WIDTH, '3840');
  mocked.restore();
});

test('a write failure leaves runtime unchanged and closes the file handle', async (t) => {
  const { path, env } = await fixture(t);
  await fs.writeFile(path, 'CONTENT_WIDTH=1920\n');
  const before = { ...env };
  let closed = false;
  t.mock.module('node:fs/promises', {
    namedExports: { ...fs, open: async () => ({
      writeFile: async () => { throw new Error('simulated interrupted write'); },
      sync: async () => assert.fail('a failed write must not reach sync'),
      close: async () => { closed = true; },
    }) },
  });
  const { SettingsStore: FaultStore } = await import('../dist/settings.js?write-failure');
  await assert.rejects(new FaultStore(path, env).save({ CONTENT_WIDTH: '3840' }), /simulated interrupted write/);
  assert.equal(closed, true);
  assert.deepEqual(env, before);
});

test('corrupt saved settings fail closed without disclosing password contents', async (t) => {
  const { path, store } = await fixture(t);
  const corrupt = 'AUTH_PASS="secret-password-do-not-log';
  await fs.writeFile(path, corrupt);
  await assert.rejects(store.save({ CONTENT_WIDTH: '1920' }), { message: 'Invalid .env syntax; check assignments and closing quotes' });
  assert.throws(() => loadSavedSettings(path), { message: 'Invalid .env syntax; check assignments and closing quotes' });
  assert.equal(await fs.readFile(path, 'utf8'), corrupt);
});

test('saves preserve comments, other settings, and replace duplicate or multiline assignments safely', async (t) => {
  const { path, store } = await fixture(t);
  await fs.writeFile(path, '# Keep this comment\nEXTRA=value\nAUTH_USER=old\nexport AUTH_USER=admin\nAUTH_PASS="old\nmultiline-password"\n');
  await store.save({ AUTH_USER: 'new-admin', AUTH_PASS: 'new-safe-password-123' });
  const text = await fs.readFile(path, 'utf8');
  assert.ok(text.startsWith('# Keep this comment\nEXTRA=value\n'));
  assert.equal(loadSavedSettings(path).AUTH_USER, 'new-admin');
  assert.equal(loadSavedSettings(path).AUTH_PASS, 'new-safe-password-123');
  assert.equal(loadSavedSettings(path).EXTRA, 'value');
});
