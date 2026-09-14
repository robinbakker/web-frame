import { mock } from 'node:test';
import { png } from './png-fixtures.mjs';
export const bytes = png;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).startsWith('https://example.test/')
  ? Promise.resolve(new Response(bytes)) : realFetch(url, options);
// Load the real TV module AND its transitive production dependencies before
// mocking only the connection boundary. No TV connection is made.
const tv = await import('./dist/tv.js');
mock.module(new URL('./dist/tv.js', import.meta.url).href, { namedExports: { ...tv, createClient: async () => ({
  inArtMode: async () => true, upload: async () => 'mock-art', setCurrentArt: async () => {},
  getAvailableArt: async () => [], close: async () => {},
}) } });
