import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import type { Session, WebContents } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc/handlers';
import { CollectionStore } from './stores/collectionStore';
import { HistoryStore } from './stores/historyStore';
import { RequestEngine } from './engine/requestEngine';
import { OAuthService } from './oauth/oauthService';
import { getApiSession } from './engine/apiSession';
import electronUpdater from 'electron-updater';
import { createWindowsAutoUpdaterService } from './update/autoUpdater';
import { ElectronSafeStorageAdapter } from './crypto/safeStorageAdapter';
import { createAppPageCheck } from './ipc/trustedSender';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

/** The one page a window shows, and the only page the main process answers. */
const indexPath = path.join(__dirname, '../../dist/index.html');
const isAppPage = createAppPageCheck({ indexPath, devServerUrl: process.env.VITE_DEV_SERVER_URL });

let mainWindow: BrowserWindow | null = null;
let collectionStore: CollectionStore;
let historyStore: HistoryStore;
let requestEngine: RequestEngine;
let oauthService: OAuthService;
let autoUpdaterService: ReturnType<typeof createWindowsAutoUpdaterService> | null = null;
let cleanupIpcHandlers: (() => void) | null = null;

function sendErrorToRenderer(label: string, data: unknown) {
  if (isDev && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('console:log', JSON.stringify({ label, data, timestamp: new Date().toISOString() }));
  }
}

/**
 * A window only ever shows the app's own page. Response content is never rendered as markup, so nothing
 * should ask to leave it; these stops limit what a script-injection bug could reach if one appeared.
 */
function confineWebContents() {
  app.on('web-contents-created', (_event, contents) => {
    // A reload of the current page is allowed (the dev server uses it); any other destination is not.
    contents.on('will-navigate', (details) => {
      if (details.url !== contents.getURL()) details.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/** The page copies text with `navigator.clipboard`. It uses no other browser permission. */
const PAGE_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

function pagePermissionAllowed(contents: WebContents | null, permission: string): boolean {
  return PAGE_PERMISSIONS.has(permission) && contents !== null && contents === mainWindow?.webContents;
}

/**
 * Electron grants every browser permission unless told otherwise. This app needs no camera, microphone,
 * location, notifications or devices, so each session refuses them all.
 */
function refuseBrowserPermissions(target: Session) {
  target.setPermissionCheckHandler((contents, permission) => pagePermissionAllowed(contents, permission));
  target.setPermissionRequestHandler((contents, permission, callback) => callback(pagePermissionAllowed(contents, permission)));
  target.setDevicePermissionHandler(() => false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Restiprocity',
    frame: true,
    backgroundColor: '#181825',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The page decodes images a server sent; keep that inside Chromium's OS sandbox.
      sandbox: true,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    /* In production the app runs from an ASAR archive.  loadFile() can't
       read from inside ASAR — it needs a real filesystem path.  Use
       loadURL() with the asar:// protocol instead. */
    mainWindow.loadURL(`file://${indexPath}`);
  }

  mainWindow.show();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function init() {
  await app.whenReady();

  // Covers the window's session and the request, OAuth and any later sessions as they are created.
  app.on('session-created', refuseBrowserPermissions);
  refuseBrowserPermissions(session.defaultSession);

  const userDataPath = app.getPath('userData');

  const safeStorageAdapter = new ElectronSafeStorageAdapter(safeStorage);
  collectionStore = new CollectionStore(userDataPath, undefined, undefined, safeStorageAdapter);
  await collectionStore.init();

  historyStore = new HistoryStore(userDataPath);
  await historyStore.init();

  const apiSession = getApiSession();
  const insecureApiSession = getApiSession(true);
  oauthService = new OAuthService();
  requestEngine = new RequestEngine(apiSession, collectionStore, {
    getInsecureSession: () => insecureApiSession,
  }, {}, oauthService);

  autoUpdaterService = createWindowsAutoUpdaterService({
    app,
    platform: process.platform,
    updater: electronUpdater.autoUpdater,
  });

  cleanupIpcHandlers = setupIpcHandlers({
    collectionStore,
    historyStore,
    requestEngine,
    autoUpdaterService,
    oauthService,
    isAppPage,
  });

  await autoUpdaterService.start();

  if (isDev) {
    process.on('uncaughtException', (error) => {
      console.error('[Dev Error]', {
        type: 'uncaught-exception',
        message: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      });
      sendErrorToRenderer('uncaught-exception', { message: error.message, stack: error.stack });
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[Dev Error]', {
        type: 'unhandled-rejection',
        reason: String(reason),
        timestamp: new Date().toISOString(),
      });
      sendErrorToRenderer('unhandled-rejection', { reason: String(reason) });
    });
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    cleanupIpcHandlers?.();
    cleanupIpcHandlers = null;
    autoUpdaterService?.dispose();
    oauthService?.dispose();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  confineWebContents();
  createWindow();
}

// Test isolation: when RESTIPROCITY_TEST_USER_DATA is set (must be an absolute
// path), redirect all app data there. Production behavior is unchanged when unset.
const testUserData = process.env.RESTIPROCITY_TEST_USER_DATA;
if (testUserData) {
  if (!path.isAbsolute(testUserData)) {
    throw new Error('RESTIPROCITY_TEST_USER_DATA must be an absolute path');
  }
  app.setPath('userData', testUserData);
  // Playwright's Electron loader forces --password-store=basic, which hides a real Linux keyring.
  // A test run can name the keyring to use instead; this is ignored outside isolated test runs.
  const testPasswordStore = process.env.RESTIPROCITY_TEST_PASSWORD_STORE;
  if (process.platform === 'linux' && testPasswordStore) {
    if (!['gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(testPasswordStore)) {
      throw new Error('RESTIPROCITY_TEST_PASSWORD_STORE must name a keyring backend');
    }
    app.commandLine.appendSwitch('password-store', testPasswordStore);
  }
}

// Every renderer this app starts is sandboxed, whatever its window asks for. Must be set before the app is ready.
// Skipped when the app was started with --no-sandbox (the dev command does that, and some Linux systems need it):
// Electron 39 crashes a few seconds after start when both are set, and there is then no sandbox to enforce.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();

init().catch(console.error);
