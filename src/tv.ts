/**
 * Samsung Frame TV communication — wraps samsung-frame-connect.
 * All TV operations go through this module.
 */

import { ArtModeEndpoint } from 'samsung-frame-connect/endpoints/art-mode.js';
import { readFile } from 'node:fs/promises';
import { ArtState } from './art-state.js';

// Typed by our local declaration for samsung-frame-connect.
export type TVClient = ArtModeEndpoint;

export type ArtItem = {
  id: string;
  width?: number;
  height?: number;
  matte: { type: string; color: string } | null;
  date?: Date;
};

export async function createClient(host: string): Promise<TVClient> {
  const oldTmpdir = process.env.TMPDIR;
  // Redirect os.tmpdir() to /app/data specifically for the TV pairing token
  process.env.TMPDIR = '/app/data';

  let client: TVClient;
  try {
    client = new ArtModeEndpoint({
      host,
      name: 'WebFrame',
      verbosity: 1,
      responseTimeout: 60,
    }) as TVClient;
  } finally {
    // Restore original TMPDIR (or delete it if it wasn't set)
    if (oldTmpdir !== undefined) {
      process.env.TMPDIR = oldTmpdir;
    } else {
      delete process.env.TMPDIR;
    }
  }
  
  // Increase max listeners to prevent memory leak warnings during retries
  client.setMaxListeners(25);
  
  // Wrap connect with timeout and error handling
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout to ${host}`)), 30000)
      ),
    ]);
  } catch (err) {
    // Clean up event listeners before throwing
    try {
      await client.close();
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
  
  return client;
}

export async function uploadImage(client: TVClient, imagePath: string): Promise<string> {
  const buffer = await readFile(imagePath);
  const contentId: string | undefined = await client.upload(buffer, {
    fileType: 'png',
    matteType: 'none',
  });
  if (!contentId) throw new Error('TV rejected the upload — check image validity');
  return contentId;
}

export async function selectImage(client: TVClient, contentId: string): Promise<void> {
  await client.setCurrentArt({ id: contentId, category: 'MY-C0002' });
}

export async function listImages(client: TVClient): Promise<ArtItem[]> {
  return client.getAvailableArt();
}

export async function deleteOldImages(client: TVClient, keep: number, state: ArtState): Promise<void> {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('keep must be a non-negative integer');
  const art: ArtItem[] = await listImages(client);
  const owned = await Promise.all(art.map((item) => state.owns(item.id)));
  const sorted = art
    .filter((item, index) => owned[index] && item.date)
    .sort((a, b) => b.date!.getTime() - a.date!.getTime());
  const toDelete = sorted.slice(keep);
  if (toDelete.length === 0) {
    console.log(`  ${sorted.length} tracked item(s) on TV — nothing to delete (keeping ${keep})`);
    return;
  }
  await client.deleteArt(toDelete.map((item: ArtItem) => item.id));
  for (const item of toDelete) await state.forgetUpload(item.id);
  console.log(`  Deleted ${toDelete.length} tracked item(s), kept ${Math.min(sorted.length, keep)}`);
}

/** Record success only after both upload and selection succeed. */
export async function deliverImage(
  client: TVClient,
  imagePath: string,
  hash: string,
  state: ArtState,
  force = false,
): Promise<{ skipped: boolean; contentId?: string }> {
  if (!force && (await state.lastHash()) === hash) return { skipped: true };
  const contentId = await uploadImage(client, imagePath);
  await state.recordUpload(contentId);
  await selectImage(client, contentId);
  await state.recordSelection(hash, contentId);
  return { skipped: false, contentId };
}

export async function setArtMode(client: TVClient, on: boolean): Promise<void> {
  await client.request({
    action: 'set_artmode_status',
    value: on ? 'on' : 'off',
  });
}
