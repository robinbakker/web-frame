export { validateImageUrl } from './content-url.js';
import { isHttpsContentUrl, validateImageUrl } from './content-url.js';
import { downloadImage } from './image-download.js';
import { screenshotUrl } from './screenshot.js';

export type ImageSource = 'website-screenshot' | 'png-image-url';

export function resolveImageSource(value?: string): ImageSource {
  if (!value || value === 'website-screenshot') return 'website-screenshot';
  if (value === 'png-image-url') return 'png-image-url';
  throw new Error('IMAGE_SOURCE must be website-screenshot or png-image-url');
}

export function validateSourceSettings(settings: NodeJS.ProcessEnv): ImageSource {
  const source = resolveImageSource(settings.IMAGE_SOURCE);
  if (source === 'png-image-url') validateImageUrl(settings.IMAGE_URL ?? '');
  else if (!isHttpsContentUrl(settings.CONTENT_URL ?? '')) throw new Error('CONTENT_URL must be an HTTPS URL');
  return source;
}

export async function acquireImage(settings: NodeJS.ProcessEnv, outputPath: string): Promise<void> {
  const source = validateSourceSettings(settings);
  if (source === 'png-image-url') await downloadImage(settings.IMAGE_URL!, outputPath);
  else await screenshotUrl(settings.CONTENT_URL!, outputPath, settings);
}
