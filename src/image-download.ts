import { writeFile } from 'node:fs/promises';
import { validateImageUrl } from './content-url.js';

class ImageDownloadError extends Error {}

export const IMAGE_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  redirects: 5,
  bytes: 32 * 1024 * 1024,
  dimension: 16_384,
  pixels: 40_000_000,
});

/** Basic identification and declared-size checks only; image data is not decoded. */
export function validatePngHeader(bytes: Buffer): void {
  if (bytes.length > IMAGE_LIMITS.bytes) throw new ImageDownloadError('Image exceeds the 32 MiB limit');
  if (bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageDownloadError('Image does not have a PNG header');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > IMAGE_LIMITS.dimension || height > IMAGE_LIMITS.dimension ||
      width * height > IMAGE_LIMITS.pixels) {
    throw new ImageDownloadError('PNG dimensions exceed the 16384 per-axis or 40 million pixel limit');
  }
}

export async function downloadImage(url: string, outputPath: string): Promise<void> {
  validateImageUrl(url);
  const signal = AbortSignal.timeout(IMAGE_LIMITS.timeoutMs);
  let response: Response | undefined;
  try {
    for (let redirects = 0;; redirects++) {
      response = await fetch(url, {
        redirect: 'manual', signal, cache: 'no-store',
        headers: { Accept: 'image/png, application/octet-stream', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects >= IMAGE_LIMITS.redirects) throw new ImageDownloadError('Image redirect limit exceeded or Location missing');
        try { url = new URL(location, url).href; } catch { throw new ImageDownloadError('Invalid image redirect URL'); }
        try { validateImageUrl(url); } catch { throw new ImageDownloadError('Invalid image redirect: HTTPS without embedded credentials is required'); }
        continue;
      }
      break;
    }
    if (response.status !== 200) throw new ImageDownloadError(`Image download returned HTTP ${response.status}; expected 200`);
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > IMAGE_LIMITS.bytes)) throw new ImageDownloadError('Image Content-Length exceeds the 32 MiB limit or is invalid');
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (mime && !['image/png', 'application/octet-stream'].includes(mime)) throw new ImageDownloadError('Image response has a conflicting Content-Type; expected PNG');
    if (!response.body) throw new ImageDownloadError('Image response is empty');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        received += value.byteLength;
        if (received > IMAGE_LIMITS.bytes) throw new ImageDownloadError('Image exceeds the 32 MiB limit');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!received) throw new ImageDownloadError('Image response is empty');
    const bytes = Buffer.concat(chunks, received);
    validatePngHeader(bytes);
    signal.throwIfAborted();
    await writeFile(outputPath, bytes).catch(() => {
      throw new ImageDownloadError('Image could not be saved to the temporary output file');
    });
  } catch (error) {
    if (signal.aborted) throw new ImageDownloadError('Image download timed out after 60 seconds');
    // Fetch/stream errors can contain signed URLs. Only our own validation errors
    // are surfaced; network failures use a source label and no upstream details.
    if (error instanceof ImageDownloadError) throw error;
    throw new ImageDownloadError('Image download failed while fetching or reading the response');
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}
