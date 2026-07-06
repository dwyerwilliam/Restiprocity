import { ipcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { CollectionStore } from '../stores/collectionStore';
import { HistoryStore } from '../stores/historyStore';
import { RequestEngine } from '../engine/requestEngine';
import { classifyRequestFailure, RequestFailureError } from '../engine/requestErrors';

interface IpcDeps {
  mainWindow: BrowserWindow | null;
  collectionStore: CollectionStore;
  historyStore: HistoryStore;
  requestEngine: RequestEngine;
}

export function setupIpcHandlers(deps: IpcDeps) {
  const { mainWindow, collectionStore, historyStore, requestEngine } = deps;

  // ─── Request Execution ──────────────────────────────────────
  ipcMain.handle('request:send', async (_event, payload) => {
    try {
      const response = await requestEngine.execute(payload);
      if (response) {
        await historyStore.save(response);
      }
      return { success: true, response };
    } catch (err: unknown) {
      const error = err instanceof RequestFailureError
        ? err.requestError
        : classifyRequestFailure(err, payload?.request?.url ?? '');
      return { success: false, error };
    }
  });

  ipcMain.handle('request:cancel', async () => {
    requestEngine.cancel();
  });

  // ─── Collections ────────────────────────────────────────────
  ipcMain.handle('collection:list', async () => {
    return collectionStore.listAll();
  });

  ipcMain.handle('collection:create', async (_event, data) => {
    const result = await collectionStore.create(data);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  ipcMain.handle('collection:update', async (_event, id, data) => {
    const result = await collectionStore.update(id, data);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  ipcMain.handle('collection:delete', async (_event, id) => {
    const result = await collectionStore.delete(id);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  ipcMain.handle('collection:duplicate', async (_event, id) => {
    const result = await collectionStore.duplicate(id);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  ipcMain.handle('collection:reorder', async (_event, data) => {
    const result = await collectionStore.reorder(data);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  ipcMain.handle('collection:export', async (_event, id) => {
    return collectionStore.export(id);
  });

  ipcMain.handle('collection:import', async (_event, data) => {
    const result = await collectionStore.import(data);
    mainWindow?.webContents.send('collection:changed');
    return result;
  });

  // ─── Environments ───────────────────────────────────────────
  ipcMain.handle('env:list', async () => {
    return collectionStore.listEnvironments();
  });

  ipcMain.handle('env:create', async (_event, data) => {
    return collectionStore.createEnvironment(data);
  });

  ipcMain.handle('env:update', async (_event, id, data) => {
    return collectionStore.updateEnvironment(id, data);
  });

  ipcMain.handle('env:delete', async (_event, id) => {
    return collectionStore.deleteEnvironment(id);
  });

  ipcMain.handle('env:switch', async (_event, id) => {
    collectionStore.switchEnvironment(id);
    mainWindow?.webContents.send('env:changed', id);
  });

  // ─── History ────────────────────────────────────────────────
  ipcMain.handle('history:list', async (_event, filters) => {
    return historyStore.list(filters);
  });

  ipcMain.handle('history:clear', async () => {
    return historyStore.clear();
  });

  // ─── Settings ───────────────────────────────────────────────
  ipcMain.handle('settings:get', async () => {
    return collectionStore.getSettings();
  });

  ipcMain.handle('settings:set', async (_event, data) => {
    return collectionStore.saveSettings(data);
  });
}
