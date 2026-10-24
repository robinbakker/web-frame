#!/usr/bin/env tsx
/**
 * Web Frame CLI
 *
 * Usage:
 *   npx tsx src/cli.ts [command] [options]
 *
 * Commands:
 *   run                        Acquire selected image and upload to TV (default)
 *   generate                   Acquire selected image and save preview
 *   screenshot                 Alias of generate (selected source)
 *   upload [path]              Upload an image to the TV (default: output/web-frame.png)
 *   list                       List artwork stored on the TV
 *   cleanup [N] [--keep N]     Delete old uploads, keep N newest (default: 10)
 *   scan                       Scan network for Samsung TVs and show their IPs
 *   scheduler                  Run on a schedule (reads SCHEDULE_INTERVAL env var, e.g. 30m, 1h)
 *   serve [N] [--port N]        Start web admin UI (default port 3000)
 *   start                      Run admin UI + scheduler in one process
 */

import {
  getDefaultImage,
  generateImage,
  uploadAndSelect,
  listTvImages,
  cleanupTvImages,
  scanTvs,
  runOnce,
  runScheduler,
} from './app.js';
import { startServer } from './server.js';
import { loadEnv } from './env.js';

const [, , command = 'run', ...rest] = process.argv;

// Helper to parse number arguments (positional or --option)
function parseNumberArg(args: string[], option: string, validator: (n: number) => boolean, fallback: number): number {
  // Check positional number
  if (args.length > 0 && /^\d+$/.test(args[0])) {
    const n = parseInt(args[0], 10);
    if (!isNaN(n) && validator(n)) return n;
  }
  // Check --option
  const i = args.indexOf(option);
  if (i !== -1 && args[i + 1]) {
    const n = parseInt(args[i + 1], 10);
    if (!isNaN(n) && validator(n)) return n;
  }
  return fallback;
}

function parseKeep(args: string[], fallback = 10): number {
  return parseNumberArg(args, '--keep', (n) => n >= 0, fallback);
}

function parsePort(args: string[], fallback = 3000): number {
  let port = parseNumberArg(args, '--port', (n) => n >= 1 && n <= 65535, fallback);
  // Additional fallback to env var only if no arg provided
  if (port === fallback && process.env.SERVER_PORT) {
    const p = parseInt(process.env.SERVER_PORT, 10);
    if (!isNaN(p) && p >= 1 && p <= 65535) port = p;
  }
  return port;
}

function serve(port: number): void {
  startServer(port).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use.`);
    else console.error('Server error:', err.message);
    process.exit(1);
  });
}

async function cmdScreenshot(): Promise<void> {
  const { imagePath, hash } = await generateImage();
  console.log('Image acquired.');
  console.log(`  Saved to ${imagePath}`);
  console.log(`  SHA256: ${hash}`);
}

async function cmdUpload(imagePath: string): Promise<void> {
  console.log(`Uploading ${imagePath} to TV...`);
  const contentId = await uploadAndSelect(imagePath);
  console.log(`  Uploaded as ${contentId}`);
}

async function cmdRun(): Promise<void> {
  const result = await runOnce();
  if (result.skipped) {
    console.log('No image change since last run; skipping TV upload.');
    return;
  }
  console.log(`Uploaded as ${result.contentId}`);
}

async function cmdList(): Promise<void> {
  const art = await listTvImages();
  if (art.length === 0) {
    console.log('No user images on TV.');
    return;
  }
  console.log(`\n${art.length} image(s) on TV:\n`);
  for (const item of art) {
    const dims = item.width ? `${item.width}×${item.height}` : 'unknown size';
    const matte = item.matte ? `${item.matte.type}/${item.matte.color}` : 'none';
    console.log(`  [${item.id}]  ${dims}  matte=${matte}  ${item.date?.toISOString().slice(0, 10) ?? ''}`);
  }
}

async function cmdCleanup(keep: number): Promise<void> {
  await cleanupTvImages(keep);
  console.log(`Cleaned up old images, keeping ${keep}.`);
}

async function cmdScan(): Promise<void> {
  try {
    const tvs = await scanTvs();
    if (tvs.length === 0) {
      console.log('No Samsung TVs found on the network.');
      console.log('Make sure your TV is on and connected to the same network.');
      return;
    }

    console.log(`\nFound ${tvs.length} potential TV(s):\n`);
    for (const tv of tvs) {
      console.log(`  ${tv.ip}:${tv.port}`);
    }

    if (tvs.length === 1) {
      console.log(`\nTo use this TV, set TV_IP=${tvs[0].ip} in your .env file`);
    } else {
      console.log('\nTo use one of these TVs, set TV_IP=<ip> in your .env file');
    }
  } catch (err) {
    console.error('Scan failed:', err instanceof Error ? err.message : err);
  }
}

async function main() {
  loadEnv(); // Load the same .env before resolving CLI options such as SERVER_PORT.
  // Add global error handlers to prevent container crashes
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err instanceof Error ? err.message : err);
    // Don't exit - let the scheduler continue running
  });
  
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err instanceof Error ? err.message : err);
    // Don't exit - let the scheduler continue running
  });

  switch (command) {
    case 'run':
      await cmdRun();
      break;
    case 'generate':
    case 'screenshot':
      await cmdScreenshot();
      break;
    case 'upload':
      await cmdUpload(rest[0] ?? getDefaultImage());
      break;
    case 'list':
      await cmdList();
      break;
    case 'cleanup':
      await cmdCleanup(parseKeep(rest));
      break;
    case 'scan':
      await cmdScan();
      break;
    case 'scheduler':
      await runScheduler();
      return;
    case 'serve':
      serve(parsePort(rest));
      return;
    case 'start':
      serve(parsePort(rest));
      await runScheduler();
      return;
    default:
      console.error(`Unknown command: "${command}"`);
      console.error(
        'Commands: run, generate, screenshot, upload [path], list, cleanup [N] [--keep N], scan, scheduler, serve [N] [--port N], start',
      );
      process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
