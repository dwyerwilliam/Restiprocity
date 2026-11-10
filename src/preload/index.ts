import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  CollectionExportFileResult,
  CollectionImportFileResult,
  CollectionMoveRequestPayload,
  CurlExportResult,
  Environment,
  EnvironmentCreateData,
  Id,
  IpcRequestPayload,
  HistoryDetail,
  Request,
  ResponseFileActionPayload,
  ResponseOpenExternalResult,
  ResponseOperationProgressV2,
  ResponseOperationResultV2,
  ResponseSaveAsResult,
  UpdateStatus,
  OAuthBindingPayload,
  OAuthTokenStatus,
} from '@shared/types';

export type RequestOperationPayload = IpcRequestPayload & { operationId: string };
export type RequestProgressUnsubscribe = () => void;
export type UpdateStatusUnsubscribe = () => void;

export interface RendererApi {
  sendRequest(payload: RequestOperationPayload): Promise<ResponseOperationResultV2>;
  cancelRequest: (operationId: string) => Promise<ResponseOperationResultV2>;
  onRequestProgress: (callback: (progress: ResponseOperationProgressV2) => void) => RequestProgressUnsubscribe;
  updateCheck: () => Promise<UpdateStatus>;
  updateApply: () => Promise<UpdateStatus>;
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => UpdateStatusUnsubscribe;
  importCurlFromClipboard: () => Promise<Request>;
  copyRequestAsCurl: (payload: IpcRequestPayload) => Promise<CurlExportResult>;
  /** Saves a request, a folder subtree, or (no id) the whole collection to a file the user picks. */
  exportCollectionFile: (id?: Id) => Promise<CollectionExportFileResult>;
  importCollectionFile: () => Promise<CollectionImportFileResult>;
  saveResponseAs: (payload: ResponseFileActionPayload) => Promise<ResponseSaveAsResult>;
  openResponseExternally: (payload: ResponseFileActionPayload) => Promise<ResponseOpenExternalResult>;
  collectionList: () => Promise<any>;
  collectionCreate: (data: any) => Promise<any>;
  collectionUpdate: (id: string, data: any) => Promise<any>;
  collectionDelete: (id: string) => Promise<any>;
  collectionDuplicate: (id: string) => Promise<any>;
  collectionMoveRequest: (data: CollectionMoveRequestPayload) => Promise<any>;
  collectionReorder: (data: any) => Promise<any>;
  collectionExport: (id: string) => Promise<any>;
  collectionImport: (data: any) => Promise<any>;
  envList: () => Promise<Environment[]>;
  envCreate: (data: EnvironmentCreateData) => Promise<Environment>;
  envUpdate: (id: Id, data: Partial<Environment>) => Promise<Environment>;
  envDelete: (id: Id) => Promise<Id>;
  envSwitch: (id: Id | null) => Promise<Id>;
  historyList: (filters?: any) => Promise<any>;
  historyGet: (id: Id) => Promise<HistoryDetail | null>;
  historyClear: () => Promise<any>;
  settingsGet: () => Promise<AppSettings>;
  settingsSet: (data: Partial<AppSettings>) => Promise<Id>;
  onConsoleLog: (callback: (message: string) => void) => void;
  oauthStatus: (payload: OAuthBindingPayload) => Promise<OAuthTokenStatus>;
  oauthStart: (payload: OAuthBindingPayload) => Promise<OAuthTokenStatus>;
  oauthRefresh: (payload: OAuthBindingPayload) => Promise<OAuthTokenStatus>;
  oauthClear: (payload: OAuthBindingPayload) => Promise<OAuthTokenStatus>;
  oauthCancel: (payload: OAuthBindingPayload) => Promise<OAuthTokenStatus>;
}

const Channels = {
  SEND_REQUEST: 'request:send',
  CANCEL_REQUEST: 'request:cancel',
  REQUEST_PROGRESS: 'request:progress',
  UPDATE_CHECK: 'update:check',
  UPDATE_APPLY: 'update:apply',
  UPDATE_STATUS: 'update:status',
  UPDATE_SUBSCRIBE: 'update:subscribe',
  UPDATE_UNSUBSCRIBE: 'update:unsubscribe',
  COLLECTION_LIST: 'collection:list',
  COLLECTION_CREATE: 'collection:create',
  COLLECTION_UPDATE: 'collection:update',
  COLLECTION_DELETE: 'collection:delete',
  COLLECTION_DUPPLICATE: 'collection:duplicate',
  COLLECTION_MOVE_REQUEST: 'collection:move-request',
  COLLECTION_REORDER: 'collection:reorder',
  COLLECTION_EXPORT: 'collection:export',
  COLLECTION_IMPORT: 'collection:import',
  ENV_LIST: 'env:list',
  ENV_CREATE: 'env:create',
  ENV_UPDATE: 'env:update',
  ENV_DELETE: 'env:delete',
  ENV_SWITCH: 'env:switch',
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  HISTORY_CLEAR: 'history:clear',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  CONSOLE_LOG: 'console:log',
  IMPORT_CURL_FROM_CLIPBOARD: 'clipboard:import-curl',
  RESPONSE_SAVE_AS: 'response:save-as',
  RESPONSE_OPEN_EXTERNAL: 'response:open-external',
  COPY_REQUEST_AS_CURL: 'request:copy-as-curl',
  COLLECTION_EXPORT_FILE: 'collection:export-file',
  COLLECTION_IMPORT_FILE: 'collection:import-file',
  OAUTH_STATUS: 'oauth:status',
  OAUTH_START: 'oauth:start',
  OAUTH_REFRESH: 'oauth:refresh',
  OAUTH_CLEAR: 'oauth:clear',
  OAUTH_CANCEL: 'oauth:cancel',
} as const;

let removeUpdateStatusSubscription: (() => void) | null = null;

function sendRequest(payload: RequestOperationPayload): Promise<ResponseOperationResultV2> {
  return ipcRenderer.invoke(Channels.SEND_REQUEST, payload) as Promise<ResponseOperationResultV2>;
}

const rendererApi: RendererApi = {
  sendRequest,
  cancelRequest: (operationId) => ipcRenderer.invoke(Channels.CANCEL_REQUEST, operationId),
  onRequestProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ResponseOperationProgressV2) => callback(progress);
    ipcRenderer.on(Channels.REQUEST_PROGRESS, listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener(Channels.REQUEST_PROGRESS, listener);
    };
  },
  updateCheck: () => ipcRenderer.invoke(Channels.UPDATE_CHECK) as Promise<UpdateStatus>,
  updateApply: () => ipcRenderer.invoke(Channels.UPDATE_APPLY) as Promise<UpdateStatus>,
  onUpdateStatus: (callback) => {
    removeUpdateStatusSubscription?.();
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => callback(status);
    ipcRenderer.on(Channels.UPDATE_STATUS, listener);
    ipcRenderer.send(Channels.UPDATE_SUBSCRIBE);
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener(Channels.UPDATE_STATUS, listener);
      ipcRenderer.send(Channels.UPDATE_UNSUBSCRIBE);
      if (removeUpdateStatusSubscription === unsubscribe) removeUpdateStatusSubscription = null;
    };
    removeUpdateStatusSubscription = unsubscribe;
    return unsubscribe;
  },
  importCurlFromClipboard: () => ipcRenderer.invoke(Channels.IMPORT_CURL_FROM_CLIPBOARD),
  copyRequestAsCurl: (payload: IpcRequestPayload) =>
    ipcRenderer.invoke(Channels.COPY_REQUEST_AS_CURL, payload) as Promise<CurlExportResult>,
  exportCollectionFile: (id?: Id) =>
    ipcRenderer.invoke(Channels.COLLECTION_EXPORT_FILE, id) as Promise<CollectionExportFileResult>,
  importCollectionFile: () =>
    ipcRenderer.invoke(Channels.COLLECTION_IMPORT_FILE) as Promise<CollectionImportFileResult>,
  saveResponseAs: (payload: ResponseFileActionPayload) =>
    ipcRenderer.invoke(Channels.RESPONSE_SAVE_AS, payload) as Promise<ResponseSaveAsResult>,
  openResponseExternally: (payload: ResponseFileActionPayload) =>
    ipcRenderer.invoke(Channels.RESPONSE_OPEN_EXTERNAL, payload) as Promise<ResponseOpenExternalResult>,
  collectionList: () => ipcRenderer.invoke(Channels.COLLECTION_LIST),
  collectionCreate: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_CREATE, data),
  collectionUpdate: (id: string, data: any) => ipcRenderer.invoke(Channels.COLLECTION_UPDATE, id, data),
  collectionDelete: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_DELETE, id),
  collectionDuplicate: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_DUPPLICATE, id),
  collectionMoveRequest: (data: CollectionMoveRequestPayload) => ipcRenderer.invoke(Channels.COLLECTION_MOVE_REQUEST, data),
  collectionReorder: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_REORDER, data),
  collectionExport: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_EXPORT, id),
  collectionImport: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_IMPORT, data),
  envList: () => ipcRenderer.invoke(Channels.ENV_LIST),
  envCreate: (data: any) => ipcRenderer.invoke(Channels.ENV_CREATE, data),
  envUpdate: (id: string, data: any) => ipcRenderer.invoke(Channels.ENV_UPDATE, id, data),
  envDelete: (id: string) => ipcRenderer.invoke(Channels.ENV_DELETE, id),
  envSwitch: (id: Id | null) => ipcRenderer.invoke(Channels.ENV_SWITCH, id),
  historyList: (filters?: any) => ipcRenderer.invoke(Channels.HISTORY_LIST, filters),
  historyGet: (id: Id) => ipcRenderer.invoke(Channels.HISTORY_GET, id) as Promise<HistoryDetail | null>,
  historyClear: () => ipcRenderer.invoke(Channels.HISTORY_CLEAR),
  settingsGet: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
  settingsSet: (data: any) => ipcRenderer.invoke(Channels.SETTINGS_SET, data),
  onConsoleLog: (callback: (message: string) => void) => {
    ipcRenderer.on(Channels.CONSOLE_LOG, (_event, message: string) => callback(message));
  },
  oauthStatus: (payload) => ipcRenderer.invoke(Channels.OAUTH_STATUS, payload) as Promise<OAuthTokenStatus>,
  oauthStart: (payload) => ipcRenderer.invoke(Channels.OAUTH_START, payload) as Promise<OAuthTokenStatus>,
  oauthRefresh: (payload) => ipcRenderer.invoke(Channels.OAUTH_REFRESH, payload) as Promise<OAuthTokenStatus>,
  oauthClear: (payload) => ipcRenderer.invoke(Channels.OAUTH_CLEAR, payload) as Promise<OAuthTokenStatus>,
  oauthCancel: (payload) => ipcRenderer.invoke(Channels.OAUTH_CANCEL, payload) as Promise<OAuthTokenStatus>,
};

contextBridge.exposeInMainWorld('api', rendererApi);

declare global {
  interface Window {
    api: RendererApi;
  }
}
