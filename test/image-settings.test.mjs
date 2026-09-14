import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../dist/settings.js';
import { resolveImageSource, validateSourceSettings } from '../dist/image-source.js';

test('source defaults and runtime URL validation agree with configuration saves', () => {
  assert.equal(resolveImageSource(), 'website-screenshot');
  assert.equal(resolveImageSource(''), 'website-screenshot');
  for (const oldValue of ['playwright', 'url']) assert.throws(() => resolveImageSource(oldValue));
  assert.equal(validateSourceSettings({ CONTENT_URL: 'https://example.test/' }), 'website-screenshot');
  assert.equal(validateSourceSettings({ IMAGE_SOURCE: 'png-image-url', IMAGE_URL: 'https://example.test/?signed=yes' }), 'png-image-url');
  for (const config of [{ IMAGE_SOURCE: 'other' }, {}, { IMAGE_SOURCE: 'png-image-url' },
    { IMAGE_SOURCE: 'png-image-url', IMAGE_URL: 'http://example.test/' },
    { IMAGE_SOURCE: 'png-image-url', IMAGE_URL: 'https://user:secret@example.test/' }]) assert.throws(() => validateSourceSettings(config));
});

test('partial admin saves work before source setup; switches validate merged values and retain inactive settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {};
  const path = join(root, '.env');
  const store = new SettingsStore(path, env);
  await store.save({ AUTH_USER: 'admin', AUTH_PASS: 'valid-test-password' });
  await store.save({ TV_IP: '192.0.2.1' });
  for (const update of [{ IMAGE_SOURCE: 'other' }, { IMAGE_SOURCE: 'png-image-url' }, { IMAGE_URL: 'https://u:secret@example.test/' }]) {
    const previous = await readFile(path, 'utf8');
    await assert.rejects(store.save(update));
    assert.equal(await readFile(path, 'utf8'), previous);
  }
  await store.save({ IMAGE_SOURCE: 'png-image-url', IMAGE_URL: 'https://example.test/?signed=a#b' });
  await store.save({ CONTENT_URL: 'https://example.test/page', CONTENT_WIDTH: '1920' });
  await assert.rejects(store.save({ CONTENT_URL: 'http://example.test/inactive' }));
  await store.save({ IMAGE_SOURCE: 'website-screenshot' });
  assert.equal(env.IMAGE_URL, 'https://example.test/?signed=a#b');
  await store.save({ IMAGE_SOURCE: 'png-image-url' });
  assert.equal(env.CONTENT_WIDTH, '1920');
  assert.equal(env.CONTENT_URL, 'https://example.test/page');
  await assert.rejects(store.save({ IMAGE_URL: '' }));
  await store.save({ AUTH_PASS: '', SCHEDULE_INTERVAL: '1h' });
  assert.equal(env.AUTH_PASS, 'valid-test-password');
});
