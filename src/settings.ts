import { open, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { validateCredentials } from './auth.js';
import { JobQueue } from './job-queue.js';
import { parseEnv, updateEnv } from './env-file.js';
import { resolveImageSource, validateImageUrl, validateSourceSettings } from './image-source.js';
import { isHttpsContentUrl } from './content-url.js';
import { DEPLOYMENT_KEYS } from './deployment-settings.js';

export const CONFIG_KEYS = [
  'IMAGE_SOURCE', 'IMAGE_URL', 'TV_IP', 'CONTENT_URL', 'CONTENT_WIDTH', 'CONTENT_HEIGHT', 'OUTPUT_WIDTH', 'OUTPUT_HEIGHT',
  'SCHEDULE_INTERVAL', 'AUTH_USER', 'AUTH_PASS',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type Config = Record<ConfigKey, string>;
type Settings = Partial<Config>;

export class ConfigValidationError extends Error {}

function validateUpdates(input: unknown): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('Expected a configuration object');
  }
  const updates: Settings = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new ConfigValidationError(`Unknown configuration key: ${key}`);
    }
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new ConfigValidationError(`Invalid value for ${key}: expected a string without line breaks`);
    }
    if (key === 'TV_IP' && value && !isIP(value)) {
      throw new ConfigValidationError('TV_IP must be an IP address');
    }
    if (key === 'CONTENT_URL' && value && !isHttpsContentUrl(value)) {
      throw new ConfigValidationError('CONTENT_URL must be an HTTPS URL');
    }
    try {
      if (key === 'IMAGE_SOURCE') resolveImageSource(value);
      if (key === 'IMAGE_URL' && value) validateImageUrl(value);
    } catch (error) { throw new ConfigValidationError((error as Error).message); }
    if (key.endsWith('_WIDTH') || key.endsWith('_HEIGHT')) {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 16384) {
        throw new ConfigValidationError(`${key} must be an integer between 1 and 16384`);
      }
    }
    if (key === 'SCHEDULE_INTERVAL') {
      const match = value.match(/^([1-9]\d*)(m|h|d)$/);
      const units = { m: 60_000, h: 3_600_000, d: 86_400_000 };
      if (!match || !Number.isSafeInteger(Number(match[1]) * units[match[2] as keyof typeof units])) {
        throw new ConfigValidationError('SCHEDULE_INTERVAL must be a positive duration such as 10m, 1h, or 1d');
      }
    }
    updates[key as ConfigKey] = value;
  }
  return updates;
}

/** Write the existing file in place so Docker's single-file bind mount stays valid. */
async function writeSettings(path: string, text: string): Promise<void> {
  const file = await open(path, 'w', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

export class SettingsStore {
  private saves = new JobQueue();

  constructor(private path: string, private environment: NodeJS.ProcessEnv = process.env) {}

  async save(input: unknown): Promise<void> {
    const updates = validateUpdates(input);
    // An empty password means keep the existing credential, as in the admin form.
    if (updates.AUTH_PASS === '') delete updates.AUTH_PASS;
    return this.saves.run(async () => {
      let text = '';
      try {
        text = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const next = { ...parseEnv(text), ...updates };
      try {
        if (['IMAGE_SOURCE', 'IMAGE_URL', 'CONTENT_URL'].some((key) => key in updates)) {
          validateSourceSettings({ ...this.environment, ...next });
        }
        validateCredentials(next.AUTH_USER ?? this.environment.AUTH_USER, next.AUTH_PASS ?? this.environment.AUTH_PASS);
      } catch (error) {
        throw new ConfigValidationError((error as Error).message);
      }
      // Validate and serialize the whole document before opening/truncating .env.
      await writeSettings(this.path, updateEnv(text, updates));
      // Deployment values were resolved by loadEnv at startup/reload. A UI save
      // must not copy their lower-priority .env values back over launcher values.
      for (const [key, value] of Object.entries(next)) {
        if (!(DEPLOYMENT_KEYS as readonly string[]).includes(key)) this.environment[key] = value;
      }
    });
  }
}
