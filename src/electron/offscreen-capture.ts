/**
 * Web Frame — Electron Offscreen Capture
 *
 * Captures webpage screenshots using Electron's built-in Chromium engine.
 * Eliminates the need to install or download Playwright or external browser binaries.
 * Matches the Playwright provider: CONTENT_WIDTH × CONTENT_HEIGHT viewport, deviceScaleFactor
 * OUTPUT_WIDTH / CONTENT_WIDTH, captured once the network is idle. With a render policy (connected
 * mode), the page runs without JavaScript and may only load from the policy's origins.
 */

import { BrowserWindow, session } from 'electron';
import type { Session } from 'electron';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertCapturableUrl, PageStatusError, type CaptureOptions } from '../content-url.js';
import { loadEnv } from '../env.js';

export interface OffscreenCaptureOptions extends CaptureOptions {
  timeoutMs?: number;
  settleMs?: number;
}

// Playwright's waitUntil: 'networkidle' rule: no request in flight for this long.
const NETWORK_IDLE_MS = 500;

// CONTENT_URL is remote content: keep it in its own in-memory session, away from the dashboard's
// cookies and HTTP auth cache, and refuse every permission it asks for from the hidden window.
// Frame This display pages (connected mode) get a session of their own, which also refuses downloads.
function getCaptureSession(restricted: boolean): Session {
  const captureSession = session.fromPartition(restricted ? 'web-frame-frame-this' : 'web-frame-capture');
  captureSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  captureSession.setPermissionCheckHandler(() => false);
  if (restricted && captureSession.listenerCount('will-download') === 0) {
    captureSession.on('will-download', (event) => event.preventDefault());
  }
  return captureSession;
}

export async function captureOffscreen(
  url: string,
  outputPath: string,
  settings?: NodeJS.ProcessEnv,
  options?: OffscreenCaptureOptions,
): Promise<string> {
  const policy = options?.policy;
  assertCapturableUrl(url, policy);

  if (!settings) loadEnv();
  const environment = settings ?? { ...process.env };
  const inputWidth = parseInt(environment.CONTENT_WIDTH ?? '3840', 10);
  const inputHeight = parseInt(environment.CONTENT_HEIGHT ?? '2160', 10);
  const outputWidth = parseInt(environment.OUTPUT_WIDTH ?? String(inputWidth), 10);
  // Render at the output resolution rather than stretching a CONTENT-sized bitmap afterwards
  const scale = outputWidth / inputWidth;
  const outputHeight = Math.round(inputHeight * scale);

  const timeoutMs = options?.timeoutMs ?? 60_000;
  const settleMs = options?.settleMs ?? 2000;

  await mkdir(dirname(outputPath), { recursive: true });

  const captureSession = getCaptureSession(Boolean(policy));
  const { webRequest } = captureSession;
  const win = new BrowserWindow({
    show: false,
    width: inputWidth,
    height: inputHeight,
    useContentSize: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: scale },
      sandbox: true,
      session: captureSession,
      images: true,
      javascript: !policy,
      backgroundThrottling: false,
    },
  });
  // Windows shrinks a new window to fit the screen; resizing it afterwards keeps the full CONTENT size.
  win.setContentSize(inputWidth, inputHeight);
  // Popups would otherwise open as visible windows on the user's desktop.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const contentsId = win.webContents.id;

  // The page on screen and its HTTP status (-1 when it didn't come over HTTP). A meta refresh or a script
  // may replace the first page, so this is checked just before the capture.
  let mainDocument = { status: -1, url };
  win.webContents.on('did-navigate', (_event, navigatedUrl, httpResponseCode) => {
    mainDocument = { status: httpResponseCode, url: navigatedUrl };
  });

  try {
    // Wait until the page has loaded and no request has been in flight for NETWORK_IDLE_MS
    await new Promise<void>((resolve, reject) => {
      const pending = new Set<number>();
      let loaded = false;
      let finished = false;
      let idleTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        finish(new Error(`Page load timed out after ${timeoutMs / 1000}s: ${url}`));
      }, timeoutMs);

      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(idleTimer);
        if (err) reject(err);
        else resolve();
      };

      const waitForIdle = () => {
        clearTimeout(idleTimer);
        if (loaded && pending.size === 0) idleTimer = setTimeout(() => finish(), NETWORK_IDLE_MS);
      };

      // WebSockets stay open for the page's lifetime, so like Playwright they don't count
      webRequest.onBeforeRequest((details, callback) => {
        // Unlike Playwright's page.route, this also runs for each redirect hop.
        if (policy && !policy.allowRequest(details.url)) {
          callback({ cancel: true });
          return;
        }
        if (details.webContentsId === contentsId && details.resourceType !== 'webSocket') {
          pending.add(details.id);
          clearTimeout(idleTimer);
        }
        callback({});
      });
      const requestDone = ({ id }: { id: number }) => {
        if (pending.delete(id)) waitForIdle();
      };
      webRequest.onCompleted(requestDone);
      webRequest.onErrorOccurred(requestDone);

      win.webContents.on('did-finish-load', () => {
        loaded = true;
        waitForIdle();
      });

      // Only the page itself failing counts: subframes (widgets, ads) may fail, and ERR_ABORTED (-3)
      // means a client-side redirect replaced the navigation, which then loads on its own.
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          finish(new Error(`Failed to load ${validatedURL}: [${errorCode}] ${errorDescription}`));
        }
      });

      win.loadURL(url).catch((err) => {
        if (err.code !== 'ERR_ABORTED') finish(err);
      });
    });

    // Wait for web fonts and animations to settle
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
    }

    if (mainDocument.status >= 400) throw new PageStatusError(mainDocument.status, mainDocument.url);

    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: inputWidth,
      height: inputHeight,
    });

    // Fail on a blank or wrongly sized capture so the last good image is kept, not replaced.
    // Fractional scales may round by a pixel.
    const { width, height } = image.getSize();
    if (image.isEmpty() || Math.abs(width - outputWidth) > 1 || Math.abs(height - outputHeight) > 1) {
      throw new Error(`Screenshot is ${width}x${height} instead of ${outputWidth}x${outputHeight}: ${url}`);
    }

    await writeFile(outputPath, image.toPNG());

    return outputPath;
  } finally {
    webRequest.onBeforeRequest(null);
    webRequest.onCompleted(null);
    webRequest.onErrorOccurred(null);
    try {
      win.destroy();
    } catch {
      // ignore destruction errors
    }
  }
}
