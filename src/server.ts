/**
 * Web Frame — web admin server.
 * Serves the admin UI and exposes a REST API for config, image acquisition, and TV control.
 * Binds to loopback by default, with optional HTTPS and required Basic Auth credentials.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { authenticate, validateCredentials } from './auth.js';
import { loadEnv, getSettingsPath } from './env.js';
import { CONFIG_KEYS, Config, ConfigValidationError, SettingsStore } from './settings.js';
import { resolveImageSource } from './image-source.js';
import { applicationJobs } from './job-queue.js';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDefaultImage,
  generateImage,
  uploadAndSelect,
  listTvImages,
  cleanupTvImages,
  scanTvs,
  runOnce,
  ImageNotFoundError,
  getConnectedSnapshot,
  getSchedulerStatus,
  restartScheduler,
  runConnectedCheck,
} from './app.js';
import {
  FRAME_THIS_DASHBOARD_URL,
  checkFrameThisToken,
  frameThisTokenSource,
  getAppVersion,
  isConnectedMode,
  isFrameThisToken,
  removeFrameThisToken,
  saveFrameThisToken,
} from './frame-this.js';

export interface ServerOptions {
  /**
   * The admin UI can link this bridge to Frame This and unlink it again. Only where this process also
   * runs the scheduler (`start`): the desktop app links through its own window.
   */
  frameThis?: boolean;
}

// Linked to Frame This, it decides what the TVs show: the admin UI doesn't send them anything itself.
const STANDALONE_ROUTES = new Set([
  'POST /api/image', 'POST /api/screenshot', 'POST /api/upload', 'GET /api/list', 'POST /api/cleanup',
]);

/** The state public/bridge.js renders, in the shape the desktop app sends it. */
function bridgeState() {
  const snapshot = getConnectedSnapshot();
  return {
    connected: isConnectedMode(),
    // A refused code shows the connect form again, with "Use without Frame This" to unlink.
    mode: snapshot.linkProblem ? 'setup' : 'connected',
    view: snapshot.linkProblem ? 'connect' : 'status',
    version: getAppVersion(),
    linkProblem: snapshot.linkProblem,
    status: getSchedulerStatus() ?? '',
    paused: false,
    warning: snapshot.pollError,
    notice: snapshot.notice,
    tvs: snapshot.tvs,
    openUrl: FRAME_THIS_DASHBOARD_URL,
  };
}

function switchSchedulerMode(): void {
  restartScheduler().catch((err) => console.error('Scheduler failed:', err instanceof Error ? err.message : err));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function readConfig(): Config {
  const config = {} as Config;
  for (const key of CONFIG_KEYS) config[key] = process.env[key] ?? '';
  config.IMAGE_SOURCE = resolveImageSource(process.env.IMAGE_SOURCE);
  config['AUTH_PASS'] = ''; // never expose password over API
  return config;
}

async function writeConfig(updates: unknown): Promise<void> {
  await applicationJobs.run(async () => {
    loadEnv();
    await new SettingsStore(getSettingsPath()).save(updates);
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function checkAuth(req: IncomingMessage): boolean {
  return authenticate(req.headers.authorization, process.env.AUTH_USER, process.env.AUTH_PASS);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;
class RequestBodyTooLargeError extends Error {
  constructor() { super('Request body exceeds the 64 KiB limit'); }
}

function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.pause();
    return Promise.reject(new RequestBodyTooLargeError());
  }
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let received = 0;
    const onEnd = () => {
      req.off('data', onData);
      const raw = Buffer.concat(chunks, received).toString('utf8');
      chunks = [];
      resolve(raw);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        chunks = [];
        req.pause();
        req.off('data', onData);
        req.off('end', onEnd);
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', (error) => {
      chunks = [];
      req.off('data', onData);
      req.off('end', onEnd);
      reject(error);
    });
  });
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new ConfigValidationError('Invalid JSON body');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
const ok = (res: ServerResponse, extra: Record<string, unknown> = {}) => json(res, 200, { ok: true, ...extra });
const fail = (res: ServerResponse, status: number, error: string) => json(res, status, { ok: false, error });

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.webmanifest': 'application/manifest+json',
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  rawBody: string,
  options: ServerOptions,
): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const tvIp = () => process.env.TV_IP ?? '192.168.1.100';
  const connected = isConnectedMode();
  // FRAME_THIS_TOKEN can't be changed from here: only a link made in the admin UI or the desktop app.
  const canSwitch = Boolean(options.frameThis) && frameThisTokenSource() !== 'environment';

  // --- Static files ---

  if (route === 'GET /') {
    // Linked to Frame This, the admin UI is the desktop app's Frame This window (bridge.html).
    let html = await readFile(join(PUBLIC, connected ? 'bridge.html' : 'index.html'), 'utf-8');
    // Static files are cached for a year: a new release loads its own bridge.js.
    if (connected) html = html.replace('src="bridge.js"', `src="bridge.js?v=${getAppVersion()}"`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (route === 'GET /preview.png') {
    const defaultImage = getDefaultImage();
    if (!existsSync(defaultImage)) {
      fail(res, 404, 'No preview yet — refresh the image first');
      return;
    }
    const buf = await readFile(defaultImage);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
    return;
  }

  // --- General static files ---

  if (req.method === 'GET') {
    const filePath = join(PUBLIC, url.pathname);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath);
      const mimeType = getMimeType(ext);
      const buf = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=31536000', // cache static assets for 1 year
      });
      res.end(buf);
      return;
    }
  }

  // --- API ---

  if (connected && STANDALONE_ROUTES.has(route)) {
    fail(res, 409, 'Linked to Frame This: it decides what your TVs show');
    return;
  }

  if (route === 'GET /api/config') {
    ok(res, {
      config: readConfig(),
      version: getAppVersion(),
      frameThis: { available: canSwitch, connected },
    });
    return;
  }

  if (route === 'GET /api/frame-this') {
    ok(res, bridgeState());
    return;
  }

  if (route === 'POST /api/frame-this/connect') {
    if (!canSwitch) {
      fail(res, 409, 'Link to Frame This with FRAME_THIS_TOKEN, or run Web Frame with the start command');
      return;
    }
    const { token } = parseBody(rawBody);
    const code = typeof token === 'string' ? token.trim() : '';
    if (!isFrameThisToken(code)) {
      throw new ConfigValidationError("That isn't a connect code. It starts with ftd_; copy it again from Frame This.");
    }
    const check = await checkFrameThisToken(code);
    if (check === 'unauthorized') {
      throw new ConfigValidationError(
        "Frame This doesn't accept this code. Copy it again, or in Frame This open TVs → Bridge settings → New connect code.",
      );
    }
    if (check === 'unreachable') {
      fail(res, 502, "Can't reach Frame This right now. Check the internet connection and try again.");
      return;
    }
    await saveFrameThisToken(code);
    console.log('Linked to Frame This from the admin UI');
    switchSchedulerMode();
    ok(res);
    return;
  }

  if (route === 'POST /api/frame-this/disconnect') {
    if (!canSwitch || !connected) {
      fail(res, 409, 'Not linked to Frame This from the admin UI');
      return;
    }
    await removeFrameThisToken();
    console.log('Unlinked from Frame This from the admin UI');
    switchSchedulerMode();
    ok(res);
    return;
  }

  if (route === 'POST /api/config') {
    const body = parseBody(rawBody);
    await writeConfig(body);
    ok(res, { config: readConfig() });
    return;
  }

  if (route === 'POST /api/image' || route === 'POST /api/screenshot') {
    await generateImage();
    ok(res, { generated_at: new Date().toISOString() });
    return;
  }

  if (route === 'POST /api/upload') {
    // The image is checked after this job reaches the front of the shared queue.
    const contentId = await uploadAndSelect(getDefaultImage());
    ok(res, { content_id: contentId });
    return;
  }

  if (route === 'POST /api/run') {
    if (connected) {
      // Run now: every TV in Art Mode gets what Frame This says it should show.
      await runConnectedCheck({ force: true });
      ok(res, { status: getSchedulerStatus() ?? '' });
      return;
    }
    const result = await runOnce();
    ok(res, {
      generated_at: new Date().toISOString(),
      ...(result.skipped ? { skipped: true } : { content_id: result.contentId }),
    });
    return;
  }

  if (route === 'GET /api/list') {
    ok(res, { art: await listTvImages() });
    return;
  }

  if (route === 'POST /api/cleanup') {
    const body = parseBody(rawBody);
    const keep = typeof body.keep === 'number' ? body.keep : 10;
    await cleanupTvImages(keep);
    ok(res);
    return;
  }

  if (route === 'GET /api/tv-status') {
    // An optional candidate lets setup check a new address without saving it.
    const ip = url.searchParams.get('ip') ?? tvIp();
    const version = isIP(ip);
    if (!version) throw new ConfigValidationError('TV IP must be an IP address');
    const host = version === 6 ? `[${ip}]` : ip;
    try {
      const response = await fetch(`http://${host}:8001/api/v2/`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      // Any HTTP response establishes reachability; pairing/Art Mode are separate.
      await response.body?.cancel().catch(() => undefined);
      ok(res, { online: true });
    } catch {
      ok(res, { online: false });
    }
    return;
  }

  if (route === 'POST /api/scan') {
    try {
      const tvs = await scanTvs();
      ok(res, { tvs });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  fail(res, 404, 'Not found');
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

export function startServer(port: number, options: ServerOptions = {}) {
  loadEnv();
  validateCredentials(process.env.AUTH_USER, process.env.AUTH_PASS);
  // This single-admin Basic Auth app has no cookie session. Bind tokens to this
  // server instance and current credentials so restarts/password changes revoke them.
  const csrfSecret = randomBytes(32);
  const csrfToken = () => createHmac('sha256', csrfSecret)
    .update(JSON.stringify([process.env.AUTH_USER, process.env.AUTH_PASS])).digest('hex');
  const host = process.env.SERVER_HOST || '127.0.0.1';
  const cert = process.env.SERVER_TLS_CERT;
  const key = process.env.SERVER_TLS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both SERVER_TLS_CERT and SERVER_TLS_KEY for HTTPS');
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    console.log(`${req.method} ${url.pathname}`);
    if (!checkAuth(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Web Frame"',
        'Content-Type': 'text/plain',
      });
      res.end('Unauthorized');
      return;
    }
    const tokenRequest = req.method === 'GET' && url.pathname === '/api/csrf';
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '');
    if (mutation || tokenRequest) {
      // Tokens remain mandatory when Fetch Metadata is absent (CLI/older browsers).
      // No CORS permissions are granted: another origin cannot read the token.
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin') {
        fail(res, 403, 'Cross-origin requests are not allowed');
        return;
      }
    }
    if (mutation) {
      const supplied = req.headers['x-csrf-token'];
      const expected = Buffer.from(csrfToken());
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== expected.length ||
          !timingSafeEqual(Buffer.from(supplied), expected)) {
        fail(res, 403, 'Missing or invalid CSRF token');
        return;
      }
    }
    try {
      // Receive and bound the complete body before any queued work, even for
      // action endpoints that do not use JSON. Decode UTF-8 only after assembly.
      const rawBody = await readBody(req);
      if (tokenRequest) {
        res.setHeader('Cache-Control', 'no-store');
        ok(res, { token: csrfToken() });
        return;
      }
      await dispatch(req, res, url, rawBody, options);
    } catch (err) {
      // A receive timeout or client disconnect may already have closed the socket.
      if (res.destroyed) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Server error:', msg);
      if (!res.headersSent) {
        if (err instanceof RequestBodyTooLargeError) {
          // Do not drain an arbitrarily large remainder or reuse this connection.
          res.setHeader('Connection', 'close');
          fail(res, 413, msg);
        } else {
          fail(res, err instanceof ConfigValidationError || err instanceof ImageNotFoundError ? 400 : 500, msg);
        }
      }
    }
  };
  // These limits cover receiving headers/body, not the time spent running jobs.
  const receiveLimits = { requestTimeout: 30_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 };
  const server = cert && key
    ? createSecureServer({ ...receiveLimits, cert: readFileSync(cert), key: readFileSync(key) }, handler)
    : createServer(receiveLimits, handler);

  // Callers handle 'error' (e.g. EADDRINUSE): the CLI exits, the desktop app shows a dialog.
  server.listen(port, host, () => {
    console.log(`Web Frame admin UI → ${cert ? 'https' : 'http'}://${host}:${port}`);
  });
  return server;
}
