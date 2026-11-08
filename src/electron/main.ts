/**
 * Web Frame — Electron Main Process
 *
 * Runs Web Frame as an always-running Windows system tray application, in one of two modes:
 * - Connected: linked to Frame This with a connect code, which decides what each TV shows. No local
 *   server; a small window shows the status.
 * - Standalone: the local admin server and its dashboard window, configured through .env.
 * A new install starts at the "Connect to Frame This" window, which also offers standalone mode.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, dialog, net, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomBytes, X509Certificate } from 'node:crypto';
import electronUpdater from 'electron-updater';
import { setCustomScreenshotProvider } from '../image-source.js';
import { captureOffscreen } from './offscreen-capture.js';
import {
  installerFileName,
  isReleaseVersion,
  loadUpdatePublicKey,
  sha512File,
  sha512FileSync,
  signatureFileName,
  verifyUpdateSignature,
} from './update-signature.js';
import { loadEnv } from '../env.js';
import { parseEnv, updateEnv } from '../env-file.js';
import {
  ensureEnvLoaded,
  runOnce,
  runScheduler,
  pauseScheduler,
  resumeScheduler,
  isSchedulerPaused,
  getSchedulerStatus,
  onSchedulerStatusChange,
  runConnectedCheck,
  getConnectedSnapshot,
} from '../app.js';
import {
  FRAME_THIS_DASHBOARD_URL,
  checkFrameThisToken,
  isFrameThisToken,
  readFrameThisToken,
  removeFrameThisToken,
  saveFrameThisToken,
  useTokenFileOnly,
} from '../frame-this.js';
import { startServer } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..', '..'));
// electron-updater is CommonJS with a lazily defined export, so it has no ESM named export.
const { autoUpdater } = electronUpdater;

// ---------------------------------------------------------------------------
// 1. Storage & Logging Setup (UserData)
// ---------------------------------------------------------------------------

const userDataPath = app.getPath('userData');
const dataDir = join(userDataPath, 'data');
const envPath = join(userDataPath, '.env');
const tokenDir = join(userDataPath, 'tokens');
const logFile = join(userDataPath, 'web-frame.log');

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(logFile, line, 'utf8');
  } catch {
    // ignore logging failures
  }
  console.log(msg);
}

// Exit before touching userData: the running instance may be saving the same .env right now.
if (!app.requestSingleInstanceLock()) {
  log('Another instance is already running. Exiting.');
  app.quit();
  process.exit(0);
}

// Windows shows toasts only for the AppUserModelID on the app's Start menu shortcut (electron-builder's
// appId); without this they go missing when the Run key starts the app. Unpackaged runs have no shortcut.
if (app.isPackaged) app.setAppUserModelId('link.framethis.webframe');

mkdirSync(dataDir, { recursive: true });
mkdirSync(tokenDir, { recursive: true });

log(`Web Frame starting up. UserData: ${userDataPath}`);

process.env.WEB_FRAME_DATA_DIR = dataDir;
process.env.WEB_FRAME_ENV_FILE = envPath;
process.env.WEB_FRAME_TOKEN_DIR = tokenDir;
// Sent to Frame This in the User-Agent
process.env.WEB_FRAME_PLATFORM =
  process.platform === 'win32' ? 'electron-win' : process.platform === 'darwin' ? 'electron-mac' : 'electron-linux';

// Standalone mode creates the .env, so a new install has none: it starts at "Connect to Frame This".
const isFirstRun = !existsSync(envPath);

function ensureUserEnvFile(): void {
  if (!existsSync(envPath)) {
    const rootEnv = join(ROOT, '.env');
    if (existsSync(rootEnv)) {
      try {
        const content = readFileSync(rootEnv, 'utf8');
        writeFileSync(envPath, content, 'utf8');
        log('Migrated root .env to userData');
      } catch (e) {
        log(`Failed to copy root .env: ${e}`);
      }
    }
  }

  const defaultPassword = randomBytes(16).toString('hex'); // 32 characters
  if (!existsSync(envPath)) {
    const defaultContent = [
      '# Web Frame Desktop Configuration',
      'TV_IP=192.168.1.100',
      'IMAGE_SOURCE=website-screenshot',
      'CONTENT_URL=https://framethis.link/@demo/canvas',
      'SCHEDULE_INTERVAL=10m',
      'SERVER_HOST=127.0.0.1',
      'SERVER_PORT=33636',
      'AUTH_USER=webframe',
      `AUTH_PASS=${defaultPassword}`,
      '',
    ].join('\n');
    writeFileSync(envPath, defaultContent, 'utf8');
    log('Created default .env in userData');
  }

  // Ensure AUTH_USER and a valid AUTH_PASS exist in .env; loadEnv() below reads them into process.env
  let envText = '';
  try {
    envText = readFileSync(envPath, 'utf8');
  } catch {
    envText = '';
  }

  try {
    const values = parseEnv(envText);
    const updates: Record<string, string> = {};
    if (!values.AUTH_USER?.trim()) updates.AUTH_USER = 'webframe';
    if (!values.AUTH_PASS || values.AUTH_PASS.trim().length < 16) {
      updates.AUTH_PASS = randomBytes(16).toString('hex');
    }
    if (Object.keys(updates).length > 0) {
      writeFileSync(envPath, updateEnv(envText, updates), 'utf8');
      log('Updated .env credentials');
    }
  } catch (e) {
    log(`Failed to update .env credentials: ${e}`);
  }
}

loadEnv();

// The connect code goes in through the Frame This window, and unlinking removes it from the token file.
// A FRAME_THIS_TOKEN in .env would keep the app linked whatever the user does there.
useTokenFileOnly();
if (process.env.FRAME_THIS_TOKEN) {
  log('FRAME_THIS_TOKEN in .env is ignored: the desktop app links through its Frame This window');
}

// Register native Electron offscreen screenshot engine
setCustomScreenshotProvider(captureOffscreen);

// ---------------------------------------------------------------------------
// 2. Application State
// ---------------------------------------------------------------------------

// setup: no mode chosen yet (the Frame This window is open); nothing runs until the user picks one.
type Mode = 'setup' | 'connected' | 'standalone';
let mode: Mode = 'setup';
// Standalone mode while it starts: `mode` changes only once its server listens.
let standaloneStart: Promise<boolean> | null = null;

let mainWindow: BrowserWindow | null = null;
let bridgeWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let hasShownTrayNotice = false;
let windowBlurredAt = 0;
let trayMenuKey = '';
// Set only once the downloaded installer's signature has been verified. sha512 is the hash that was
// verified, so the installer can be checked again right before it runs.
let verifiedUpdate: { version: string; file: string; sha512: string } | null = null;
let installingUpdate = false;
let relaunching = false;
let serverInstance: ReturnType<typeof startServer> | null = null;

// Windows matches the Run key entry on its arguments too, so query with the ones it was registered with
const LOGIN_ITEM_ARGS = ['--hidden'];
// Relaunch argument: open the "Connect to Frame This" window (after unlinking)
const CONNECT_ARG = '--connect';
const BRIDGE_PAGE = join(ROOT, 'public', 'bridge.html');

function getServerPort(): number {
  return parseInt(process.env.SERVER_PORT || '33636', 10);
}

// The dashboard address, matching how startServer() binds and whether it serves HTTPS
function getAppUrl(): string {
  const host = process.env.SERVER_HOST || '127.0.0.1';
  // Wildcard bind addresses can't be connected to; the server answers on loopback as well
  const address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const protocol = process.env.SERVER_TLS_CERT && process.env.SERVER_TLS_KEY ? 'https' : 'http';
  return `${protocol}://${address.includes(':') ? `[${address}]` : address}:${getServerPort()}`;
}

// True when the page presents exactly the certificate the admin server is configured with
function isServerCertificate(pem: string): boolean {
  try {
    const configured = new X509Certificate(readFileSync(process.env.SERVER_TLS_CERT ?? ''));
    return new X509Certificate(pem).fingerprint256 === configured.fingerprint256;
  } catch {
    return false;
  }
}

function getIconPath(): string {
  const candidates = [
    join(ROOT, 'public', 'icon-512.png'),
    join(ROOT, 'public', 'favicon.ico'),
    join(ROOT, 'public', 'logo.png'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(ROOT, 'public', 'logo.png');
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: nativeImage.createFromPath(getIconPath()) }).show();
}

function openInBrowser(url: string): void {
  if (/^https?:/i.test(url)) shell.openExternal(url).catch((err) => log(`Failed to open ${url}: ${err}`));
}

function showTrayNoticeOnce(): void {
  if (hasShownTrayNotice) return;
  hasShownTrayNotice = true;
  notify('Web Frame', 'Web Frame is running in the background in your system tray.');
}

/** Restarts the app, for switching modes: the scheduler and the admin server can't be stopped in place. */
function relaunch(extraArgs: string[] = []): void {
  const args = process.argv.slice(1).filter((arg) => arg !== CONNECT_ARG && arg !== '--hidden');
  app.relaunch({ args: [...args, ...extraArgs] });
  relaunching = true;
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// 3. Main Window Management
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  const icon = nativeImage.createFromPath(getIconPath());

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: 'Web Frame',
    icon,
    show: false,
    backgroundColor: '#1a1a1a', // match dark theme to avoid white screen flash
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const appUrl = getAppUrl();

  log(`Loading Admin UI from ${appUrl}`);

  const isAppUrl = (url: string): boolean => {
    try {
      return new URL(url).origin === new URL(appUrl).origin;
    } catch {
      return false;
    }
  };

  // Auto-authenticate the local admin server only; other sites and proxies get the default (cancel)
  mainWindow.webContents.on('login', (event, details, authInfo, callback) => {
    if (authInfo.isProxy || !isAppUrl(details.url)) return;
    event.preventDefault();
    callback(process.env.AUTH_USER ?? 'webframe', process.env.AUTH_PASS ?? '');
  });

  // A certificate meant for LAN access won't name this loopback address; trust exactly the configured one
  mainWindow.webContents.on('certificate-error', (event, url, _error, certificate, callback) => {
    if (isAppUrl(url) && isServerCertificate(certificate.data)) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // Keep the window on the dashboard; links elsewhere (such as CONTENT_URL) open in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
    openInBrowser(event.url);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Admin UI loaded successfully in BrowserWindow.');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log(`Failed to load ${validatedURL}: [${errorCode}] ${errorDescription}`);
    // If connection was refused (server still binding), retry after 1s
    if (errorCode === -102 || errorCode === -105) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          log('Retrying connection to Admin UI...');
          mainWindow.loadURL(appUrl).catch(() => undefined);
        }
      }, 1000);
    }
  });

  mainWindow.loadURL(appUrl).catch((err) => {
    log(`loadURL error: ${err}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('blur', () => {
    windowBlurredAt = Date.now();
  });

  // Intercept close event: hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      showTrayNoticeOnce();
    }
  });

  return mainWindow;
}

function showMainWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------
// 4. Frame This Window (connect code, then status)
// ---------------------------------------------------------------------------

function bridgeState() {
  const snapshot = mode === 'connected' ? getConnectedSnapshot() : null;
  return {
    mode,
    view: mode === 'connected' && !snapshot?.linkProblem ? 'status' : 'connect',
    version: app.getVersion(),
    linkProblem: snapshot?.linkProblem ?? null,
    status: getSchedulerStatus() ?? '',
    paused: isSchedulerPaused(),
    warning: snapshot?.pollError ?? null,
    notice: snapshot?.notice ?? null,
    tvs: snapshot?.tvs ?? [],
  };
}

function sendBridgeState(): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) bridgeWindow.webContents.send('bridge:state', bridgeState());
}

function showBridgeWindow(): void {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    if (bridgeWindow.isMinimized()) bridgeWindow.restore();
    bridgeWindow.show();
    bridgeWindow.focus();
    return;
  }

  bridgeWindow = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 480,
    title: 'Web Frame',
    icon: nativeImage.createFromPath(getIconPath()),
    show: false,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'bridge-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // A local page with no links of its own: it never navigates or opens windows.
  bridgeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bridgeWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  bridgeWindow.loadFile(BRIDGE_PAGE).catch((err) => log(`Failed to load the Frame This window: ${err}`));
  bridgeWindow.once('ready-to-show', () => bridgeWindow?.show());
  bridgeWindow.on('blur', () => {
    windowBlurredAt = Date.now();
  });
  bridgeWindow.on('closed', () => {
    bridgeWindow = null;
    // In standalone mode the dashboard takes over, and gives this notice when it's closed.
    if (!isQuitting && mode !== 'standalone') showTrayNoticeOnce();
  });
}

// The window for this mode: the dashboard in standalone mode, the Frame This window otherwise
function primaryWindow(): BrowserWindow | null {
  const win = mode === 'standalone' ? mainWindow : bridgeWindow;
  return win && !win.isDestroyed() ? win : null;
}

function showPrimaryWindow(): void {
  if (mode === 'standalone') showMainWindow();
  else showBridgeWindow();
}

async function connectToFrameThis(code: unknown): Promise<{ error?: string }> {
  const token = typeof code === 'string' ? code.trim() : '';
  if (!isFrameThisToken(token)) {
    return { error: "That isn't a connect code. It starts with ftd_; copy it again from Frame This." };
  }
  const check = await checkFrameThisToken(token);
  if (check === 'unauthorized') {
    return {
      error:
        "Frame This doesn't accept this code. Copy it again, or in Frame This open TVs → Bridge settings → New connect code.",
    };
  }
  if (check === 'unreachable') {
    return { error: "Can't reach Frame This right now. Check the internet connection and try again." };
  }
  await saveFrameThisToken(token);
  log('Linked to Frame This');
  // Standalone mode may still be starting: switch from it once it runs, rather than run both.
  if (standaloneStart) await standaloneStart;
  if (mode === 'standalone') {
    relaunch();
  } else if (mode === 'setup') {
    startConnected();
  } else {
    // Linked again after Frame This turned the old code away, maybe with the same code: start over now.
    runConnectedCheck({ relinked: true })
      .catch((err) => log(`Check failed: ${err}`))
      .finally(sendBridgeState);
  }
  sendBridgeState();
  return {};
}

async function unlinkFromFrameThis(): Promise<void> {
  const options = {
    type: 'question' as const,
    buttons: ['Unlink', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Unlink this computer from Frame This?',
    detail:
      'Web Frame stops updating your TVs. To link it again, open TVs in Frame This, choose Bridge settings for this bridge, then New connect code. Its TVs and channels stay. Or remove the bridge there.',
  };
  const { response } = bridgeWindow
    ? await dialog.showMessageBox(bridgeWindow, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return;
  await removeFrameThisToken();
  log('Unlinked from Frame This');
  relaunch([CONNECT_ARG]);
}

async function runNow(): Promise<void> {
  try {
    if (tray) tray.setToolTip('Web Frame — Generating & uploading artwork...');
    if (mode === 'connected') {
      await runConnectedCheck({ force: true });
      notify('Web Frame', getSchedulerStatus() ?? 'Done');
    } else {
      const result = await runOnce();
      notify('Web Frame', result.skipped ? 'Artwork unchanged; skipped TV upload.' : 'Artwork uploaded & set on TV!');
    }
  } catch (err) {
    notify('Web Frame — Run Failed', err instanceof Error ? err.message : String(err));
  } finally {
    updateTrayMenu();
  }
}

/** IPC for the Frame This window only: other pages (the dashboard) can't call these. */
function registerBridgeHandlers(): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = bridgeWindow && !bridgeWindow.isDestroyed() ? bridgeWindow : null;
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        throw new Error('Not allowed');
      }
      return handler(...args);
    });
  };
  handle('bridge:get-state', () => bridgeState());
  handle('bridge:connect', (code) => connectToFrameThis(code));
  handle('bridge:standalone', async () => {
    if (mode !== 'setup') return;
    if (await startStandaloneOnce()) {
      bridgeWindow?.close();
      showMainWindow();
    }
  });
  handle('bridge:open-frame-this', () => openInBrowser(FRAME_THIS_DASHBOARD_URL));
  handle('bridge:run-now', () => runNow());
  handle('bridge:unlink', () => unlinkFromFrameThis());
}

// ---------------------------------------------------------------------------
// 5. System Tray
// ---------------------------------------------------------------------------

function trayStatusLabel(statusText: string): string {
  if (mode === 'setup') return 'Not connected yet';
  if (mode === 'standalone') return `TV: ${process.env.TV_IP ?? '192.168.1.100'} (${statusText})`;
  const { linkProblem, tvs } = getConnectedSnapshot();
  if (linkProblem) return 'Unlinked from Frame This';
  if (tvs.length === 1) return `TV: ${tvs[0].tvIp} (${statusText})`;
  if (tvs.length > 1) return `${tvs.length} TVs (${statusText})`;
  return statusText;
}

function updateTrayMenu(status = getSchedulerStatus()): void {
  if (!tray) return;

  const paused = isSchedulerPaused();
  const notice = mode === 'connected' ? getConnectedSnapshot().notice : null;

  let statusText = status ?? (paused ? 'Paused' : 'Running');
  if (statusText.length > 40) statusText = statusText.slice(0, 37) + '...';
  const statusLabel = trayStatusLabel(statusText);

  const tooltip = `Web Frame — ${mode === 'setup' ? 'Not connected yet' : (status ?? 'Running')}`.slice(0, 127);
  tray.setToolTip(tooltip);

  // The scheduler reports every minute; rebuild the menu (and re-read the login item) only when a label changes
  const menuKey = JSON.stringify([mode, statusLabel, paused, notice, verifiedUpdate?.version]);
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;

  const modeItems: MenuItemConstructorOptions[] =
    mode === 'connected'
      ? [
          { label: 'Open Frame This', click: () => openInBrowser(FRAME_THIS_DASHBOARD_URL) },
          { label: 'Show Status', click: () => showBridgeWindow() },
        ]
      : mode === 'standalone'
        ? [{ label: 'Open Dashboard', click: () => showMainWindow() }]
        : [{ label: 'Connect to Frame This…', click: () => showBridgeWindow() }];

  const schedulerItems: MenuItemConstructorOptions[] =
    mode === 'setup'
      ? []
      : [
          { label: 'Run Now', click: () => void runNow() },
          {
            label: paused ? 'Resume Scheduler' : 'Pause Scheduler',
            click: () => {
              if (paused) resumeScheduler();
              else pauseScheduler();
              updateTrayMenu();
            },
          },
        ];

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Web Frame ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: statusLabel,
      enabled: false,
    },
    ...(notice ? [{ label: notice, enabled: false }] : []),
    { type: 'separator' },
    ...modeItems,
    ...schedulerItems,
    ...(mode === 'standalone'
      ? [{ label: 'Connect to Frame This…', click: () => showBridgeWindow() }]
      : []),
    ...(verifiedUpdate
      ? [
          {
            label: `Restart to Update (${verifiedUpdate.version})`,
            click: () => {
              if (!verifiedInstallerUnchanged()) {
                updateTrayMenu();
                return;
              }
              isQuitting = true;
              installingUpdate = true;
              // Silent install, then relaunch the new version.
              autoUpdater.quitAndInstall(true, true);
            },
          },
        ]
      : []),
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          args: LOGIN_ITEM_ARGS,
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Web Frame',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon);

  tray.on('click', () => {
    // Pressing the tray icon moves focus to the taskbar before 'click' fires, so a window that lost
    // focus a moment ago was the focused one
    const win = primaryWindow();
    const wasFocused = win?.isFocused() || Date.now() - windowBlurredAt < 500;
    if (win && win.isVisible() && wasFocused) {
      win.hide();
    } else {
      showPrimaryWindow();
    }
  });

  tray.on('double-click', () => {
    showPrimaryWindow();
  });

  updateTrayMenu();

  onSchedulerStatusChange((status) => {
    updateTrayMenu(status);
    sendBridgeState();
  });
}

// ---------------------------------------------------------------------------
// 6. Auto-Update (GitHub Releases, NSIS installer only)
// ---------------------------------------------------------------------------

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Fixed here, never taken from the release feed. The signature is what makes a download trusted.
const UPDATE_SIGNATURE_BASE_URL = 'https://github.com/robinbakker/web-frame/releases/download';

/**
 * Checks the downloaded installer against the maintainer's offline signature (see update-signature.ts).
 * electron-updater alone would install whatever the GitHub release contains, because the installer
 * isn't Authenticode-signed and its publisher check only runs for signed builds.
 */
async function verifiedInstallerHash(version: string, file: string): Promise<string | null> {
  try {
    if (!isReleaseVersion(version)) throw new Error('unexpected version format');
    const publicKey = loadUpdatePublicKey();
    const response = await net.fetch(`${UPDATE_SIGNATURE_BASE_URL}/v${version}/${signatureFileName(version)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`signature download failed (HTTP ${response.status})`);
    if (Number(response.headers.get('content-length') ?? 0) > 1024) throw new Error('signature file too large');
    const signature = await response.text();
    const sha512 = await sha512File(file);
    if (!verifyUpdateSignature(installerFileName(version), sha512, signature, publicKey)) {
      throw new Error('signature does not match the installer');
    }
    return sha512;
  } catch (err) {
    log(`Update ${version} will not be installed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The installer waits in a folder the user can write to, and may run elevated, so it is hashed again
 * right before it runs. Forgets the update when the file changed after it was verified.
 */
function verifiedInstallerUnchanged(): boolean {
  if (!verifiedUpdate) return false;
  const { version, file, sha512 } = verifiedUpdate;
  try {
    if (sha512FileSync(file) === sha512) return true;
    log(`Update ${version} will not be installed: the installer changed after it was verified`);
  } catch (err) {
    log(`Update ${version} will not be installed: ${err instanceof Error ? err.message : String(err)}`);
  }
  verifiedUpdate = null;
  return false;
}

function startAutoUpdates(): void {
  // Unpackaged runs (electron:dev) have no app-update.yml describing the release feed.
  if (!app.isPackaged) return;

  const updaterLog = (message: unknown) => log(`[updater] ${String(message)}`);
  autoUpdater.logger = { info: updaterLog, warn: updaterLog, error: updaterLog };
  // Downloads in the background. electron-updater's own install-on-quit stays off: an update only
  // installs once verifiedInstallerHash() accepts it, through the quit handler below or the tray menu.
  autoUpdater.autoInstallOnAppQuit = false;

  // Bumped whenever a new download starts, so a slow check of an older file can't approve a newer one.
  let downloadGeneration = 0;
  autoUpdater.on('update-available', () => {
    downloadGeneration++;
    if (verifiedUpdate) {
      verifiedUpdate = null;
      updateTrayMenu();
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    const generation = downloadGeneration;
    void verifiedInstallerHash(info.version, info.downloadedFile).then((sha512) => {
      if (!sha512 || generation !== downloadGeneration) return;
      verifiedUpdate = { version: info.version, file: info.downloadedFile, sha512 };
      updateTrayMenu();
      notify(
        'Web Frame update ready',
        `Version ${info.version} installs when you quit Web Frame, or choose "Restart to Update" in the tray menu.`,
      );
    });
  });
  autoUpdater.on('error', (err) => log(`Auto-update failed: ${err.message}`));

  // Same as electron-updater's install-on-quit, but only for a verified update. A relaunch to switch
  // modes leaves it for the next quit.
  app.once('quit', (_event, exitCode) => {
    if (!verifiedUpdate || installingUpdate || relaunching || exitCode !== 0) return;
    if (autoUpdater instanceof electronUpdater.BaseUpdater && verifiedInstallerUnchanged()) {
      autoUpdater.install(true, false);
    }
  });

  // Failures are reported through the 'error' event above.
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// 7. Modes
// ---------------------------------------------------------------------------

function startScheduler(): void {
  runScheduler().catch((err) => {
    log(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Scheduler stopped unexpectedly:', err);
  });
}

/** Frame This decides what each TV shows. No local server, so no admin password either. */
function startConnected(): void {
  mode = 'connected';
  log('Connected mode: Frame This decides what each TV shows');
  startScheduler();
  updateTrayMenu();
}

/** Starts standalone mode once: a second click waits for that start instead of starting a second server on the same port. */
function startStandaloneOnce(): Promise<boolean> {
  standaloneStart ??= startStandalone();
  return standaloneStart;
}

/** The local admin server and dashboard, configured through .env. False when the server can't start. */
async function startStandalone(): Promise<boolean> {
  ensureUserEnvFile();
  loadEnv();
  // Confirm fallback credentials in process.env
  if (!process.env.AUTH_USER) process.env.AUTH_USER = 'webframe';
  if (!process.env.AUTH_PASS || process.env.AUTH_PASS.length < 16) {
    process.env.AUTH_PASS = randomBytes(16).toString('hex');
  }

  const port = getServerPort();
  log(`Starting Admin Server on port ${port}...`);

  try {
    await new Promise<void>((resolve, reject) => {
      try {
        serverInstance = startServer(port);
        serverInstance.once('listening', () => {
          log(`Admin server listening on ${getAppUrl()}`);
          resolve();
        });
        serverInstance.on('error', (err) => {
          log(`Admin server error: ${err.message}`);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  } catch (err) {
    log(`Failed to start admin server: ${err}`);
    dialog.showErrorBox(
      'Web Frame Error',
      `Could not start local server on port ${port}: ${err instanceof Error ? err.message : String(err)}\n\nPlease ensure another service is not using this port.`,
    );
    isQuitting = true;
    app.quit();
    return false;
  }

  mode = 'standalone';
  startScheduler();
  updateTrayMenu();
  return true;
}

// ---------------------------------------------------------------------------
// 8. Lifecycle Hooks
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  showPrimaryWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverInstance) {
    try {
      serverInstance.close();
    } catch {
      // ignore server close error
    }
  }
});

app.on('window-all-closed', () => {
  // Stay running in the system tray when all windows are closed
});

app.whenReady().then(async () => {
  ensureEnvLoaded();

  // Keep the tray app and scheduler alive like cli.ts does: TV connection errors can surface as
  // unhandled rejections, and Electron would show a modal error box for each one
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (err) => {
    log(`Unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });

  registerBridgeHandlers();
  createTray();
  startAutoUpdates();

  const startHidden =
    process.argv.includes('--hidden') ||
    process.argv.includes('--minimized') ||
    app.commandLine.hasSwitch('hidden');

  if (readFrameThisToken()) {
    startConnected();
    if (!startHidden) showBridgeWindow();
  } else if (isFirstRun || process.argv.includes(CONNECT_ARG)) {
    // Nothing runs until the user links the app or chooses standalone mode.
    updateTrayMenu();
    showBridgeWindow();
  } else {
    if (!(await startStandaloneOnce())) return;
    if (!startHidden) showMainWindow();
  }
});
