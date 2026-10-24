import { existsSync } from 'fs';
import { mkdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { acquireImage } from './image-source.js';
import { createClient, deliverImage, listImages, deleteOldImages, TVClient } from './tv.js';
import { ArtState } from './art-state.js';
import { scanForTVs, DiscoveredTV } from './discover.js';
import { getDataDir, loadEnv } from './env.js';
import { applicationJobs } from './job-queue.js';
import { replaceFile } from './atomic-file.js';

export const getDefaultImage = (): string => join(getDataDir(), 'web-frame.png');
const stateFor = (host: string) => new ArtState(join(getDataDir(), '.tv-state'), host);

export class ImageNotFoundError extends Error {}

export function ensureEnvLoaded(): void {
  loadEnv();
}

export function getTvIp(): string {
  ensureEnvLoaded();
  return process.env.TV_IP ?? '192.168.1.100';
}

export function getContentUrl(): string | undefined {
  ensureEnvLoaded();
  return process.env.CONTENT_URL;
}

export function parseInterval(spec: string): number {
  const m = spec.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`Invalid SCHEDULE_INTERVAL "${spec}" — use e.g. 30m, 1h, 6h, 1d`);
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  return parseInt(m[1], 10) * ms;
}

export async function fileSha256(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash('sha256').update(buffer).digest('hex');
}

async function generateImageUnlocked(): Promise<{ imagePath: string; hash: string }> {
  ensureEnvLoaded();
  const settings = { ...process.env };
  const outDir = getDataDir();
  await mkdir(outDir, { recursive: true });
  const temporary = join(outDir, `.screenshot-${randomUUID()}.png`);
  const targetImage = getDefaultImage();
  try {
    await acquireImage(settings, temporary);
    const hash = await fileSha256(temporary);
    await replaceFile(temporary, targetImage);
    return { imagePath: targetImage, hash };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function generateImage(): Promise<{ imagePath: string; hash: string }> {
  return applicationJobs.run(generateImageUnlocked);
}

/** Compatibility alias: acquires from the selected source. */
export const generateScreenshot = generateImage;

async function uploadAndSelectUnlocked(imagePath: string): Promise<string> {
  if (!existsSync(imagePath)) {
    throw new ImageNotFoundError(`Image not found: ${imagePath}\nRun \"generate\" first.`);
  }

  const tvIp = getTvIp();
  const client = await createClient(tvIp);
  try {
    const result = await deliverImage(client, imagePath, await fileSha256(imagePath), stateFor(tvIp), true);
    return result.contentId!;
  } finally {
    await client.close();
  }
}

export function uploadAndSelect(imagePath: string): Promise<string> {
  return applicationJobs.run(() => uploadAndSelectUnlocked(imagePath));
}

async function listTvImagesUnlocked(): ReturnType<typeof listImages> {
  const tvIp = getTvIp();
  const client = await createClient(tvIp);
  try {
    return await listImages(client);
  } finally {
    await client.close();
  }
}

export function listTvImages(): ReturnType<typeof listImages> {
  return applicationJobs.run(listTvImagesUnlocked);
}

async function cleanupTvImagesUnlocked(keep: number): Promise<void> {
  const tvIp = getTvIp();
  const client = await createClient(tvIp);
  try {
    await deleteOldImages(client, keep, stateFor(tvIp));
  } finally {
    await client.close();
  }
}

export function cleanupTvImages(keep: number): Promise<void> {
  return applicationJobs.run(() => cleanupTvImagesUnlocked(keep));
}

export async function scanTvs(): Promise<DiscoveredTV[]> {
  return scanForTVs();
}

async function runOnceUnlocked(): Promise<{ imagePath: string; hash: string; skipped: boolean; contentId?: string }> {
  const tvIp = getTvIp();
  const { imagePath, hash } = await generateImageUnlocked();
  const state = stateFor(tvIp);
  if ((await state.lastHash()) === hash) {
    return { imagePath, hash, skipped: true };
  }
  const client = await createClient(tvIp);
  try {
    return { imagePath, hash, ...(await deliverImage(client, imagePath, hash, state)) };
  } finally {
    await client.close();
  }
}

export function runOnce(): ReturnType<typeof runOnceUnlocked> {
  return applicationJobs.run(runOnceUnlocked);
}

let schedulerPaused = false;
let schedulerStatus: string | undefined;
const statusListeners: Array<(status: string) => void> = [];

export function pauseScheduler(): void {
  schedulerPaused = true;
  setSchedulerStatus('Scheduler paused');
}

export function resumeScheduler(): void {
  schedulerPaused = false;
  setSchedulerStatus('Scheduler running');
}

export function isSchedulerPaused(): boolean {
  return schedulerPaused;
}

/** The scheduler's latest status line, shown by the desktop tray. */
export function getSchedulerStatus(): string | undefined {
  return schedulerStatus;
}

export function onSchedulerStatusChange(listener: (status: string) => void): () => void {
  statusListeners.push(listener);
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx !== -1) statusListeners.splice(idx, 1);
  };
}

function setSchedulerStatus(status: string) {
  schedulerStatus = status;
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch {
      // ignore listener error
    }
  }
}

export async function runScheduler(): Promise<void> {
  ensureEnvLoaded();
  const spec = process.env.SCHEDULE_INTERVAL ?? '10m';
  const intervalMs = parseInterval(spec);

  let lastRun = 0;
  let lastTvIp: string | undefined;
  let wasTVReady = false;

  setSchedulerStatus('Scheduler running');

  console.log(
    `Scheduler mode — checking every minute, generating every ${spec} when TV is in Art Mode (Ctrl+C to stop)\n`,
  );

  const checkAndRun = async (): Promise<void> => {
    const ts = new Date().toISOString();

    if (schedulerPaused) {
      setSchedulerStatus('Scheduler paused');
      return;
    }

    let client: TVClient | null = null;
    try {
      const tvIp = getTvIp();
      if (lastTvIp !== tvIp) wasTVReady = false;
      lastTvIp = tvIp;
      const reachable = await fetch(`http://${tvIp}:8001/api/v2/`, {
        signal: AbortSignal.timeout(3000),
      })
        .then(() => true)
        .catch(() => false);

      if (!reachable) {
        wasTVReady = false;
        setSchedulerStatus('TV offline');
        console.log(`[${ts}] TV offline — skipping.`);
        return;
      }

      client = await createClient(tvIp);
      if (!(await client.inArtMode())) {
        wasTVReady = false;
        setSchedulerStatus('TV not in Art Mode');
        console.log(`[${ts}] TV not in Art Mode — skipping.`);
        return;
      }

      const now = Date.now();
      const shouldGenerate = !wasTVReady || now - lastRun >= intervalMs;
      if (!shouldGenerate) {
        const remainingMin = Math.ceil((intervalMs - (now - lastRun)) / 60000);
        setSchedulerStatus(`TV in Art Mode (next check in ${remainingMin}m)`);
        console.log(
          `[${ts}] TV ready, but not yet time to generate (next in ${remainingMin} min).`,
        );
        return;
      }

      console.log(`[${ts}] TV in Art Mode — running...`);
      setSchedulerStatus('Capturing & uploading artwork...');
      const { imagePath, hash } = await generateImageUnlocked();

      if (!(await client.inArtMode())) {
        wasTVReady = false;
        setSchedulerStatus('TV left Art Mode during capture');
        console.log(`[${ts}] TV not in Art Mode after image generation — skipping upload.`);
        return;
      }

      const state = stateFor(tvIp);
      const result = await deliverImage(client, imagePath, hash, state);
      wasTVReady = true;
      lastRun = now;
      setSchedulerStatus(result.skipped ? 'Image unchanged' : `Art Mode updated (${result.contentId})`);
      console.log(result.skipped ? '  Image unchanged; skipping upload.' : `  Selected ${result.contentId}`);
      await deleteOldImages(client, 5, state);
      console.log('  Deleted old images.');
    } catch (err) {
      wasTVReady = false; // Retry on the next check, without waiting a full schedule interval.
      setSchedulerStatus(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`[${ts}] Run failed:`, err instanceof Error ? err.message : err);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    await applicationJobs.run(checkAndRun);
    setTimeout(tick, 60_000);
  };
  await tick();
}
