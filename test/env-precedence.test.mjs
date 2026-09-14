import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from '../dist/env-file.js';

const fileDeployment = {
  SERVER_HOST: '0.0.0.0', SERVER_PORT: '12345',
  SERVER_TLS_CERT: '/local/cert.pem', SERVER_TLS_KEY: '/local/key.pem',
  PLAYWRIGHT_BROWSERS_PATH: '/local/browsers', NODE_ENV: 'development',
};
const cases = [
  ['standard Docker deployment', {
    SERVER_HOST: '0.0.0.0', SERVER_PORT: '33636', SERVER_TLS_CERT: '', SERVER_TLS_KEY: '',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright', NODE_ENV: 'production',
  }, { ...fileDeployment, SERVER_HOST: '127.0.0.1' }],
  ['Synology host networking with partial overrides', { SERVER_HOST: '127.0.0.1', SERVER_PORT: '33636' }, fileDeployment],
  ['local execution with only .env deployment settings', {}, fileDeployment],
];

for (const [name, overrides, initialFile] of cases) {
  test(`${name}: precedence survives reloads and UI saves`, async (t) => {
    await mkdir(new URL('../output/', import.meta.url), { recursive: true });
    const root = await mkdtemp(new URL('../output/env-precedence-', import.meta.url));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(new URL('../dist/', import.meta.url), join(root, 'dist'), { recursive: true });
    const path = join(root, '.env');
    const keys = [...Object.keys(fileDeployment), 'WEB_FRAME_ENV_FILE', 'TV_IP', 'AUTH_USER', 'AUTH_PASS'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    t.after(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, overrides, {
      WEB_FRAME_ENV_FILE: path,
      TV_IP: '192.0.2.99', AUTH_USER: 'launcher-user', AUTH_PASS: 'launcher-password',
    });
    const values = {
      ...initialFile, TV_IP: '192.0.2.1', AUTH_USER: 'admin', AUTH_PASS: 'file-testing-password',
    };
    const serialize = values => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}\n`).join('');
    await writeFile(path, serialize(values));
    const { loadEnv } = await import(pathToFileURL(join(root, 'dist', 'env.js')).href);
    const { SettingsStore } = await import(pathToFileURL(join(root, 'dist', 'settings.js')).href);
    const assertDeployment = (fileValues) => {
      for (const key of Object.keys(fileDeployment)) {
        assert.equal(process.env[key], Object.hasOwn(overrides, key) ? overrides[key] : fileValues[key], key);
      }
    };
    loadEnv();
    assertDeployment(values);
    assert.equal(process.env.TV_IP, values.TV_IP, 'application values still come from .env');
    assert.equal(process.env.AUTH_USER, values.AUTH_USER);
    assert.equal(process.env.AUTH_PASS, values.AUTH_PASS);

    await new SettingsStore(path).save({ TV_IP: '192.0.2.2' });
    assertDeployment(values);
    assert.equal(process.env.TV_IP, '192.0.2.2');
    const saved = parseEnv(await readFile(path, 'utf8'));
    for (const key of Object.keys(fileDeployment)) assert.equal(saved[key], initialFile[key], 'UI saves preserve file fallbacks');
    loadEnv();
    assertDeployment(values);
    assert.equal(process.env.TV_IP, '192.0.2.2');

    // A second file load must not treat deployment values from the first load
    // as launcher overrides. Exercise both manual edits and subsequent UI saves.
    const edited = {
      ...saved, SERVER_HOST: '::1', SERVER_PORT: '23456',
      SERVER_TLS_CERT: '/edited/cert.pem', SERVER_TLS_KEY: '/edited/key.pem',
      PLAYWRIGHT_BROWSERS_PATH: '/edited/browsers', NODE_ENV: 'test',
      TV_IP: '192.0.2.3', AUTH_PASS: 'edited-testing-password',
    };
    await writeFile(path, serialize(edited));
    loadEnv();
    assertDeployment(edited);
    assert.equal(process.env.TV_IP, '192.0.2.3');
    await new SettingsStore(path).save({ AUTH_USER: 'edited-admin' });
    assertDeployment(edited);
    assert.equal(process.env.AUTH_USER, 'edited-admin');
    assert.equal(process.env.AUTH_PASS, 'edited-testing-password');
  });
}
