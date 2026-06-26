import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc/handlers';
import { CollectionStore } from './stores/collectionStore';
import { HistoryStore } from './stores/historyStore';
import { RequestEngine } from './engine/requestEngine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let collectionStore: CollectionStore;
let historyStore: HistoryStore;
let requestEngine: RequestEngine;

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
    icon: path.join(__dirname, '../../public/icon.png'),
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function init() {
  const userDataPath = app.getPath('userData');

  collectionStore = new CollectionStore(userDataPath);
  await collectionStore.init();

  historyStore = new HistoryStore(userDataPath);
  await historyStore.init();

  requestEngine = new RequestEngine(session.defaultSession, collectionStore);

  setupIpcHandlers({
    mainWindow,
    collectionStore,
    historyStore,
    requestEngine,
  });

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  await app.whenReady();
  createWindow();
}

init().catch(console.error);
