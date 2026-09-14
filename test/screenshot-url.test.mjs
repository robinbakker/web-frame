import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenshotUrl } from '../dist/screenshot.js';
import { isHttpsContentUrl } from '../dist/content-url.js';

test('screenshot rejects non-HTTPS content before loading settings or launching a browser', async () => {
  for (const url of ['http://example.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'invalid']) {
    await assert.rejects(screenshotUrl(url, 'unused.png'), { message: 'CONTENT_URL must be an HTTPS URL' });
  }
  assert.equal(isHttpsContentUrl('https://example.test/'), true);
  assert.equal(isHttpsContentUrl('HTTPS://example.test/'), true);
});
