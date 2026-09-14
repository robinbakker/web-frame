import { timingSafeEqual, createHash } from 'node:crypto';

export function validateCredentials(user: unknown, pass: unknown): asserts pass is string {
  if (typeof user !== 'string' || !user.trim() || /[:\r\n\0]/.test(user)) {
    throw new Error('Set AUTH_USER to a non-empty username without colons or line breaks.');
  }
  if (typeof pass !== 'string' || pass.trim().length < 16 || /[\r\n\0]/.test(pass)) {
    throw new Error('Set AUTH_PASS to a unique password of at least 16 characters; default credentials are disabled.');
  }
}

export function authenticate(header: string | undefined, user: string | undefined, pass: string | undefined): boolean {
  try {
    validateCredentials(user, pass);
  } catch {
    return false;
  }
  if (!header?.startsWith('Basic ')) return false;
  const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`${user}:${pass}`));
}
