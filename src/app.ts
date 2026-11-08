import { existsSync } from 'fs';
import { mkdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { acquireImage, captureWebsite } from './image-source.js';
import { PageStatusError } from './content-url.js';
import { createClient, deliverImage, listImages, deleteOldImages, TVClient } from './tv.js';
import { ArtState } from './art-state.js';
import { scanForTVs, DiscoveredTV, findSamsungTvs, probeSamsungTv, SamsungTV } from './discover.js';
import { getDataDir, loadEnv } from './env.js';
import { applicationJobs } from './job-queue.js';
import { replaceFile } from './atomic-file.js';
import {
  FrameThisConnection,
  connectedRenderPolicy,
  isPrivateIpv4,
  readFrameThisToken,
  renderReason,
  versionNotice,
  type DeviceStatus,
  type LinkProblem,
  type TvConfig,
} from './frame-this.js';

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

/** Acquires into a temporary file and only then replaces the current image, so a failure keeps the last one. */
async function publishImage(acquire: (outputPath: string) => Promise<void>): Promise<{ imagePath: string; hash: string }> {
  const outDir = getDataDir();
  await mkdir(outDir, { recursive: true });
  const temporary = join(outDir, `.screenshot-${randomUUID()}.png`);
  const targetImage = getDefaultImage();
  try {
    await acquire(temporary);
    const hash = await fileSha256(temporary);
    await replaceFile(temporary, targetImage);
    return { imagePath: targetImage, hash };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function generateImageUnlocked(): Promise<{ imagePath: string; hash: string }> {
  ensureEnvLoaded();
  const settings = { ...process.env };
  return publishImage((outputPath) => acquireImage(settings, outputPath));
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
  if (readFrameThisToken()) return runConnectedScheduler();
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
      // Logs its own outcome ("nothing to delete" or "Deleted N tracked item(s)").
      await deleteOldImages(client, 5, state);
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

// ---------------------------------------------------------------------------
// Connected mode: Frame This decides what each TV shows and when (frame-this.ts)
// ---------------------------------------------------------------------------

/** What the bridge knows about a TV in the config, for the status it reports. */
interface ConnectedTv {
  /** The last render that reached the TV, or was skipped there as unchanged. */
  rendered?: { at: number; contentVersion: string };
  reachable: boolean;
  artMode: boolean | null;
  info?: SamsungTV;
  lastUploadAt: number | null;
  lastError: { at: number; message: string } | null;
}

const connection = new FrameThisConnection();
const connectedTvs = new Map<string, ConnectedTv>();
let discoveredTvs: SamsungTV[] = [];
let lastDiscoveryAt: number | null = null;
let lastPollError: string | null = null;
let lastLinkProblem: LinkProblem | null = null;
let lastNotice: string | null = null;

// Discovery finds the TVs the user picks from in Frame This: often while none is assigned, rarely after.
const DISCOVERY_INTERVAL_MS = { unassigned: 10 * 60_000, assigned: 6 * 60 * 60_000 };
// A display URL with less than this left is fetched again before rendering.
const DISPLAY_URL_MARGIN_MS = 2 * 60_000;
// A display page answers 404 once its signature has run out: on a slow check, or when this computer's
// clock is behind. The other statuses are taken the same way. A new link may still work.
const DISPLAY_LINK_STATUSES = new Set([401, 403, 404, 410]);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function linkProblemMessage(problem: LinkProblem): string {
  return problem === 'unlinked'
    ? 'Unlinked: link this bridge again in Frame This'
    : 'FRAME_THIS_TOKEN is not a Frame This connect code';
}

/** This TV's entry in a config fetched now, or the one given when Frame This has nothing newer. */
async function refetchTv(tv: TvConfig): Promise<TvConfig> {
  await connection.poll(Date.now(), true);
  return connection.config?.tvs.find((other) => other.tvIp === tv.tvIp) ?? tv;
}

/** Renders a TV's display page. It's laid out for a 3840×2160 viewport; 1920×1080 renders it at scale 0.5. */
function captureDisplay(tv: TvConfig): Promise<{ imagePath: string; hash: string }> {
  const [width, height] = tv.size.split('x');
  const settings = {
    ...process.env,
    CONTENT_WIDTH: '3840',
    CONTENT_HEIGHT: '2160',
    OUTPUT_WIDTH: width,
    OUTPUT_HEIGHT: height,
  };
  return publishImage((outputPath) =>
    captureWebsite(tv.displayUrl, outputPath, settings, { policy: connectedRenderPolicy() }),
  );
}

async function renderConnectedTv(tv: TvConfig, now: number, force: boolean): Promise<void> {
  const ts = new Date(now).toISOString();
  let entry = connectedTvs.get(tv.tvIp);
  if (!entry) {
    entry = { reachable: false, artMode: null, lastUploadAt: null, lastError: null };
    connectedTvs.set(tv.tvIp, entry);
  }
  const status = (message: string) => {
    setSchedulerStatus(message);
    console.log(`[${ts}] ${tv.tvIp}: ${message}`);
  };

  // The config could name any address: only a host that answers as a Samsung TV is ever connected to.
  const info = await probeSamsungTv(tv.tvIp);
  entry.reachable = info !== null;
  if (!info) {
    entry.artMode = null;
    status('TV offline');
    return;
  }
  entry.info = info;

  let client: TVClient | null = null;
  try {
    client = await createClient(tv.tvIp);
    entry.artMode = await client.inArtMode();
    if (!entry.artMode) {
      status('TV not in Art Mode');
      return;
    }
    const reason = force ? 'run now' : renderReason(tv, entry.rendered, now);
    if (!reason) {
      status('TV in Art Mode');
      return;
    }

    let current = tv;
    if (Date.now() >= current.displayUrlExpiresAt - DISPLAY_URL_MARGIN_MS) current = await refetchTv(current);
    // The page would be a 404 by now.
    if (Date.now() >= current.displayUrlExpiresAt) {
      throw new Error("The display link expired, and Frame This can't be reached for a new one");
    }

    console.log(`[${ts}] ${tv.tvIp}: TV in Art Mode — rendering (${reason})...`);
    setSchedulerStatus('Capturing & uploading artwork...');
    let image: { imagePath: string; hash: string };
    try {
      image = await captureDisplay(current);
    } catch (error) {
      if (!(error instanceof PageStatusError && DISPLAY_LINK_STATUSES.has(error.status))) throw error;
      // Once, with a new link. Without one, the next check tries again.
      const fresh = await refetchTv(current);
      if (fresh.displayUrl === current.displayUrl) throw error;
      console.log(`[${ts}] ${tv.tvIp}: the display page answered HTTP ${error.status}; trying a new link...`);
      current = fresh;
      image = await captureDisplay(current);
    }
    const { imagePath, hash } = image;

    if (!(await client.inArtMode())) {
      entry.artMode = false;
      status('TV left Art Mode during capture');
      return;
    }
    const state = stateFor(tv.tvIp);
    const result = await deliverImage(client, imagePath, hash, state);
    entry.rendered = { at: now, contentVersion: current.contentVersion };
    if (!result.skipped) entry.lastUploadAt = Date.now();
    entry.lastError = null;
    status(result.skipped ? 'Image unchanged' : 'Art Mode updated');
    await deleteOldImages(client, 5, state);
  } catch (error) {
    // Without the long signed URL, which says nothing more once it has expired.
    const message =
      error instanceof PageStatusError
        ? `Frame This answered HTTP ${error.status} for the display page`
        : errorMessage(error);
    entry.lastError = { at: Date.now(), message: message.slice(0, 500) };
    setSchedulerStatus(`Check failed: ${message}`);
    console.error(`[${ts}] ${tv.tvIp}: run failed:`, message);
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function discoverTvs(now: number, unassigned: boolean): Promise<void> {
  const interval = unassigned ? DISCOVERY_INTERVAL_MS.unassigned : DISCOVERY_INTERVAL_MS.assigned;
  if (lastDiscoveryAt !== null && now - lastDiscoveryAt < interval) return;
  lastDiscoveryAt = now;
  try {
    discoveredTvs = (await findSamsungTvs()).filter((tv) => isPrivateIpv4(tv.ip));
  } catch (error) {
    console.error('TV discovery failed:', errorMessage(error));
  }
}

function connectedStatus(): DeviceStatus {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  // Configured TVs that answered as Samsung TVs count as discovered too.
  const discovered = new Map(discoveredTvs.map((tv) => [tv.ip, tv]));
  for (const [ip, tv] of connectedTvs) if (tv.info) discovered.set(ip, tv.info);
  return {
    scheduler: {
      state: schedulerPaused ? 'paused' : 'running',
      ...(schedulerStatus && { message: schedulerStatus.slice(0, 200) }),
    },
    tvs: [...connectedTvs].map(([tvIp, tv]) => ({
      tvIp,
      reachable: tv.reachable,
      artMode: tv.reachable ? tv.artMode : null,
      ...(tv.info?.model && { model: tv.info.model }),
      lastUploadAt: iso(tv.lastUploadAt),
      contentVersion: tv.rendered?.contentVersion ?? null,
      lastError: tv.lastError && { at: iso(tv.lastError.at)!, message: tv.lastError.message },
    })),
    discoveredTvs: [...discovered.values()]
      .filter((tv) => isPrivateIpv4(tv.ip))
      .slice(0, 32)
      .map(({ ip, model, name }) => ({ ip, ...(model && { model }), ...(name && { name }) })),
  };
}

async function checkConnected(force = false): Promise<void> {
  const now = Date.now();
  await connection.poll(now);
  if (connection.pollError !== lastPollError) {
    lastPollError = connection.pollError;
    if (lastPollError) console.error(`[${new Date(now).toISOString()}] ${lastPollError}`);
  }
  // The scheduler status reaches the desktop app's tray only: the log is all Docker and the CLI have.
  if (connection.linkProblem !== lastLinkProblem) {
    lastLinkProblem = connection.linkProblem;
    if (lastLinkProblem) {
      console.error(
        `[${new Date(now).toISOString()}] ${linkProblemMessage(lastLinkProblem)}. Polling stops until the connect code changes.`,
      );
    }
  }
  if (connection.linkProblem) {
    connectedTvs.clear();
    setSchedulerStatus(linkProblemMessage(connection.linkProblem));
    return;
  }
  // Without a fresh config, the last one keeps working until its display URLs expire.
  const config = connection.config;
  if (!config) {
    setSchedulerStatus(connection.pollError ?? 'Waiting for Frame This');
    return;
  }

  const notice = versionNotice(config);
  if (notice !== lastNotice) {
    lastNotice = notice;
    if (notice) console.log(notice);
  }
  for (const ip of connectedTvs.keys()) {
    if (!config.tvs.some((tv) => tv.tvIp === ip)) connectedTvs.delete(ip);
  }

  if (schedulerPaused) setSchedulerStatus('Scheduler paused');
  else if (config.tvs.length === 0) setSchedulerStatus('No TV assigned in Frame This yet');
  else for (const tv of config.tvs) await renderConnectedTv(tv, now, force);

  await discoverTvs(now, config.tvs.length === 0);
  try {
    await connection.report(connectedStatus());
  } catch (error) {
    console.error('Could not send the status to Frame This:', errorMessage(error));
  }
}

async function runConnectedScheduler(): Promise<void> {
  setSchedulerStatus('Scheduler running');
  console.log('Connected to Frame This — it decides what each TV shows and when (Ctrl+C to stop)\n');
  const tick = async (): Promise<void> => {
    await applicationJobs.run(() => checkConnected());
    setTimeout(tick, 60_000);
  };
  await tick();
}

/**
 * Runs a connected-mode check now: right after linking, or with `force` to render every TV in Art
 * Mode whatever the timing says (Run Now). `relinked` starts over after the user linked again, even
 * with the same code, which Frame This may accept by now.
 */
export function runConnectedCheck({ force = false, relinked = false } = {}): Promise<void> {
  return applicationJobs.run(() => {
    if (relinked) connection.relinked();
    return checkConnected(force);
  });
}

export interface ConnectedSnapshot {
  linkProblem: LinkProblem | null;
  pollError: string | null;
  notice: string | null;
  tvs: Array<{
    tvIp: string;
    name?: string;
    model?: string;
    reachable: boolean;
    artMode: boolean | null;
    lastUploadAt: number | null;
    lastError: string | null;
  }>;
}

/** Connected-mode state for the desktop app's window and tray. */
export function getConnectedSnapshot(): ConnectedSnapshot {
  return {
    linkProblem: connection.linkProblem,
    pollError: connection.pollError,
    notice: versionNotice(connection.config),
    tvs: (connection.config?.tvs ?? []).map(({ tvIp }) => {
      const tv = connectedTvs.get(tvIp);
      return {
        tvIp,
        name: tv?.info?.name,
        model: tv?.info?.model,
        reachable: tv?.reachable ?? false,
        artMode: tv?.artMode ?? null,
        lastUploadAt: tv?.lastUploadAt ?? null,
        lastError: tv?.lastError?.message ?? null,
      };
    }),
  };
}
