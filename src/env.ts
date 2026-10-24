import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './env-file.js';
import { DEPLOYMENT_KEYS } from './deployment-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Generated artwork and TV state. The desktop app points this at its user data folder.
export function getDataDir(): string {
  return process.env.WEB_FRAME_DATA_DIR ? resolve(process.env.WEB_FRAME_DATA_DIR) : join(ROOT, 'output');
}

let cachedEnvPath: string | null = null;

// Resolved lazily so the desktop app can set WEB_FRAME_ENV_FILE after imports run. The first load
// fixes the path, so a value inside the file cannot redirect future saves.
export function getSettingsPath(): string {
  if (cachedEnvPath) return cachedEnvPath;
  return resolve(
    process.env.WEB_FRAME_ENV_FILE ||
      (process.env.WEB_FRAME_DATA_DIR ? join(process.env.WEB_FRAME_DATA_DIR, '.env') : join(ROOT, '.env')),
  );
}

// Capture only values supplied before the first .env load. Values loaded from
// the file must remain fallbacks on subsequent reloads, not become overrides.
const deploymentOverrides = Object.fromEntries(DEPLOYMENT_KEYS.flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]!]],
));

export function loadEnv(): void {
  try {
    const envPath = getSettingsPath();
    cachedEnvPath = envPath;
    Object.assign(process.env, parseEnv(readFileSync(envPath, 'utf8')), deploymentOverrides);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
