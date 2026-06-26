import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc/handlers';
import { CollectionStore } from './stores/collectionStore';
import { HistoryStore } from './stores/historyStore';
import { RequestEngine } from './engine/requestEngine';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let collectionStore: CollectionStore;
let historyStore: HistoryStore;
let requestEngine: RequestEngine;

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

  // Dev mode: load Vite dev server. Prod: load built files.
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

  // Initialize stores
  collectionStore = new CollectionStore(userDataPath);
  await collectionStore.init();

  historyStore = new HistoryStore(userDataPath);
  await historyStore.init();

  // Initialize request engine
  requestEngine = new RequestEngine(session.defaultSession, collectionStore);

  // Setup IPC handlers
  setupIpcHandlers({
    mainWindow,
    collectionStore,
    historyStore,
    requestEngine,
  });

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
