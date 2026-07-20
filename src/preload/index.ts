import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcRequestPayload,
  IpcResponsePayload,
  Request,
  RequestError,
  Response,
  ResponseOperationProgressV2,
  ResponseOperationResultV2,
  ResponseV2,
} from '@shared/types';

export type RequestOperationPayload = IpcRequestPayload & { operationId: string };
export type RequestProgressUnsubscribe = () => void;

export interface RendererApi {
  sendRequest(payload: RequestOperationPayload): Promise<ResponseOperationResultV2>;
  sendRequest(payload: IpcRequestPayload): Promise<IpcResponsePayload>;
  cancelRequest: (operationId: string) => Promise<ResponseOperationResultV2>;
  onRequestProgress: (callback: (progress: ResponseOperationProgressV2) => void) => RequestProgressUnsubscribe;
  importCurlFromClipboard: () => Promise<Request>;
  collectionList: () => Promise<any>;
  collectionCreate: (data: any) => Promise<any>;
  collectionUpdate: (id: string, data: any) => Promise<any>;
  collectionDelete: (id: string) => Promise<any>;
  collectionDuplicate: (id: string) => Promise<any>;
  collectionReorder: (data: any) => Promise<any>;
  collectionExport: (id: string) => Promise<any>;
  collectionImport: (data: any) => Promise<any>;
  onCollectionChanged: (callback: () => void) => void;
  envList: () => Promise<any>;
  envCreate: (data: any) => Promise<any>;
  envUpdate: (id: string, data: any) => Promise<any>;
  envDelete: (id: string) => Promise<any>;
  envSwitch: (id: string) => Promise<any>;
  historyList: (filters?: any) => Promise<any>;
  historyGet: (id: string) => Promise<Record<string, unknown> | null>;
  historyClear: () => Promise<any>;
  settingsGet: () => Promise<any>;
  settingsSet: (data: any) => Promise<any>;
  onConsoleLog: (callback: (message: string) => void) => void;
}

const Channels = {
  SEND_REQUEST: 'request:send',
  CANCEL_REQUEST: 'request:cancel',
  REQUEST_PROGRESS: 'request:progress',
  COLLECTION_LIST: 'collection:list',
  COLLECTION_CREATE: 'collection:create',
  COLLECTION_UPDATE: 'collection:update',
  COLLECTION_DELETE: 'collection:delete',
  COLLECTION_DUPPLICATE: 'collection:duplicate',
  COLLECTION_REORDER: 'collection:reorder',
  COLLECTION_EXPORT: 'collection:export',
  COLLECTION_IMPORT: 'collection:import',
  COLLECTION_CHANGED: 'collection:changed',
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
} as const;

function legacyOperationId(requestId: string): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `legacy-${requestId}-${token}`.slice(0, 128);
}

function legacyResponse(response: ResponseV2): Response {
  return {
    id: response.id,
    requestId: response.requestId,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.preview.kind === 'text'
      ? response.preview.text
      : response.preview.kind === 'empty'
        ? ''
        : `[${response.preview.kind} response: ${response.preview.mediaType ?? 'unknown'}]`,
    timings: response.timings,
    timestamp: response.timestamp,
    size: response.size,
    cookies: response.cookies,
  };
}

function legacyRequestError(result: ResponseOperationResultV2, url: string): RequestError {
  if (result.kind === 'failed') {
    return { ...result.error, rawMessage: result.error.message, url };
  }
  if (result.kind === 'busy') {
    return {
      kind: 'transport',
      code: 'REQUEST_BUSY',
      message: 'Another request is already active',
      rawMessage: 'Another request is already active',
      url,
      retryable: true,
    };
  }
  return {
    kind: 'cancelled',
    code: null,
    message: 'Request was cancelled',
    rawMessage: 'Request was cancelled',
    url,
    retryable: false,
  };
}

function sendRequest(payload: RequestOperationPayload): Promise<ResponseOperationResultV2>;
function sendRequest(payload: IpcRequestPayload): Promise<IpcResponsePayload>;
async function sendRequest(payload: RequestOperationPayload | IpcRequestPayload): Promise<ResponseOperationResultV2 | IpcResponsePayload> {
  if ('operationId' in payload) {
    return ipcRenderer.invoke(Channels.SEND_REQUEST, payload) as Promise<ResponseOperationResultV2>;
  }
  const result = await ipcRenderer.invoke(Channels.SEND_REQUEST, {
    ...payload,
    operationId: legacyOperationId(payload.request.id),
  }) as ResponseOperationResultV2;
  if (result.kind === 'response' || result.kind === 'download') {
    return { success: true, response: legacyResponse(result.response) };
  }
  return { success: false, error: legacyRequestError(result, payload.request.url) };
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
  importCurlFromClipboard: () => ipcRenderer.invoke(Channels.IMPORT_CURL_FROM_CLIPBOARD),
  collectionList: () => ipcRenderer.invoke(Channels.COLLECTION_LIST),
  collectionCreate: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_CREATE, data),
  collectionUpdate: (id: string, data: any) => ipcRenderer.invoke(Channels.COLLECTION_UPDATE, id, data),
  collectionDelete: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_DELETE, id),
  collectionDuplicate: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_DUPPLICATE, id),
  collectionReorder: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_REORDER, data),
  collectionExport: (id: string) => ipcRenderer.invoke(Channels.COLLECTION_EXPORT, id),
  collectionImport: (data: any) => ipcRenderer.invoke(Channels.COLLECTION_IMPORT, data),
  onCollectionChanged: (callback: () => void) => {
    ipcRenderer.on(Channels.COLLECTION_CHANGED, () => callback());
  },
  envList: () => ipcRenderer.invoke(Channels.ENV_LIST),
  envCreate: (data: any) => ipcRenderer.invoke(Channels.ENV_CREATE, data),
  envUpdate: (id: string, data: any) => ipcRenderer.invoke(Channels.ENV_UPDATE, id, data),
  envDelete: (id: string) => ipcRenderer.invoke(Channels.ENV_DELETE, id),
  envSwitch: (id: string) => ipcRenderer.invoke(Channels.ENV_SWITCH, id),
  historyList: (filters?: any) => ipcRenderer.invoke(Channels.HISTORY_LIST, filters),
  historyGet: (id: string) => ipcRenderer.invoke(Channels.HISTORY_GET, id),
  historyClear: () => ipcRenderer.invoke(Channels.HISTORY_CLEAR),
  settingsGet: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
  settingsSet: (data: any) => ipcRenderer.invoke(Channels.SETTINGS_SET, data),
  onConsoleLog: (callback: (message: string) => void) => {
    ipcRenderer.on(Channels.CONSOLE_LOG, (_event, message: string) => callback(message));
  },
};

contextBridge.exposeInMainWorld('api', rendererApi);

declare global {
  interface Window {
    api: RendererApi;
  }
}
