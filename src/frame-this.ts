/**
 * Connected mode: Frame This decides what each TV shows and when; Web Frame renders it and uploads it.
 * The protocol is documented in docs/frame-this-protocol.md. Change the two together.
 *
 * The bridge only makes outgoing requests: it polls Frame This for its config and posts its status.
 * Everything Frame This sends is untrusted data. A compromised server should at worst put a wrong image
 * on the TV, so the guards live here too: fixed origins, the request allowlist for rendering, TV
 * addresses that must be private, and a strict config schema. Frame This never sends commands,
 * scripts, browser flags, environment variables, file paths or update URLs, and nothing here acts on
 * such fields if they appear.
 */

import { readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getDataDir } from './env.js';
import { replaceFile } from './atomic-file.js';
import { readTextLimited } from './response-body.js';
import type { RenderPolicy } from './content-url.js';

export const PROTOCOL_VERSION = 1;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Origins: fixed here, never taken from a response
// ---------------------------------------------------------------------------

const API_ORIGIN = 'https://api.framethis.link';
const DISPLAY_ORIGIN = 'https://framethis.link';
export const FRAME_THIS_DASHBOARD_URL = 'https://framethis.link/dashboard';
// Display pages load their fonts from Google Fonts
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * FRAME_THIS_DEV_ORIGIN points the bridge at a local Frame This (`wrangler dev`, or a mock server),
 * which serves the device API and the display pages from one origin. It comes from the launcher or
 * .env, never from Frame This, and only a loopback address is accepted.
 */
function devOrigin(): string | null {
  const value = process.env.FRAME_THIS_DEV_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.origin === value.replace(/\/$/, '')) {
      return url.origin;
    }
  } catch {
    // reported below
  }
  throw new Error('FRAME_THIS_DEV_ORIGIN must be a loopback origin such as http://localhost:8787');
}

export function frameThisOrigins(): { api: string; display: string } {
  const dev = devOrigin();
  return dev ? { api: dev, display: dev } : { api: API_ORIGIN, display: DISPLAY_ORIGIN };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** RFC 1918 only, as Frame This checks it: a Frame TV is on the user's LAN. */
export function isPrivateIpv4(value: string): boolean {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  // A leading zero reads as octal in some parsers
  if (octets.some((octet) => octet > 255) || match.slice(1).some((octet) => /^0\d/.test(octet))) return false;
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A display page on Frame This: the bridge renders nothing else in connected mode. */
export function isAllowedDisplayUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== null &&
    url.origin === frameThisOrigins().display &&
    !url.username &&
    !url.password &&
    url.pathname.startsWith('/@')
  );
}

/** Where a display page may load anything from while it's rendered. */
function renderOrigins(): string[] {
  const { api, display } = frameThisOrigins();
  return [...new Set([display, api, ...FONT_ORIGINS])];
}

/**
 * The request allowlist for rendering. Matching exact origins (scheme, host and port) also keeps out
 * every IP address, so private, loopback and link-local hosts never load. `data:` URLs are inline.
 */
export function isAllowedRenderRequest(value: string): boolean {
  if (value.startsWith('data:')) return true;
  const url = parseUrl(value);
  return url !== null && !url.username && !url.password && renderOrigins().includes(url.origin);
}

/** Rendering a display page: no JavaScript, and only the allowlisted origins. */
export function connectedRenderPolicy(): RenderPolicy {
  return { allowRequest: isAllowedRenderRequest, origins: renderOrigins() };
}

// ---------------------------------------------------------------------------
// Version and User-Agent
// ---------------------------------------------------------------------------

const VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z.-]{1,32}))?$/;
let appVersion: string | undefined;

export function getAppVersion(): string {
  if (appVersion === undefined) {
    try {
      appVersion = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
    } catch {
      appVersion = '';
    }
    if (!VERSION_PATTERN.test(appVersion)) appVersion = '0.0.0';
  }
  return appVersion;
}

/** Negative when a is older than b. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = a.match(VERSION_PATTERN);
  const right = b.match(VERSION_PATTERN);
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return Math.sign(difference);
  }
  if (Boolean(left[4]) !== Boolean(right[4])) return left[4] ? -1 : 1;
  return 0;
}

// WEB_FRAME_PLATFORM is set by the Docker image ("docker") and the desktop app ("electron-win").
function platformLabel(): string {
  const value = process.env.WEB_FRAME_PLATFORM ?? '';
  return /^[a-z0-9-]{1,32}$/.test(value) ? value : 'node';
}

export function userAgent(): string {
  return `web-frame/${getAppVersion()} (${platformLabel()})`;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const TOKEN_PATTERN = /^ftd_[A-Za-z0-9_-]{43}$/;

export const isFrameThisToken = (value: string): boolean => TOKEN_PATTERN.test(value);

const tokenPath = (): string => join(getDataDir(), 'frame-this-token');

/**
 * The bridge's device token: FRAME_THIS_TOKEN (Docker, .env), or the file the desktop app saves when
 * the user pastes a connect code. null means standalone mode. Never log it, and never send it anywhere
 * but the device API.
 */
// The desktop app links through its own window and keeps the code in the token file only. A
// FRAME_THIS_TOKEN in its .env would otherwise win over unlinking and linking again.
let tokenFromEnvironment = true;

/** For the desktop app: ignore FRAME_THIS_TOKEN and read the token file only. */
export function useTokenFileOnly(enabled = true): void {
  tokenFromEnvironment = !enabled;
}

export function readFrameThisToken(): string | null {
  const fromEnvironment = tokenFromEnvironment && process.env.FRAME_THIS_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return readFileSync(tokenPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export const isConnectedMode = (): boolean => readFrameThisToken() !== null;

export async function saveFrameThisToken(token: string): Promise<void> {
  if (!isFrameThisToken(token)) throw new Error('Not a Frame This connect code');
  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { mode: 0o600 });
    await replaceFile(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function removeFrameThisToken(): Promise<void> {
  await unlink(tokenPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const TV_SIZES = ['3840x2160', '1920x1080'] as const;
export type TvSize = (typeof TV_SIZES)[number];

const MAX_TVS = 8;
const MAX_CONFIG_BYTES = 256 * 1024;

const clampTo = (min: number, max: number) => (value: number) => Math.min(max, Math.max(min, Math.round(value)));
const isoTime = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));
const versionSchema = z.string().regex(VERSION_PATTERN);

// z.object drops fields it doesn't list, so whatever else a config carries is never seen.
const tvSchema = z.object({
  tvIp: z.string().refine(isPrivateIpv4),
  channelId: z.string().max(64).optional(),
  size: z.enum(TV_SIZES),
  displayUrl: z.string().max(4096).refine(isAllowedDisplayUrl),
  displayUrlExpiresAt: isoTime,
  contentVersion: z.string().min(1).max(64),
  refreshAfter: z.number().transform(clampTo(60, 7 * 24 * 3600)),
  nextChangeAt: isoTime.nullable().optional(),
});

const configSchema = z.object({
  latestVersion: versionSchema.nullable().catch(null),
  minVersion: versionSchema.nullable().catch(null),
  pollAfter: z.number().catch(60).transform(clampTo(60, 3600)),
  tvs: z.array(z.unknown()).max(64),
});

export interface TvConfig {
  tvIp: string;
  channelId?: string;
  size: TvSize;
  displayUrl: string;
  displayUrlExpiresAt: number; // ms since the epoch
  contentVersion: string;
  refreshAfter: number; // seconds
  nextChangeAt: number | null; // ms since the epoch
}

export interface DeviceConfig {
  latestVersion: string | null;
  minVersion: string | null;
  pollAfter: number; // seconds
  tvs: TvConfig[];
  /** TVs left out because they didn't validate (an unknown size, a public IP, another origin). */
  skippedTvs: number;
}

export function parseDeviceConfig(input: unknown): DeviceConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw new Error("Frame This sent a config this version can't read");
  const tvs: TvConfig[] = [];
  let skippedTvs = 0;
  for (const entry of parsed.data.tvs) {
    // One TV that doesn't validate is skipped; the others still run.
    const tv = tvSchema.safeParse(entry);
    if (!tv.success || tvs.length >= MAX_TVS || tvs.some((other) => other.tvIp === tv.data.tvIp)) {
      skippedTvs++;
      continue;
    }
    tvs.push({ ...tv.data, nextChangeAt: tv.data.nextChangeAt ?? null });
  }
  const { latestVersion, minVersion, pollAfter } = parsed.data;
  return { latestVersion, minVersion, pollAfter, tvs, skippedTvs };
}

/**
 * Why a TV should be rendered now, or null. Only reasons to render: the Art Mode checks and the
 * image-unchanged skip still apply.
 */
export function renderReason(
  tv: TvConfig,
  last: { at: number; contentVersion: string } | undefined,
  now: number,
): string | null {
  if (!last) return 'first render';
  if (tv.contentVersion !== last.contentVersion) return 'content changed';
  if (now >= last.at + tv.refreshAfter * 1000) return 'refresh';
  if (tv.nextChangeAt !== null && tv.nextChangeAt > last.at && now >= tv.nextChangeAt) return 'scheduled change';
  return null;
}

/** "Update available" or "Update required", from the versions Frame This reports. */
export function versionNotice(config: DeviceConfig | null, current = getAppVersion()): string | null {
  if (!config) return null;
  if (config.minVersion && compareVersions(current, config.minVersion) < 0) {
    return `Update required: Frame This needs Web Frame ${config.latestVersion ?? config.minVersion} or newer`;
  }
  if (config.latestVersion && compareVersions(current, config.latestVersion) < 0) {
    return `Update available: Web Frame ${config.latestVersion}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device API
// ---------------------------------------------------------------------------

export interface DeviceStatus {
  scheduler: { state: 'running' | 'paused'; message?: string };
  tvs: Array<{
    tvIp: string;
    reachable: boolean;
    artMode: boolean | null;
    model?: string;
    lastUploadAt: string | null;
    contentVersion: string | null;
    lastError: { at: string; message: string } | null;
  }>;
  discoveredTvs: Array<{ ip: string; model?: string; name?: string }>;
}

type ConfigResponse =
  | { status: 'ok'; config: DeviceConfig; etag: string | null }
  | { status: 'not-modified' }
  | { status: 'unauthorized' }
  | { status: 'rate-limited'; retryAfter: number };

function deviceRequest(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${frameThisOrigins().api}/api/device/v1${path}`, {
    ...init,
    // The token goes to the device API only, never to wherever a redirect points.
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: { ...init.headers, Authorization: `Bearer ${token}`, 'User-Agent': userAgent() },
  });
}

const retryAfterSeconds = (response: Response): number =>
  clampTo(60, 3600)(Number(response.headers.get('retry-after')) || 60);

export async function fetchDeviceConfig(token: string, etag: string | null = null): Promise<ConfigResponse> {
  const response = await deviceRequest(token, '/config', {
    headers: { Accept: 'application/json', ...(etag && { 'If-None-Match': etag }) },
  });
  try {
    if (response.status === 304 && etag) return { status: 'not-modified' };
    if (response.status === 401) return { status: 'unauthorized' };
    if (response.status === 429) return { status: 'rate-limited', retryAfter: retryAfterSeconds(response) };
    if (response.status !== 200) throw new Error(`Frame This answered HTTP ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(await readTextLimited(response, MAX_CONFIG_BYTES));
    } catch {
      throw new Error("Frame This sent a config this version can't read");
    }
    const tag = response.headers.get('etag');
    return { status: 'ok', config: parseDeviceConfig(body), etag: tag && tag.length <= 256 ? tag : null };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function postDeviceStatus(token: string, body: string): Promise<'ok' | 'unauthorized'> {
  const response = await deviceRequest(token, '/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) return 'unauthorized';
  if (!response.ok) throw new Error(`Frame This answered HTTP ${response.status} to the status`);
  return 'ok';
}

/** Whether Frame This accepts a connect code the user pasted. */
export async function checkFrameThisToken(token: string): Promise<'ok' | 'unauthorized' | 'unreachable'> {
  if (!isFrameThisToken(token)) return 'unauthorized';
  try {
    const response = await deviceRequest(token, '/config', { headers: { Accept: 'application/json' } });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return 'unauthorized';
    return response.status === 200 ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export type LinkProblem = 'unlinked' | 'invalid-token';

// The status is posted when it changes, and at least this often so Frame This sees the bridge is alive.
const HEARTBEAT_MS = 5 * 60_000;

/** The polling state of a linked bridge: its token, the last config and its ETag, and what it last reported. */
export class FrameThisConnection {
  private token: string | null = null;
  private etag: string | null = null;
  private nextPollAt = 0;
  private reported: { body: string; at: number } | null = null;
  config: DeviceConfig | null = null;
  /** Polling stops until the token changes: the bridge was unlinked, or the code is wrong. */
  linkProblem: LinkProblem | null = null;
  /** Why the last poll failed. The last good config stays in use meanwhile. */
  pollError: string | null = null;

  /** Picks up a changed token (the desktop app linking again) and forgets what the old one learnt. */
  private currentToken(): string | null {
    const token = readFrameThisToken();
    if (token !== this.token) {
      this.token = token;
      this.etag = null;
      this.config = null;
      this.nextPollAt = 0;
      this.reported = null;
      this.pollError = null;
      this.linkProblem = token !== null && !isFrameThisToken(token) ? 'invalid-token' : null;
    }
    return this.linkProblem ? null : this.token;
  }

  /** The user linked again, maybe with the same code: start over as if the token had changed. */
  relinked(): void {
    this.token = null;
  }

  private unlink(): void {
    this.linkProblem = 'unlinked';
    this.config = null;
    this.etag = null;
  }

  /** Fetches the config when it's due, or now with `force` (an expiring display URL). */
  async poll(now = Date.now(), force = false): Promise<void> {
    const token = this.currentToken();
    if (!token || (!force && now < this.nextPollAt)) return;
    this.nextPollAt = now + (this.config?.pollAfter ?? 60) * 1000;
    try {
      const result = await fetchDeviceConfig(token, this.config ? this.etag : null);
      if (result.status === 'unauthorized') {
        this.unlink();
        return;
      }
      if (result.status === 'rate-limited') {
        this.nextPollAt = now + result.retryAfter * 1000;
        this.pollError = 'Frame This asked the bridge to slow down';
        return;
      }
      if (result.status === 'ok') {
        if (result.config.skippedTvs) {
          console.warn(`Frame This config: skipped ${result.config.skippedTvs} TV(s) that didn't validate.`);
        }
        this.config = result.config;
        this.etag = result.etag;
        this.nextPollAt = now + result.config.pollAfter * 1000;
      }
      this.pollError = null;
    } catch (error) {
      this.pollError = `Can't reach Frame This: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Posts the status when it changed, or as a heartbeat. */
  async report(status: DeviceStatus, now = Date.now()): Promise<void> {
    const token = this.currentToken();
    if (!token) return;
    const body = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, appVersion: getAppVersion(), ...status });
    if (this.reported?.body === body && now - this.reported.at < HEARTBEAT_MS) return;
    if ((await postDeviceStatus(token, body)) === 'unauthorized') {
      this.unlink();
      return;
    }
    this.reported = { body, at: now };
  }
}
