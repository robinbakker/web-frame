import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtState } from '../dist/art-state.js';
import { deliverImage, deleteOldImages } from '../dist/tv.js';
import { authenticate, validateCredentials } from '../dist/auth.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = join(root, 'image.png');
  await writeFile(image, 'mock image');
  return { root, image, state: new ArtState(root, 'tv-a') };
}

for (const stage of ['upload', 'selection']) {
  test(`failed ${stage} is retried, successful delivery is deduplicated across restarts`, async (t) => {
    const { root, image, state } = await fixture(t);
    let attempts = 0;
    let fail = true;
    const client = {
      upload: async () => {
        attempts++;
        if (fail && stage === 'upload') throw new Error('offline');
        return 'app-image';
      },
      setCurrentArt: async () => {
        if (fail && stage === 'selection') throw new Error('offline');
      },
    };
    await assert.rejects(deliverImage(client, image, 'hash', state), /offline/);
    assert.equal(await state.lastHash(), undefined);
    fail = false;
    assert.equal((await deliverImage(client, image, 'hash', state)).skipped, false);
    assert.equal((await deliverImage(client, image, 'hash', new ArtState(root, 'tv-a'))).skipped, true);
    assert.equal(attempts, 2);
    // The same image still needs delivery to a different television.
    assert.equal((await deliverImage(client, image, 'hash', new ArtState(root, 'tv-b'))).skipped, false);
  });
}

test('cleanup preserves personal and untracked images, isolates TVs, and invalidates deleted selections', async (t) => {
  const { root, state } = await fixture(t);
  const art = ['personal', 'untracked', 'app-old', 'app-new'].map((id, index) => ({
    id, date: new Date(2026, 0, index + 1),
  }));
  const deleted = [];
  const client = { getAvailableArt: async () => art, deleteArt: async (ids) => deleted.push(...ids) };
  await state.recordUpload('app-old');
  await state.recordUpload('app-new');
  await state.recordSelection('hash', 'app-new');
  await deleteOldImages(client, 0, new ArtState(root, 'tv-b'));
  assert.deepEqual(deleted, []);
  await deleteOldImages(client, 1, state);
  assert.deepEqual(deleted, ['app-old']);
  assert.equal(await state.owns('app-old'), false);
  await deleteOldImages(client, 0, state);
  assert.deepEqual(deleted, ['app-old', 'app-new']);
  assert.equal(await state.lastHash(), undefined);
  await assert.rejects(deleteOldImages(client, -1, state), /non-negative integer/);
  await assert.rejects(deleteOldImages(client, 0.5, state), /non-negative integer/);
});

test('failed ownership persistence never marks an upload successful', async (t) => {
  const { root, image } = await fixture(t);
  const blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'file');
  const state = new ArtState(blocked, 'tv');
  let selected = false;
  await assert.rejects(deliverImage({ upload: async () => 'id', setCurrentArt: async () => { selected = true; } }, image, 'hash', state));
  assert.equal(selected, false);
  assert.equal(await state.lastHash(), undefined);
  assert.equal(await state.owns('id'), false);
});

test('admin authentication fails closed and accepts an explicit strong credential', () => {
  const header = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  for (const pass of [undefined, '', 'short', '                ']) {
    assert.throws(() => validateCredentials('webframe', pass));
    assert.equal(authenticate(header('webframe', pass), 'webframe', pass), false);
  }
  const pass = 'a-unique:test-password-42';
  assert.equal(authenticate(header('admin', pass), 'admin', pass), true);
  assert.equal(authenticate(header('other', pass), 'admin', pass), false);
  assert.equal(authenticate(header('admin', 'wrong'), 'admin', pass), false);
  assert.equal(authenticate(undefined, 'admin', pass), false);
  assert.throws(() => validateCredentials('admin:invalid', pass));
});
