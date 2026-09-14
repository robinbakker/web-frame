import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './env-file.js';
import { DEPLOYMENT_KEYS } from './deployment-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Select the file once, before loading it, so it cannot redirect future saves.
const ENV_PATH = resolve(process.env.WEB_FRAME_ENV_FILE || join(ROOT, '.env'));
// Capture only values supplied before the first .env load. Values loaded from
// the file must remain fallbacks on subsequent reloads, not become overrides.
const deploymentOverrides = Object.fromEntries(DEPLOYMENT_KEYS.flatMap((key) =>
  process.env[key] === undefined ? [] : [[key, process.env[key]!]],
));

export function getSettingsPath(): string {
  return ENV_PATH;
}

export function loadEnv(): void {
  try {
    Object.assign(process.env, parseEnv(readFileSync(ENV_PATH, 'utf8')), deploymentOverrides);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
