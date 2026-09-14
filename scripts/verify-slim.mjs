// Run after building. Install a real production runtime outside the repository's
// ancestor lookup path, then exercise compiled commands with mocked TV/network.
import { cp, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(tmpdir(), 'web-frame-slim-'));
if (root.toLowerCase().startsWith((project + sep).toLowerCase())) throw new Error('Runtime must be outside repository');
const environment = { ...process.env, NODE_PATH: '', WEB_FRAME_ENV_FILE: join(root, '.env'),
  PLAYWRIGHT_BROWSERS_PATH: join(root, 'no-browsers'), SERVER_TLS_CERT: '', SERVER_TLS_KEY: '' };
const run = (command, args) => new Promise((done, reject) => {
  const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? done() : reject(new Error(`Command exited ${code}`)));
});
try {
  for (const name of ['package.json', 'package-lock.json']) await copyFile(join(project, name), join(root, name));
  for (const name of ['dist', 'public']) await cp(join(project, name), join(root, name), { recursive: true });
  for (const name of ['runtime-smoke.mjs', 'runtime-mocks.mjs', 'png-fixtures.mjs']) await copyFile(join(project, 'test', name), join(root, name));
  await writeFile(join(root, '.env'), 'IMAGE_SOURCE=png-image-url\nIMAGE_URL=https://example.test/image\nCONTENT_URL=\nAUTH_USER=admin\nAUTH_PASS=runtime-testing-password\nTV_IP=192.0.2.1\nSERVER_HOST=127.0.0.1\nDOTENV_CONFIG_QUIET=true\n');
  // npm_execpath avoids shell quoting/Windows .cmd invocation.
  if (!process.env.npm_execpath) throw new Error('Use npm run test:slim');
  await run(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts',
    '--cache', join(project, '.npm-cache'), '--fetch-retries=0', '--fetch-timeout=20000']);
  await run(process.execPath, ['--experimental-test-module-mocks', 'runtime-smoke.mjs']);
  for (const command of ['generate', 'screenshot', 'list', 'upload', 'run']) {
    await run(process.execPath, ['--experimental-test-module-mocks', '--import', './runtime-mocks.mjs', 'dist/cli.js', command]);
  }
  console.log('Isolated browser-free production runtime verified.');
} finally {
  // Only remove the unique temporary directory created above.
  await rm(root, { recursive: true, force: true });
}
