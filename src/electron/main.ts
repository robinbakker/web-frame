/**
 * Web Frame — Electron Main Process
 *
 * Runs Web Frame as an always-running Windows system tray application.
 * Manages the background scheduler, local admin server, embedded dashboard window,
 * and system tray notifications.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, dialog } from 'electron';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { randomBytes, X509Certificate } from 'node:crypto';
import electronUpdater from 'electron-updater';
import { setCustomScreenshotProvider } from '../image-source.js';
import { captureOffscreen } from './offscreen-capture.js';
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
} from '../app.js';
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

ensureUserEnvFile();
loadEnv();

// Confirm fallback credentials in process.env
if (!process.env.AUTH_USER) process.env.AUTH_USER = 'webframe';
if (!process.env.AUTH_PASS || process.env.AUTH_PASS.length < 16) {
  process.env.AUTH_PASS = randomBytes(16).toString('hex');
}

// Register native Electron offscreen screenshot engine
setCustomScreenshotProvider(captureOffscreen);

// ---------------------------------------------------------------------------
// 2. Application State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let hasShownTrayNotice = false;
let mainWindowBlurredAt = 0;
let trayMenuKey = '';
let downloadedUpdateVersion: string | null = null;
let serverInstance: ReturnType<typeof startServer> | null = null;

// Windows matches the Run key entry on its arguments too, so query with the ones it was registered with
const LOGIN_ITEM_ARGS = ['--hidden'];

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
  const openInBrowser = (url: string): void => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch((err) => log(`Failed to open ${url}: ${err}`));
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
    mainWindowBlurredAt = Date.now();
  });

  // Intercept close event: hide to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();

      if (!hasShownTrayNotice && Notification.isSupported()) {
        hasShownTrayNotice = true;
        new Notification({
          title: 'Web Frame',
          body: 'Web Frame is running in the background in your system tray.',
          icon: nativeImage.createFromPath(getIconPath()),
        }).show();
      }
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
// 4. System Tray
// ---------------------------------------------------------------------------

function updateTrayMenu(status = getSchedulerStatus()): void {
  if (!tray) return;

  const tvIp = process.env.TV_IP ?? '192.168.1.100';
  const paused = isSchedulerPaused();

  let statusText = status ?? (paused ? 'Paused' : 'Running');
  if (statusText.length > 40) statusText = statusText.slice(0, 37) + '...';

  const tooltip = `Web Frame — ${status ?? 'Running'}`.slice(0, 127);
  tray.setToolTip(tooltip);

  // The scheduler reports every minute; rebuild the menu (and re-read the login item) only when a label changes
  const menuKey = JSON.stringify([tvIp, statusText, paused, downloadedUpdateVersion]);
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `Web Frame ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: `TV: ${tvIp} (${statusText})`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Dashboard',
      click: () => showMainWindow(),
    },
    {
      label: 'Run Now',
      click: async () => {
        try {
          if (tray) tray.setToolTip('Web Frame — Generating & uploading artwork...');
          const result = await runOnce();
          if (Notification.isSupported()) {
            new Notification({
              title: 'Web Frame',
              body: result.skipped ? 'Artwork unchanged; skipped TV upload.' : 'Artwork uploaded & set on TV!',
              icon: nativeImage.createFromPath(getIconPath()),
            }).show();
          }
        } catch (err) {
          if (Notification.isSupported()) {
            new Notification({
              title: 'Web Frame — Run Failed',
              body: err instanceof Error ? err.message : String(err),
              icon: nativeImage.createFromPath(getIconPath()),
            }).show();
          }
        }
      },
    },
    {
      label: paused ? 'Resume Scheduler' : 'Pause Scheduler',
      click: () => {
        if (paused) resumeScheduler();
        else pauseScheduler();
        updateTrayMenu();
      },
    },
    ...(downloadedUpdateVersion
      ? [
          {
            label: `Restart to Update (${downloadedUpdateVersion})`,
            click: () => {
              isQuitting = true;
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
    const wasFocused = mainWindow?.isFocused() || Date.now() - mainWindowBlurredAt < 500;
    if (mainWindow && mainWindow.isVisible() && wasFocused) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });

  tray.on('double-click', () => {
    showMainWindow();
  });

  updateTrayMenu();

  onSchedulerStatusChange((status) => {
    updateTrayMenu(status);
  });
}

// ---------------------------------------------------------------------------
// 5. Auto-Update (GitHub Releases, NSIS installer only)
// ---------------------------------------------------------------------------

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function startAutoUpdates(): void {
  // Unpackaged runs (electron:dev) have no app-update.yml describing the release feed.
  if (!app.isPackaged) return;

  const updaterLog = (message: unknown) => log(`[updater] ${String(message)}`);
  autoUpdater.logger = { info: updaterLog, warn: updaterLog, error: updaterLog };
  // Downloads in the background; installs when the app quits unless restarted from the tray first.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info.version;
    updateTrayMenu();
    if (Notification.isSupported()) {
      new Notification({
        title: 'Web Frame update ready',
        body: `Version ${info.version} installs when you quit Web Frame, or choose "Restart to Update" in the tray menu.`,
        icon: nativeImage.createFromPath(getIconPath()),
      }).show();
    }
  });
  autoUpdater.on('error', (err) => log(`Auto-update failed: ${err.message}`));

  // Failures are reported through the 'error' event above.
  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// 6. Lifecycle Hooks
// ---------------------------------------------------------------------------

app.on('second-instance', () => {
  showMainWindow();
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

  const port = getServerPort();

  log(`Starting Admin Server on port ${port}...`);

  // 1. Start the admin HTTP server and wait for listening event
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
    app.quit();
    return;
  }

  // Once running, keep the tray app and scheduler alive like cli.ts does: TV connection errors can surface
  // as unhandled rejections, and Electron would show a modal error box for each one
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (err) => {
    log(`Unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });

  // 2. Setup System Tray
  createTray();
  startAutoUpdates();

  // 3. Start the background scheduler
  runScheduler().catch((err) => {
    log(`Scheduler error: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Scheduler stopped unexpectedly:', err);
  });

  // 4. Open dashboard unless started with --hidden or minimized
  const startHidden =
    process.argv.includes('--hidden') ||
    process.argv.includes('--minimized') ||
    app.commandLine.hasSwitch('hidden');

  if (!startHidden) {
    showMainWindow();
  }
});
