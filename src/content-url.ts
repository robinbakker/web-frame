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
