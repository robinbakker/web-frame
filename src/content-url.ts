export function isHttpsContentUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateImageUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('IMAGE_URL must be an HTTPS URL without embedded credentials'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('IMAGE_URL must be an HTTPS URL without embedded credentials');
  }
}

/**
 * Restrictions for rendering a page the user didn't choose themselves (connected mode, see
 * frame-this.ts). With a policy, the page runs without JavaScript.
 */
export interface RenderPolicy {
  /** Called for every request, the page's own and each redirect hop; false aborts it. */
  allowRequest(url: string): boolean;
  /** The http(s) origins the browser may connect to at all. */
  origins: readonly string[];
}

export interface CaptureOptions {
  policy?: RenderPolicy;
}

/**
 * The page on screen answered with an HTTP error (400 or above). Both screenshot providers throw this
 * instead of capturing, so an error page never becomes the artwork and the TV keeps its last image.
 */
export class PageStatusError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`Page answered HTTP ${status}: ${url}`);
    this.name = 'PageStatusError';
    this.status = status;
  }
}

/** The URL check both screenshot providers make before loading anything. */
export function assertCapturableUrl(url: string, policy?: RenderPolicy): void {
  if (!policy) {
    if (!isHttpsContentUrl(url)) throw new Error('CONTENT_URL must be an HTTPS URL');
  } else if (!/^https?:\/\//i.test(url) || !policy.allowRequest(url)) {
    throw new Error('Refusing to render a page outside the allowed origins');
  }
}
