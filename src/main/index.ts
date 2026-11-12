import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

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
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js'),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    /* In production the app runs from an ASAR archive.  loadFile() can't
       read from inside ASAR — it needs a real filesystem path.  Use
       loadURL() with the asar:// protocol instead. */
    const indexPath = path.join(__dirname, '../../dist/index.html');
    mainWindow.loadURL(`file://${indexPath}`);
  }

  mainWindow.show();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function init() {
  await app.whenReady();

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

init().catch(console.error);
