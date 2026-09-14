/**
 * Screenshots a URL using Playwright and saves it as a PNG.
 *
 * CONTENT_WIDTH / CONTENT_HEIGHT define the viewport — what the page "sees" (CSS px).
 * deviceScaleFactor is derived as OUTPUT_WIDTH / CONTENT_WIDTH.
 * OUTPUT_HEIGHT is retained in settings but is not independently applied.
 *
 * Examples:
 *   INPUT=1920×1080, OUTPUT=3840×2160  → scale=2  (HD viewport, 4K output)
 *   INPUT=3840×2160, OUTPUT=3840×2160  → scale=1  (4K-native, no scaling)
 */

import type { Browser } from 'playwright';
import { mkdir, stat, readFile, writeFile, unlink, readdir } from 'fs/promises';
import { dirname, extname, join } from 'path';
import { createHash } from 'crypto';
import { loadEnv } from './env.js';
import { isHttpsContentUrl } from './content-url.js';

async function getImageCachePath(cacheDir: string, url: string): Promise<string> {
  const hash = createHash('sha256').update(url).digest('hex');
  let ext = '';

  try {
    ext = extname(new URL(url).pathname) || '';
  } catch {
    ext = '';
  }
  if (!ext) ext = '.img';

  return join(cacheDir, `${hash}${ext}`);
}

async function cleanupExpiredCache(cacheDir: string, ttlSeconds: number): Promise<void> {
  try {
    const files = await readdir(cacheDir);
    for (const file of files) {
      const path = join(cacheDir, file);
      const s = await stat(path);
      if (Date.now() - s.mtimeMs > ttlSeconds * 1000) {
        await unlink(path).catch(() => undefined);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function screenshotUrl(url: string, outputPath: string, settings?: NodeJS.ProcessEnv): Promise<string> {
  // Also enforce the rule for manual .env edits and CLI calls that bypass the admin API.
  if (!isHttpsContentUrl(url)) throw new Error('CONTENT_URL must be an HTTPS URL');
  if (!settings) loadEnv();
  const environment = settings ?? { ...process.env };
  const inputWidth = parseInt(environment.CONTENT_WIDTH ?? '3840', 10);
  const inputHeight = parseInt(environment.CONTENT_HEIGHT ?? '2160', 10);
  const outputWidth = parseInt(environment.OUTPUT_WIDTH ?? String(inputWidth), 10);
  //const outputHeight = parseInt(environment.OUTPUT_HEIGHT ?? String(inputHeight), 10);
  const scale = outputWidth / inputWidth;

  await mkdir(dirname(outputPath), { recursive: true });

  const cacheDir = environment.PLAYWRIGHT_NETWORK_CACHE_DIR ?? 'output/.playwright-network-cache';
  const cacheTtlSeconds = parseInt(environment.PLAYWRIGHT_NETWORK_CACHE_TTL_SECONDS ?? '86400', 10);

  await mkdir(cacheDir, { recursive: true });

  await cleanupExpiredCache(cacheDir, cacheTtlSeconds);

  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' &&
        (error as Error).message.includes("Cannot find package 'playwright'")) {
      throw new Error('Playwright is not installed. Install optional dependencies with npm ci --include=optional, or use the full playwright Docker target.');
    }
    throw error;
  }
  let browser: Browser;
  try {
    browser = await playwright.chromium.launch({
      channel: 'chromium-headless-shell',
      // Only an explicit opt-out disables the sandbox on unsupported hosts.
      chromiumSandbox: environment.CHROMIUM_SANDBOX !== 'false',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
      throw new Error('Chromium headless shell is not installed. Run npx playwright install chromium-headless-shell with the installed Playwright version, or use the full playwright Docker target.');
    }
    throw error;
  }
  try {
    const page = await browser.newPage({
      viewport: { width: inputWidth, height: inputHeight },
      deviceScaleFactor: scale,
    });

    // Cache image responses for repeated runs while using the same CONTENT_URL.
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.resourceType() === 'image' && request.method() === 'GET') {
        const cachePath = await getImageCachePath(cacheDir, request.url());

        try {
          const s = await stat(cachePath);
          if (cacheTtlSeconds > 0 && Date.now() - s.mtimeMs > cacheTtlSeconds * 1000) {
            await unlink(cachePath).catch(() => undefined);
            throw new Error('cache-expired');
          }

          const body = await readFile(cachePath);
          await route.fulfill({
            status: 200,
            contentType: 'image/png',
            body,
          });
          return;
        } catch {
          await route.continue();
          return;
        }
      }

      await route.continue();
    });

    page.on('response', async (response) => {
      const request = response.request();
      if (request.resourceType() === 'image' && request.method() === 'GET' && response.status() === 200) {
        try {
          const buffer = await response.body();
          const cachePath = await getImageCachePath(cacheDir, request.url());
          await writeFile(cachePath, buffer);
        } catch {
          // Best-effort; ignore cache write errors.
        }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(2000); // allow fonts / animations to settle
    await page.screenshot({ path: outputPath, type: 'png', fullPage: false });
  } finally {
    await browser.close();
  }

  return outputPath;
}
