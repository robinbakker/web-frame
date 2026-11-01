import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { WSConnector } from 'samsung-frame-connect/connections/ws.js';

test('a dropped TV connection is never reconnected in the background', async (t) => {
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  const tokenDir = await mkdtemp(new URL('../output/tv-client-', import.meta.url));
  t.after(() => rm(tokenDir, { recursive: true, force: true }));
  const oldTokenDir = process.env.WEB_FRAME_TOKEN_DIR;
  process.env.WEB_FRAME_TOKEN_DIR = tokenDir;
  t.after(() => {
    if (oldTokenDir === undefined) delete process.env.WEB_FRAME_TOKEN_DIR;
    else process.env.WEB_FRAME_TOKEN_DIR = oldTokenDir;
  });

  // The library's real connector, behind an endpoint whose connect() succeeds without a TV.
  class ArtModeEndpoint extends EventEmitter {
    constructor(args) {
      super();
      this.connection = new WSConnector({ ...args, name: `${args.name}Art`, endpoint: 'com.samsung.art-app', verbosity: 0 });
    }
    async connect() {}
    close() {}
  }
  t.mock.module('samsung-frame-connect/endpoints/art-mode.js', { namedExports: { ArtModeEndpoint } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createClient } = await import('../dist/tv.js');

  const client = await createClient('192.0.2.1');
  let reconnects = 0;
  client.connection.connect = async () => { reconnects++; };
  // The close code the socket reports when the TV drops it, or when close() aborts a connection
  // that is still being set up. The library would schedule a reconnect 3s later.
  client.connection.closed({ code: 1006 });
  t.mock.timers.tick(60_000);
  assert.equal(reconnects, 0);
});
