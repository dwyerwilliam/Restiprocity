import { contextBridge, ipcRenderer } from 'electron';
import { IpcRequestPayload, IpcResponsePayload } from '@shared/types';

// IPC channel names
const Channels = {
  // Request execution
  SEND_REQUEST: 'request:send',
  CANCEL_REQUEST: 'request:cancel',

  // Collections
  COLLECTION_LIST: 'collection:list',
  COLLECTION_CREATE: 'collection:create',
  COLLECTION_UPDATE: 'collection:update',
  COLLECTION_DELETE: 'collection:delete',
  COLLECTION_DUPPLICATE: 'collection:duplicate',
  COLLECTION_REORDER: 'collection:reorder',
  COLLECTION_EXPORT: 'collection:export',
  COLLECTION_IMPORT: 'collection:import',

  // Environments
  ENV_LIST: 'env:list',
  ENV_CREATE: 'env:create',
  ENV_UPDATE: 'env:update',
  ENV_DELETE: 'env:delete',
  ENV_SWITCH: 'env:switch',

  // History
  HISTORY_LIST: 'history:list',
  HISTORY_CLEAR: 'history:clear',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Console
  CONSOLE_LOG: 'console:log',
} as const;

// Expose to renderer via contextBridge
contextBridge.exposeInMainWorld('api', {
  // Requests
  sendRequest: (payload: IpcRequestPayload): Promise<IpcResponsePayload> =>
    ipcRenderer.invoke(Channels.SEND_REQUEST, payload),
  cancelRequest: (): Promise<void> =>
    ipcRenderer.invoke(Channels.CANCEL_REQUEST),

  // Collections
  collectionList: () =>
    ipcRenderer.invoke(Channels.COLLECTION_LIST),
  collectionCreate: (data: any) =>
    ipcRenderer.invoke(Channels.COLLECTION_CREATE, data),
  collectionUpdate: (id: string, data: any) =>
    ipcRenderer.invoke(Channels.COLLECTION_UPDATE, id, data),
  collectionDelete: (id: string) =>
    ipcRenderer.invoke(Channels.COLLECTION_DELETE, id),
  collectionDuplicate: (id: string) =>
    ipcRenderer.invoke(Channels.COLLECTION_DUPPLICATE, id),
  collectionReorder: (data: any) =>
    ipcRenderer.invoke(Channels.COLLECTION_REORDER, data),
  collectionExport: (id: string) =>
    ipcRenderer.invoke(Channels.COLLECTION_EXPORT, id),
  collectionImport: (data: any) =>
    ipcRenderer.invoke(Channels.COLLECTION_IMPORT, data),

  // Environments
  envList: () =>
    ipcRenderer.invoke(Channels.ENV_LIST),
  envCreate: (data: any) =>
    ipcRenderer.invoke(Channels.ENV_CREATE, data),
  envUpdate: (id: string, data: any) =>
    ipcRenderer.invoke(Channels.ENV_UPDATE, id, data),
  envDelete: (id: string) =>
    ipcRenderer.invoke(Channels.ENV_DELETE, id),
  envSwitch: (id: string) =>
    ipcRenderer.invoke(Channels.ENV_SWITCH, id),

  // History
  historyList: (filters?: any) =>
    ipcRenderer.invoke(Channels.HISTORY_LIST, filters),
  historyClear: () =>
    ipcRenderer.invoke(Channels.HISTORY_CLEAR),

  // Settings
  settingsGet: () =>
    ipcRenderer.invoke(Channels.SETTINGS_GET),
  settingsSet: (data: any) =>
    ipcRenderer.invoke(Channels.SETTINGS_SET, data),

  // Console (one-way, renderer receives logs from main)
  onConsoleLog: (callback: (message: string) => void) => {
    ipcRenderer.on(Channels.CONSOLE_LOG, (_event, message: string) => {
      callback(message);
    });
  },
});

// Type declaration for window.api
declare global {
  interface Window {
    api: {
      sendRequest: (payload: IpcRequestPayload) => Promise<IpcResponsePayload>;
      cancelRequest: () => Promise<void>;
      collectionList: () => Promise<any>;
      collectionCreate: (data: any) => Promise<any>;
      collectionUpdate: (id: string, data: any) => Promise<any>;
      collectionDelete: (id: string) => Promise<any>;
      collectionDuplicate: (id: string) => Promise<any>;
      collectionReorder: (data: any) => Promise<any>;
      collectionExport: (id: string) => Promise<any>;
      collectionImport: (data: any) => Promise<any>;
      envList: () => Promise<any>;
      envCreate: (data: any) => Promise<any>;
      envUpdate: (id: string, data: any) => Promise<any>;
      envDelete: (id: string) => Promise<any>;
      envSwitch: (id: string) => Promise<any>;
      historyList: (filters?: any) => Promise<any>;
      historyClear: () => Promise<any>;
      settingsGet: () => Promise<any>;
      settingsSet: (data: any) => Promise<any>;
      onConsoleLog: (callback: (message: string) => void) => void;
    };
  }
}
