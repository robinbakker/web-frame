import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  FrameThisConnection,
  compareVersions,
  connectedRenderPolicy,
  isAllowedDisplayUrl,
  isAllowedRenderRequest,
  isPrivateIpv4,
  parseDeviceConfig,
  readFrameThisToken,
  removeFrameThisToken,
  renderReason,
  saveFrameThisToken,
  useTokenFileOnly,
  versionNotice,
} from '../dist/frame-this.js';

const TOKEN = `ftd_${'a'.repeat(43)}`;
const OTHER_TOKEN = `ftd_${'b'.repeat(43)}`;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DISPLAY_URL = 'https://framethis.link/@robin/living-room?exp=1794001800&sig=abc';
const ART_URL = 'https://framethis.link/img?u=daily-art';

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

const tvEntry = (overrides = {}) => ({
  tvIp: '192.168.1.50',
  channelId: 'ovMJG5GcaV',
  size: '3840x2160',
  displayUrl: DISPLAY_URL,
  displayUrlExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  contentVersion: 'v1',
  refreshAfter: 3600,
  nextChangeAt: null,
  ...overrides,
});

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('only Frame This display pages are rendered, and they load only from the allowlisted origins', (t) => {
  setEnv(t, { FRAME_THIS_DEV_ORIGIN: undefined });
  assert.equal(isAllowedDisplayUrl(DISPLAY_URL), true);
  for (const url of [
    'http://framethis.link/@robin/living-room',
    'https://framethis.link.evil.test/@robin/x',
    'https://evil.test/@robin/x',
    'https://framethis.link/api/v1/me',
    'https://user:pass@framethis.link/@robin/x',
    'https://framethis.link:8443/@robin/x',
    'https://api.framethis.link/@robin/x',
    'http://192.168.1.1/',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(isAllowedDisplayUrl(url), false, url);
  }

  for (const url of [
    DISPLAY_URL,
    'https://api.framethis.link/img?u=https%3A%2F%2Fexample.test%2Fa.jpg',
    'https://fonts.googleapis.com/css2?family=Inter',
    'https://fonts.gstatic.com/s/inter/v1/inter.woff2',
    'data:image/png;base64,iVBORw0KGgo=',
  ]) {
    assert.equal(isAllowedRenderRequest(url), true, url);
  }
  for (const url of [
    'http://127.0.0.1:5000/',
    'http://localhost/',
    'http://[::1]/',
    'https://192.168.1.1/',
    'http://10.0.0.1/admin',
    'https://169.254.169.254/latest/meta-data/',
    'http://0x7f.1/',
    'https://openweathermap.org/img/wn/01d@2x.png',
    'http://framethis.link/@robin/x',
    'https://framethis.link:444/',
    'wss://framethis.link/',
    'file:///etc/passwd',
    'https://user@framethis.link/',
  ]) {
    assert.equal(isAllowedRenderRequest(url), false, url);
  }
  assert.deepEqual(connectedRenderPolicy().origins, [
    'https://framethis.link',
    'https://api.framethis.link',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ]);

  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.50']) assert.equal(isPrivateIpv4(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '169.254.1.1', '192.168.01.1', '192.168.1.256', '::1', 'tv.local', '']) {
    assert.equal(isPrivateIpv4(ip), false, ip);
  }
});

test('FRAME_THIS_DEV_ORIGIN accepts only a loopback origin and replaces both Frame This origins', (t) => {
  // wrangler dev signs display URLs with BETTER_AUTH_URL, http://localhost:8787
  setEnv(t, { FRAME_THIS_DEV_ORIGIN: 'http://localhost:8787' });
  assert.equal(isAllowedDisplayUrl('http://localhost:8787/@robin/x?exp=1&sig=x'), true);
  assert.equal(isAllowedDisplayUrl('http://127.0.0.1:8787/@robin/x?exp=1&sig=x'), false, 'the exact origin, not the address');
  assert.equal(isAllowedDisplayUrl(DISPLAY_URL), false);
  assert.equal(isAllowedRenderRequest('http://localhost:8787/img?u=x'), true);
  assert.equal(isAllowedRenderRequest('http://localhost:5000/'), false, 'another port on loopback');
  process.env.FRAME_THIS_DEV_ORIGIN = 'http://127.0.0.1:8787';
  assert.equal(isAllowedDisplayUrl('http://127.0.0.1:8787/@robin/x?exp=1&sig=x'), true);
  for (const value of ['https://example.test', 'http://192.168.1.10:8787', 'http://127.0.0.1:8787/path', 'nonsense']) {
    process.env.FRAME_THIS_DEV_ORIGIN = value;
    assert.throws(() => isAllowedDisplayUrl(DISPLAY_URL), /FRAME_THIS_DEV_ORIGIN/, value);
  }
});

test('the config is validated: unknown fields are dropped, timings clamped, invalid TVs skipped', (t) => {
  setEnv(t, { FRAME_THIS_DEV_ORIGIN: undefined });
  const config = parseDeviceConfig({
    protocolVersion: 1,
    latestVersion: '1.2.3',
    minVersion: '1.0.0',
    pollAfter: 5,
    command: 'rm -rf /',
    updateUrl: 'https://evil.test/Web-Frame-Setup.exe',
    environment: { CHROMIUM_SANDBOX: 'false' },
    tvs: [
      tvEntry({ chromiumFlags: ['--no-sandbox'], script: 'alert(1)' }),
      tvEntry({ tvIp: '192.168.1.51', size: '1280x720' }),
      tvEntry({ tvIp: '8.8.8.8' }),
      tvEntry({ tvIp: '192.168.1.52', displayUrl: 'https://evil.test/@robin/x' }),
      tvEntry({ tvIp: '192.168.1.53', refreshAfter: 1, nextChangeAt: '2026-11-06T23:00:00.000Z' }),
      tvEntry({ contentVersion: 'duplicate' }),
      'not a TV',
    ],
  });
  assert.deepEqual(Object.keys(config).sort(), ['latestVersion', 'minVersion', 'pollAfter', 'skippedTvs', 'tvs']);
  assert.equal(config.pollAfter, 60);
  assert.deepEqual(config.tvs.map((tv) => tv.tvIp), ['192.168.1.50', '192.168.1.53']);
  assert.deepEqual(Object.keys(config.tvs[0]).sort(), [
    'channelId', 'contentVersion', 'displayUrl', 'displayUrlExpiresAt', 'nextChangeAt', 'refreshAfter', 'size', 'tvIp',
  ]);
  assert.equal(config.tvs[0].contentVersion, 'v1', 'the first entry for an address wins');
  assert.equal(config.tvs[1].refreshAfter, 60);
  assert.equal(config.tvs[1].nextChangeAt, Date.parse('2026-11-06T23:00:00.000Z'));
  assert.equal(config.skippedTvs, 5);

  const lenient = parseDeviceConfig({ latestVersion: 'banana', pollAfter: 99_999, tvs: [] });
  assert.equal(lenient.pollAfter, 3600);
  assert.equal(lenient.latestVersion, null);
  assert.equal(lenient.minVersion, null);
  assert.equal(parseDeviceConfig({ tvs: [] }).pollAfter, 60);
  for (const input of [null, 'config', {}, { tvs: 'x' }, { tvs: Array(65).fill(tvEntry()) }]) {
    assert.throws(() => parseDeviceConfig(input), /can't read/);
  }
});

test('render timing: a content change, refreshAfter, or a passed nextChangeAt', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const tv = parseDeviceConfig({ tvs: [tvEntry({ refreshAfter: 3600 })] }).tvs[0];
  assert.equal(renderReason(tv, undefined, now), 'first render');
  const last = { at: now, contentVersion: 'v1' };
  assert.equal(renderReason(tv, last, now + 59 * 60_000), null);
  assert.equal(renderReason({ ...tv, contentVersion: 'v2' }, last, now + 1000), 'content changed');
  assert.equal(renderReason(tv, last, now + 3600_000), 'refresh');
  const scheduled = { ...tv, nextChangeAt: now + 120_000 };
  assert.equal(renderReason(scheduled, last, now + 119_000), null);
  assert.equal(renderReason(scheduled, last, now + 120_000), 'scheduled change');
  assert.equal(renderReason(scheduled, { ...last, at: now + 121_000 }, now + 180_000), null, 'already rendered after it');
});

test('version notices compare semver, with pre-releases before their release', () => {
  assert.ok(compareVersions('1.0.2', '1.0.10') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareVersions('1.1.0-beta.1', '1.1.0') < 0);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  const config = (latestVersion, minVersion) => ({ latestVersion, minVersion, pollAfter: 60, tvs: [], skippedTvs: 0 });
  assert.equal(versionNotice(config('1.0.2', '1.0.0'), '1.0.2'), null);
  assert.match(versionNotice(config('1.2.0', '1.0.0'), '1.0.2'), /Update available: Web Frame 1\.2\.0/);
  assert.match(versionNotice(config('1.2.0', '1.1.0'), '1.0.2'), /Update required/);
  assert.equal(versionNotice(null), null);
});

test('the token is read from FRAME_THIS_TOKEN or saved in the data dir with user-only access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-frame-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  setEnv(t, { WEB_FRAME_DATA_DIR: root, FRAME_THIS_TOKEN: undefined });
  assert.equal(readFrameThisToken(), null);
  await assert.rejects(saveFrameThisToken('ftd_short'), /connect code/);
  await saveFrameThisToken(TOKEN);
  assert.equal(readFrameThisToken(), TOKEN);
  if (process.platform !== 'win32') assert.equal((await stat(join(root, 'frame-this-token'))).mode & 0o777, 0o600);
  process.env.FRAME_THIS_TOKEN = ` ${OTHER_TOKEN} `;
  assert.equal(readFrameThisToken(), OTHER_TOKEN, 'the launcher environment wins');
  // The desktop app: unlinking removes the token file, and a token in its .env mustn't bring it back.
  useTokenFileOnly();
  t.after(() => useTokenFileOnly(false));
  assert.equal(readFrameThisToken(), TOKEN);
  await removeFrameThisToken();
  assert.equal(readFrameThisToken(), null);
  useTokenFileOnly(false);
  delete process.env.FRAME_THIS_TOKEN;
  await removeFrameThisToken();
  await removeFrameThisToken();
  assert.equal(readFrameThisToken(), null);
});

test('the connection sends the token only to the device API, uses the ETag, and stops when unlinked', async (t) => {
  setEnv(t, { FRAME_THIS_TOKEN: TOKEN, FRAME_THIS_DEV_ORIGIN: undefined, WEB_FRAME_PLATFORM: 'docker' });
  const requests = [];
  let reply = () => json(200, { protocolVersion: 1, pollAfter: 60, tvs: [tvEntry()] }, { ETag: '"c1"' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init });
    return reply();
  });
  const connection = new FrameThisConnection();

  await connection.poll(0);
  assert.equal(requests[0].url, 'https://api.framethis.link/api/device/v1/config');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[0].init.headers['User-Agent'], `web-frame/${VERSION} (docker)`);
  assert.equal(requests[0].init.redirect, 'error', 'a redirect could carry the token elsewhere');
  assert.equal(requests[0].init.headers['If-None-Match'], undefined);
  assert.equal(connection.config.tvs.length, 1);

  await connection.poll(30_000);
  assert.equal(requests.length, 1, 'not due before pollAfter');
  reply = () => new Response(null, { status: 304 });
  await connection.poll(60_000);
  assert.equal(requests[1].init.headers['If-None-Match'], '"c1"');
  assert.equal(connection.config.tvs.length, 1, '304 keeps the config');

  reply = () => {
    throw new TypeError('fetch failed');
  };
  await connection.poll(120_000);
  assert.match(connection.pollError, /Can't reach Frame This/);
  assert.equal(connection.config.tvs.length, 1, 'a failed poll keeps the last config');

  reply = () => new Response('{}', { status: 429, headers: { 'Retry-After': '600' } });
  await connection.poll(180_000);
  await connection.poll(180_000 + 599_000);
  assert.equal(requests.length, 4, 'waits for Retry-After');

  reply = () => new Response(null, { status: 204 });
  const status = { scheduler: { state: 'running', message: 'TV in Art Mode' }, tvs: [], discoveredTvs: [] };
  await connection.report(status, 1_000_000);
  const post = requests.at(-1);
  assert.equal(post.url, 'https://api.framethis.link/api/device/v1/status');
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { protocolVersion: 1, appVersion: VERSION, ...status });
  await connection.report(status, 1_010_000);
  assert.equal(requests.length, 5, 'an unchanged status waits for the heartbeat');
  await connection.report(status, 1_000_000 + 5 * 60_000);
  assert.equal(requests.length, 6);
  await connection.report({ ...status, scheduler: { state: 'paused' } }, 1_400_000);
  assert.equal(requests.length, 7, 'a change is sent at once');

  reply = () => json(401, { error: 'Unauthorized' });
  await connection.poll(10_000_000);
  assert.equal(connection.linkProblem, 'unlinked');
  assert.equal(connection.config, null);
  await connection.poll(20_000_000);
  await connection.report(status, 20_000_000);
  assert.equal(requests.length, 8, 'no requests until the token changes');

  // Linked again with the same code (the desktop app), which Frame This accepts by now.
  connection.relinked();
  reply = () => json(200, { tvs: [] });
  await connection.poll(20_000_000);
  assert.equal(connection.linkProblem, null);
  assert.equal(requests.length, 9);
  assert.equal(requests.at(-1).init.headers.Authorization, `Bearer ${TOKEN}`);

  process.env.FRAME_THIS_TOKEN = OTHER_TOKEN;
  reply = () => json(200, { tvs: [] });
  await connection.poll(20_000_000);
  assert.equal(connection.linkProblem, null);
  assert.equal(requests.at(-1).init.headers.Authorization, `Bearer ${OTHER_TOKEN}`);
  assert.equal(requests.at(-1).init.headers['If-None-Match'], undefined);

  process.env.FRAME_THIS_TOKEN = 'not-a-connect-code';
  await connection.poll(30_000_000);
  assert.equal(connection.linkProblem, 'invalid-token');
  assert.equal(requests.length, 10, 'a malformed token is never sent');
});

test('with a render policy, Playwright runs without JavaScript and every other host goes to a dead proxy', async (t) => {
  setEnv(t, { FRAME_THIS_DEV_ORIGIN: undefined });
  const root = await mkdtemp(join(tmpdir(), 'web-frame-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let launchOptions;
  let pageOptions;
  let routeHandler;
  let proxyDropsConnections;
  const routed = [];
  const fakeRoute = (url, resourceType = 'image') => ({
    request: () => ({ url: () => url, resourceType: () => resourceType, method: () => 'GET' }),
    abort: async (code) => routed.push(`abort ${code} ${url}`),
    continue: async () => routed.push(`continue ${url}`),
    fulfill: async () => routed.push(`fulfill ${url}`),
  });
  t.mock.module('playwright', {
    namedExports: {
      chromium: {
        launch: async (options) => {
          launchOptions = options;
          // The proxy must be a dead end while the browser runs.
          const { port } = new URL(options.proxy?.server ?? 'http://127.0.0.1:9');
          proxyDropsConnections = await new Promise((resolve) => {
            const socket = connect(Number(port), '127.0.0.1', () => socket.write('GET http://192.168.1.1/ HTTP/1.1\r\n\r\n'));
            socket.on('data', () => resolve(false));
            socket.on('close', () => resolve(true));
            socket.on('error', () => resolve(true));
          });
          return {
            newPage: async (options) => {
              pageOptions = options;
              return {
                route: async (_pattern, handler) => {
                  routeHandler = handler;
                },
                on() {},
                goto: async () => {
                  for (const [url, type] of [
                    [DISPLAY_URL, 'document'],
                    ['https://fonts.gstatic.com/s/inter.woff2', 'font'],
                    ['http://127.0.0.1:5000/', 'image'],
                    ['https://openweathermap.org/img/wn/01d.png', 'image'],
                    [ART_URL, 'image'],
                  ]) {
                    await routeHandler(fakeRoute(url, type));
                  }
                },
                waitForTimeout: async () => {},
                screenshot: async ({ path }) => writeFile(path, 'png'),
              };
            },
            close: async () => {},
          };
        },
      },
    },
  });
  const { screenshotUrl } = await import('../dist/screenshot.js');
  const output = join(root, 'out.png');
  const settings = { CONTENT_WIDTH: '3840', CONTENT_HEIGHT: '2160', OUTPUT_WIDTH: '1920', PLAYWRIGHT_NETWORK_CACHE_DIR: join(root, 'cache') };
  const policy = connectedRenderPolicy();
  // A cached copy of yesterday's art, which Frame This changes under the same URL
  await mkdir(join(root, 'cache'), { recursive: true });
  await writeFile(join(root, 'cache', `${createHash('sha256').update(ART_URL).digest('hex')}.img`), 'yesterday');

  await assert.rejects(screenshotUrl('https://evil.test/@robin/x', output, settings, { policy }), /allowed origins/);
  assert.equal(launchOptions, undefined, 'refused before the browser starts');

  await screenshotUrl(DISPLAY_URL, output, settings, { policy });
  assert.equal(pageOptions.javaScriptEnabled, false);
  assert.equal(pageOptions.deviceScaleFactor, 0.5);
  assert.equal(
    launchOptions.proxy.bypass,
    '<-loopback>,https://framethis.link,https://api.framethis.link,https://fonts.googleapis.com,https://fonts.gstatic.com',
  );
  assert.match(launchOptions.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(proxyDropsConnections, true);
  assert.deepEqual(routed, [
    `continue ${DISPLAY_URL}`,
    'continue https://fonts.gstatic.com/s/inter.woff2',
    'abort blockedbyclient http://127.0.0.1:5000/',
    'abort blockedbyclient https://openweathermap.org/img/wn/01d.png',
    `continue ${ART_URL}`,
  ], 'images load fresh: the cached copy is not used');

  // Without a policy (standalone), nothing changes.
  launchOptions = undefined;
  await screenshotUrl(DISPLAY_URL, output, settings);
  assert.equal(launchOptions.proxy, undefined);
  assert.equal(pageOptions.javaScriptEnabled, undefined);
  assert.equal(routed.at(-1), `fulfill ${ART_URL}`, 'standalone keeps the image cache');
});

test('connected scheduler: verified TVs only, server-driven timing, guarded rendering and status', async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const root = await mkdtemp(new URL('../output/connected-', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
  const moduleUrl = (name) => pathToFileURL(join(root, 'dist', name)).href;
  setEnv(t, { FRAME_THIS_TOKEN: TOKEN, FRAME_THIS_DEV_ORIGIN: undefined, WEB_FRAME_PLATFORM: undefined });

  t.mock.module(moduleUrl('env.js'), { namedExports: { loadEnv: () => {}, getDataDir: () => join(root, 'output') } });
  const { PageStatusError } = await import(moduleUrl('content-url.js'));
  const captures = [];
  // The HTTP status a display page answers with
  let pageStatus = () => 200;
  t.mock.module(moduleUrl('screenshot.js'), {
    namedExports: {
      screenshotUrl: async (url, path, settings, options) => {
        captures.push({ url, settings, options });
        const status = pageStatus(url);
        if (status >= 400) throw new PageStatusError(status, url);
        await writeFile(path, `image-${captures.length}`);
        return path;
      },
    },
  });
  const sessions = [];
  const uploads = [];
  let artMode = true;
  const realTv = await import(moduleUrl('tv.js'));
  t.mock.module(moduleUrl('tv.js'), {
    namedExports: {
      ...realTv,
      createClient: async (host) => {
        sessions.push(host);
        return {
          inArtMode: async () => artMode,
          upload: async (buffer) => {
            uploads.push(buffer.toString());
            return `art-${uploads.length}`;
          },
          setCurrentArt: async () => {},
          getAvailableArt: async () => [],
          close: async () => {},
        };
      },
    },
  });
  const realDiscover = await import(moduleUrl('discover.js'));
  let scans = 0;
  t.mock.module(moduleUrl('discover.js'), {
    namedExports: {
      ...realDiscover,
      // No real network scan in a test: the results, a public address among them
      findSamsungTvs: async () => {
        scans++;
        return [
          { ip: '192.168.1.60', model: 'QE65LS03BAUXXN', name: 'Bedroom', frameTv: true },
          { ip: '8.8.8.8', model: 'Elsewhere', frameTv: true },
        ];
      },
    },
  });

  let config = {
    protocolVersion: 1,
    latestVersion: '99.0.0',
    minVersion: null,
    pollAfter: 60,
    tvs: [
      tvEntry({ size: '1920x1080' }),
      // Not a Samsung TV: never connected to, whatever the config says
      tvEntry({ tvIp: '192.168.1.1', channelId: 'router' }),
    ],
  };
  let configStatus = 200;
  const configRequests = [];
  const statusPosts = [];
  const probes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const target = String(url);
    if (target === 'https://api.framethis.link/api/device/v1/config') {
      configRequests.push(init);
      if (configStatus !== 200) return json(configStatus, { error: 'Unauthorized' });
      return json(200, config, { ETag: `"${JSON.stringify(config).length}"` });
    }
    if (target === 'https://api.framethis.link/api/device/v1/status') {
      statusPosts.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (target.endsWith(':8001/api/v2/')) {
      probes.push(target);
      if (target.startsWith('http://192.168.1.50:')) {
        return json(200, {
          device: { type: 'Samsung SmartTV', modelName: 'QE55LS03BAUXXN', name: 'Living room', firmwareVersion: 'T-NKM2DEUC-1234.5', FrameTVSupport: 'true' },
          type: 'Samsung SmartTV',
        });
      }
      return new Response('<html>Router login</html>', { status: 200 });
    }
    throw new Error(`Unexpected request: ${target}`);
  });

  const app = await import(moduleUrl('app.js'));

  await app.runConnectedCheck();
  assert.equal(configRequests.length, 1);
  assert.deepEqual(sessions, ['192.168.1.50'], 'only the verified TV is connected to');
  assert.deepEqual(probes, ['http://192.168.1.50:8001/api/v2/', 'http://192.168.1.1:8001/api/v2/']);
  assert.equal(captures.length, 1);
  const [capture] = captures;
  assert.equal(capture.url, DISPLAY_URL);
  assert.equal(capture.settings.CONTENT_WIDTH, '3840');
  assert.equal(capture.settings.OUTPUT_WIDTH, '1920');
  assert.equal(capture.settings.OUTPUT_HEIGHT, '1080');
  assert.equal(capture.options.policy.allowRequest('http://127.0.0.1:5000/'), false);
  assert.equal(capture.options.policy.allowRequest(DISPLAY_URL), true);
  assert.deepEqual(uploads, ['image-1']);
  assert.equal(scans, 1);

  assert.equal(statusPosts.length, 1);
  const [status] = statusPosts;
  assert.equal(status.protocolVersion, 1);
  assert.equal(status.scheduler.state, 'running');
  assert.deepEqual(status.tvs[0], {
    tvIp: '192.168.1.50',
    reachable: true,
    artMode: true,
    model: 'QE55LS03BAUXXN',
    lastUploadAt: status.tvs[0].lastUploadAt,
    contentVersion: 'v1',
    lastError: null,
  });
  assert.ok(Date.parse(status.tvs[0].lastUploadAt));
  assert.deepEqual(status.tvs[1], {
    tvIp: '192.168.1.1', reachable: false, artMode: null, lastUploadAt: null, contentVersion: null, lastError: null,
  });
  assert.deepEqual(status.discoveredTvs, [
    { ip: '192.168.1.60', model: 'QE65LS03BAUXXN', name: 'Bedroom' },
    { ip: '192.168.1.50', model: 'QE55LS03BAUXXN', name: 'Living room' },
  ], 'verified TVs only, and only private addresses');
  assert.match(app.getConnectedSnapshot().notice, /Update available: Web Frame 99\.0\.0/);

  // Nothing is due: no poll before pollAfter, no render before refreshAfter, no unchanged status.
  await app.runConnectedCheck();
  assert.equal(configRequests.length, 1);
  assert.equal(captures.length, 1);
  assert.equal(statusPosts.length, 1);
  assert.equal(scans, 1);

  // Run Now renders whatever the timing; an unchanged image isn't uploaded again.
  await app.runConnectedCheck({ force: true });
  assert.equal(captures.length, 2);
  assert.deepEqual(uploads, ['image-1', 'image-2']);

  // A TV outside Art Mode is left alone.
  artMode = false;
  await app.runConnectedCheck({ force: true });
  assert.equal(captures.length, 2);
  assert.equal(app.getConnectedSnapshot().tvs[0].artMode, false);
  artMode = true;

  // A content change renders on the next poll.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  config = { ...config, tvs: [tvEntry({ contentVersion: 'v2', displayUrlExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString() })] };
  await app.runConnectedCheck();
  assert.equal(configRequests.length, 2);
  assert.equal(configRequests[1].headers['If-None-Match'] !== undefined, true);
  assert.equal(captures.length, 3);
  assert.equal(statusPosts.at(-1).tvs.length, 1, 'a TV dropped from the config is no longer reported');
  assert.equal(statusPosts.at(-1).tvs[0].contentVersion, 'v2');

  // An expired display URL that can't be refreshed isn't rendered.
  t.mock.timers.setTime(Date.now() + 20 * 60_000);
  configStatus = 503;
  await app.runConnectedCheck({ force: true });
  assert.equal(captures.length, 3);
  assert.match(app.getConnectedSnapshot().tvs[0].lastError, /display link expired/);

  // The display page answers 404 (this computer's clock is behind, say). Nothing is uploaded: the bridge
  // fetches the config again, and renders once more with the new link Frame This has signed meanwhile.
  const linkWithSig = (sig) => DISPLAY_URL.replace('sig=abc', `sig=${sig}`);
  configStatus = 200;
  t.mock.timers.setTime(Date.now() + 61_000);
  config = { ...config, tvs: [tvEntry({ contentVersion: 'v3', displayUrl: linkWithSig('stale') })] };
  pageStatus = (url) => {
    if (url !== linkWithSig('stale')) return 200;
    config = { ...config, tvs: [tvEntry({ contentVersion: 'v3', displayUrl: linkWithSig('fresh') })] };
    return 404;
  };
  let polls = configRequests.length;
  let uploaded = uploads.length;
  await app.runConnectedCheck();
  assert.equal(configRequests.length, polls + 2, 'the scheduled poll, and one for a new link');
  assert.deepEqual(captures.slice(-2).map(({ url }) => url), [linkWithSig('stale'), linkWithSig('fresh')]);
  assert.equal(uploads.length, uploaded + 1);
  assert.equal(uploads.at(-1), `image-${captures.length}`, 'only the working page reached the TV');
  assert.equal(app.getConnectedSnapshot().tvs[0].lastError, null);
  assert.equal(statusPosts.at(-1).tvs[0].contentVersion, 'v3');

  // Frame This has no newer link: no second try, nothing uploaded, and the next check tries again.
  t.mock.timers.setTime(Date.now() + 61_000);
  config = { ...config, tvs: [tvEntry({ contentVersion: 'v4', displayUrl: linkWithSig('broken') })] };
  pageStatus = (url) => (url === linkWithSig('broken') ? 404 : 200);
  let rendered = captures.length;
  uploaded = uploads.length;
  await app.runConnectedCheck();
  assert.equal(captures.length, rendered + 1);
  assert.equal(uploads.length, uploaded);
  assert.equal(app.getConnectedSnapshot().tvs[0].lastError, 'Frame This answered HTTP 404 for the display page');
  assert.equal(statusPosts.at(-1).tvs[0].contentVersion, 'v3', 'the TV still shows v3');
  pageStatus = () => 200;
  t.mock.timers.setTime(Date.now() + 61_000);
  await app.runConnectedCheck();
  assert.equal(captures.length, rendered + 2);
  assert.equal(uploads.length, uploaded + 1);
  assert.equal(statusPosts.at(-1).tvs[0].contentVersion, 'v4');

  // A server error isn't about the link: no new config is fetched for it.
  t.mock.timers.setTime(Date.now() + 61_000);
  config = { ...config, tvs: [tvEntry({ contentVersion: 'v5', displayUrl: linkWithSig('v5') })] };
  pageStatus = () => 502;
  polls = configRequests.length;
  rendered = captures.length;
  await app.runConnectedCheck();
  assert.equal(configRequests.length, polls + 1, 'only the scheduled poll');
  assert.equal(captures.length, rendered + 1);
  assert.equal(app.getConnectedSnapshot().tvs[0].lastError, 'Frame This answered HTTP 502 for the display page');
  pageStatus = () => 200;

  // Unlinked in Frame This: polling stops, and the status and the log (once) say so.
  const errors = t.mock.method(console, 'error', () => {});
  configStatus = 401;
  t.mock.timers.setTime(Date.now() + 61_000);
  await app.runConnectedCheck();
  assert.equal(app.getConnectedSnapshot().linkProblem, 'unlinked');
  assert.match(app.getSchedulerStatus(), /link this bridge again/i);
  polls = configRequests.length;
  t.mock.timers.setTime(Date.now() + 61_000);
  await app.runConnectedCheck();
  assert.equal(configRequests.length, polls);
  const logged = errors.mock.calls.map(({ arguments: args }) => args.join(' '));
  assert.equal(logged.filter((line) => /link this bridge again/i.test(line)).length, 1);
  assert.equal((await readFile(app.getDefaultImage(), 'utf8')).startsWith('image-'), true);
});
