// Checks that Chromium runs sandboxed inside the web-frame container, with the same launch options as
// src/screenshot.ts. Run it on the Docker host, in the folder with the compose file (prefix with sudo
// on Synology):
//
//   docker compose exec -T -u node web-frame node --input-type=module < check-sandbox.mjs
//
// Exit code 0: renderers run in their own namespaces under a seccomp-bpf filter, so CHROMIUM_SANDBOX
// can stay unset. Exit code 1: the sandbox is missing or Chromium would not start with it.
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

function status(pid) {
  const fields = {};
  for (const line of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  return fields;
}

// "Seccomp" is missing when the kernel was built without seccomp (Synology DSM reports this).
const seccomp = (s) => ({ 0: 'off', 1: 'strict', 2: 'filter' })[s.Seccomp] ?? 'not in kernel';
const pidDepth = (s) => (s.NSpid ?? '').split(/\s+/).filter(Boolean).length;
const filters = (s) => Number(s.Seccomp_filters ?? 0);

const self = status('self');
console.log(
  `container: uid ${self.Uid.split(/\s+/)[0]}, capabilities ${/^0+$/.test(self.CapEff) ? 'none' : self.CapEff},` +
    ` no_new_privs ${self.NoNewPrivs}, seccomp ${seccomp(self)}`,
);
try {
  console.log(`user namespaces allowed: ${readFileSync('/proc/sys/user/max_user_namespaces', 'utf8').trim()}`);
} catch {
  console.log('user namespaces allowed: unknown (/proc/sys/user/max_user_namespaces missing)');
}

let browser;
try {
  browser = await chromium.launch({ channel: 'chromium-headless-shell', chromiumSandbox: true });
} catch (error) {
  console.log(`\nFAIL: Chromium does not start with its sandbox.\n${String(error.message).split('\n').slice(0, 6).join('\n')}`);
  process.exit(1);
}

let ok = false;
try {
  const page = await browser.newPage();
  await page.setContent('<p>sandbox check</p>');
  const renderers = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      // Chromium rewrites its process title, so the arguments may be one space-separated string.
      if (/(?:^|[\0 ])--type=renderer(?:[\0 ]|$)/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) {
        renderers.push({ pid, status: status(pid) });
      }
    } catch {
      // The process exited while scanning.
    }
  }
  if (renderers.length === 0) console.log('\nFAIL: no renderer process found.');
  ok = renderers.length > 0;
  for (const { pid, status: renderer } of renderers) {
    const namespaced = pidDepth(renderer) > pidDepth(self);
    // Under Docker's own seccomp profile every process shows "filter", so look for an extra filter.
    // Kernels before 5.9 don't report the count; that case is shown as unknown, not as a failure.
    const filtered =
      seccomp(renderer) !== 'filter' ? 'NO'
      : seccomp(self) !== 'filter' ? 'yes'
      : renderer.Seccomp_filters === undefined ? 'unknown'
      : filters(renderer) > filters(self) ? 'yes'
      : 'NO';
    console.log(
      `\nrenderer ${pid}: own namespaces ${namespaced ? 'yes' : 'NO'}, seccomp-bpf ${filtered}` +
        ` (seccomp ${seccomp(renderer)}, filters ${renderer.Seccomp_filters ?? 'n/a'})`,
    );
    ok &&= namespaced && filtered !== 'NO';
  }
} finally {
  await browser.close();
}
console.log(ok ? '\nOK: Chromium is sandboxed.' : '\nFAIL: Chromium started, but its renderers are not fully sandboxed.');
process.exit(ok ? 0 : 1);
