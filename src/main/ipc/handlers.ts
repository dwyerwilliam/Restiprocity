import { clipboard, ipcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { CollectionStore } from '../stores/collectionStore';
import { HistoryStore } from '../stores/historyStore';
import { buildHistoryRequestMetadata } from '../stores/historyMetadata';
import type { HistoryRequestMetadata } from '../stores/historyMetadata';
import { RequestEngine } from '../engine/requestEngine';
import { classifyRequestFailure, RequestFailureError } from '../engine/requestErrors';
import { buildRequestFromCurl } from '../../shared/curlImport';
import { createId } from '../../renderer/utils/id';
import { toPersistedResponseV2, toRendererResponseV2 } from '../../shared/responseContracts';
import { normalizeResponseSnapshotV2 } from '../../shared/responseContracts';
import {
  HISTORY_IPC_MAX_FIELD_BYTES,
  HISTORY_IPC_MAX_HEADERS,
  RESPONSE_PREVIEW_MAX_BYTES,
} from '../../shared/responseLimits';
import type {
  CollectionMoveRequestPayload,
  IpcRequestPayload,
  PersistedResponseSnapshotV2,
  ResponseFileActionPayload,
  ResponseOperationResultV2,
  ResponseV2,
  HistoryDetail,
  HistoryDetailErrorPayload,
  HttpMethod,
  UpdateDownloadProgress,
  UpdateStatus,
} from '@shared/types';
import type { RequestProgressEvent } from '../engine/requestRuntimeAdapters';
import type { WindowsAutoUpdaterService, WindowsAutoUpdaterState } from '../update/autoUpdater';
import { openResponseExternally, saveResponseAs } from './responseFileActions';

type RequestOperationPayload = IpcRequestPayload & { operationId: string };

type SenderLike = {
  send(channel: string, payload: unknown): void;
  isDestroyed?: () => boolean;
  on?: (event: 'destroyed', listener: () => void) => void;
  once?: (event: 'destroyed', listener: () => void) => void;
  removeListener?: (event: 'destroyed', listener: () => void) => void;
  off?: (event: 'destroyed', listener: () => void) => void;
};

type RequestOperationCoordinatorDeps = {
  requestEngine: {
    executeV2(payload: IpcRequestPayload, parentWindow?: unknown, onProgress?: (event: RequestProgressEvent) => void): Promise<ResponseV2>;
    cancel(): void;
  };
  historyStore: {
    saveSnapshot(snapshot: PersistedResponseSnapshotV2, metadata?: HistoryRequestMetadata): Promise<void>;
  };
  mainWindow: unknown;
  resolveParentWindow?: () => unknown;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
};

type HistoryProjectionRow = {
  id: string;
  request_id?: string;
  requestId?: string;
  request_name?: string | null;
  requestName?: string;
  method?: string;
  url?: string | null;
  status?: number;
  duration?: number;
  size?: number;
  timestamp?: number;
  headers?: Array<{ key: string; value: string; enabled: boolean }>;
  response_headers?: Array<{ key: string; value: string; enabled: boolean }> | string | null;
  timings?: Record<string, unknown>;
  response_timings?: Record<string, unknown> | string | null;
  cookies?: Array<Record<string, unknown>>;
  cookies_json?: Array<Record<string, unknown>> | string | null;
  preview_kind?: string | null;
  preview_bytes?: Uint8Array | Buffer | number[] | null;
  preview_captured_bytes?: number | null;
  preview_truncated?: number | boolean | null;
  status_text?: string | null;
  charset?: string | null;
  media_type?: string | null;
  download_outcome?: string | null;
  download_filename?: string | null;
  download_bytes?: number | null;
};

type HistoryPreviewKind = 'empty' | 'text' | 'image' | 'binary' | 'download-only';

export class HistoryDetailError extends Error {
  readonly payload: HistoryDetailErrorPayload;

  constructor(message: string) {
    super(message);
    this.name = 'HistoryDetailError';
    this.payload = { code: 'invalid-history-entry', message, retryable: true };
  }
}

function boundedText(value: string): string {
  return value.slice(0, HISTORY_IPC_MAX_FIELD_BYTES);
}

function decodePreviewBytes(bytes: HistoryProjectionRow['preview_bytes']): string {
  if (!bytes) return '';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.subarray(0, RESPONSE_PREVIEW_MAX_BYTES).toString('utf8');
  if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes.subarray(0, RESPONSE_PREVIEW_MAX_BYTES));
  if (Array.isArray(bytes)) return new TextDecoder().decode(Uint8Array.from(bytes.slice(0, RESPONSE_PREVIEW_MAX_BYTES)));
  return '';
}

function sanitizeHeaders(headers: Array<{ key: string; value: string; enabled: boolean }> | undefined) {
  return (headers ?? []).slice(0, HISTORY_IPC_MAX_HEADERS).flatMap((header) => {
    if (typeof header.key !== 'string' || typeof header.value !== 'string') return [];
    const key = boundedText(header.key);
    return ['set-cookie', 'cookie'].includes(key.toLowerCase())
      ? []
      : [{ key, value: boundedText(header.value), enabled: header.enabled === true }];
  });
}

function sanitizeTimings(timings: Record<string, unknown> | undefined) {
  const result: Record<string, number> = {};
  for (const key of ['dns', 'tcp', 'tls', 'ttfb', 'download', 'total'] as const) {
    const value = timings?.[key];
    if (typeof value === 'number') result[key] = value;
  }
  return result;
}

function sanitizeUpdateProgress(progress: Extract<WindowsAutoUpdaterState, { kind: 'downloading' }>['progress']): UpdateDownloadProgress {
  const finite = (value: number): number => Number.isFinite(value) ? value : 0;
  return {
    bytesPerSecond: finite(progress.bytesPerSecond),
    percent: finite(progress.percent),
    total: finite(progress.total),
    transferred: finite(progress.transferred),
  };
}

function sanitizeUpdateErrorMessage(message: string): string {
  const sanitized = message
    .replace(/https?:\/\/[^\s)]+/gi, '[URL redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\s)]*/g, '[path redacted]')
    .replace(/\\\\[^\s)]*/g, '[path redacted]')
    .replace(/\/(?:Users|home|private|tmp|var|opt|mnt)\/[^\s)]*/g, '[path redacted]')
    .slice(0, 512)
    .trim();
  return sanitized || 'Update operation failed.';
}

export function toRendererUpdateStatus(state: WindowsAutoUpdaterState): UpdateStatus {
  switch (state.kind) {
    case 'unsupported':
      return state;
    case 'idle':
      return state;
    case 'checking':
      return state;
    case 'no-update':
      return state;
    case 'available':
      return state;
    case 'downloading':
      return {
        kind: 'downloading',
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
        progress: sanitizeUpdateProgress(state.progress),
      };
    case 'downloaded':
      return {
        kind: 'downloaded',
        currentVersion: state.currentVersion,
        latestVersion: state.latestVersion,
      };
    case 'installing':
      return state;
    case 'error':
      return { ...state, message: sanitizeUpdateErrorMessage(state.message) };
  }
}

function requiredString(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new HistoryDetailError(`History entry has an invalid ${field}.`);
  return boundedText(value);
}

function requiredNumber(value: number | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HistoryDetailError(`History entry has an invalid ${field}.`);
  }
  return value;
}

function requiredDuration(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new HistoryDetailError('History entry has an invalid duration.');
  }
  return value;
}

function requiredMethod(value: string | undefined): HttpMethod {
  switch (value) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
    case 'HEAD':
    case 'OPTIONS':
      return value;
    default:
      throw new HistoryDetailError('History entry has an invalid method.');
  }
}

function requiredPreviewKind(value: string | null | undefined): HistoryPreviewKind {
  switch (value) {
    case null:
    case undefined:
    case 'empty':
      return 'empty';
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'binary':
      return 'binary';
    case 'download-only':
      return 'download-only';
    default:
      throw new HistoryDetailError('History entry has an unsupported preview kind.');
  }
}

export function projectHistoryEntryForIpc(row: HistoryProjectionRow): HistoryDetail {
  const id = requiredString(row.id, 'id');
  const requestId = requiredString(row.requestId ?? row.request_id, 'request id');
  const method = requiredMethod(row.method);
  const url = requiredString(row.url, 'URL');
  const status = requiredNumber(row.status, 'status');
  const duration = requiredDuration(row.duration);
  const size = requiredNumber(row.size, 'size');
  const timestamp = requiredNumber(row.timestamp, 'timestamp');
  const headers = sanitizeHeaders(row.headers ?? (Array.isArray(row.response_headers) ? row.response_headers : undefined));
  const previewKind = requiredPreviewKind(row.preview_kind);
  const previewBytes = row.preview_bytes;
  const preview = normalizeResponseSnapshotV2({
    version: 2,
    id,
    requestId,
    status,
    statusText: boundedText(row.status_text ?? ''),
    headers,
    timings: sanitizeTimings(row.timings ?? (row.response_timings && typeof row.response_timings === 'object' ? row.response_timings : undefined)),
    cookies: [],
    preview: previewKind === 'empty'
      ? { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'unknown' }
      : previewKind === 'text'
        ? {
             kind: 'text', format: 'text', text: decodePreviewBytes(previewBytes), parseState: 'unparsed',
             charset: boundedText(row.charset ?? 'utf-8'), decodeError: false,
             capturedBytes: Math.min(requiredNumber(row.preview_captured_bytes ?? 0, 'captured bytes'), RESPONSE_PREVIEW_MAX_BYTES),
             totalBytes: Math.max(size, Math.min(requiredNumber(row.preview_captured_bytes ?? 0, 'total bytes'), RESPONSE_PREVIEW_MAX_BYTES)),
            truncated: Boolean(row.preview_truncated), completeness: Boolean(row.preview_truncated) ? 'truncated' : 'complete',
          }
        : {
            kind: previewKind === 'download-only' || previewKind === 'image' ? 'download-only' : 'binary',
            mediaType: row.media_type ? boundedText(row.media_type) : null,
            capturedBytes: 0,
            totalBytes: Math.min(requiredNumber(row.download_bytes ?? 0, 'total bytes'), Number.MAX_SAFE_INTEGER),
            truncated: Boolean(row.preview_truncated),
            ...(previewKind === 'image' ? {
              download: { state: 'failed', reason: 'invalid-image', mediaType: row.media_type ? boundedText(row.media_type) : null, receivedBytes: 0 },
            } : {
              download: {
                state: row.download_outcome === 'saved' || row.download_outcome === 'cancelled' || row.download_outcome === 'failed' ? row.download_outcome : 'failed',
                reason: 'binary', mediaType: row.media_type ? boundedText(row.media_type) : null,
                ...(row.download_filename ? { suggestedFileName: boundedText(row.download_filename) } : {}),
                receivedBytes: Math.min(requiredNumber(row.download_bytes ?? 0, 'download bytes'), Number.MAX_SAFE_INTEGER),
              },
            }),
          },
    timestamp,
    size,
  });
  return {
    version: 2,
    id,
    requestId,
    requestName: boundedText(row.requestName ?? row.request_name ?? ''),
    method,
    url,
    status,
    timestamp,
    duration,
    size,
    statusText: preview.statusText,
    headers: preview.headers,
    timings: preview.timings,
    cookies: [],
    preview: preview.preview,
    ...(preview.download ? { download: preview.download } : {}),
  };
}

export class RequestOperationCoordinator {
  private readonly settledResults = new Map<string, ResponseOperationResultV2>();
  private activeOperation: {
    operationId: string;
    sender: SenderLike;
    payload: RequestOperationPayload;
    result: Promise<ResponseOperationResultV2>;
    settledResult: ResponseOperationResultV2 | null;
    timer: ReturnType<typeof setTimeout> | null;
    pendingProgress: RequestProgressEvent | null;
    lastProgressAt: number;
    hasSentProgress: boolean;
    destroyedListener: (() => void) | null;
  } | null = null;

  constructor(private readonly deps: RequestOperationCoordinatorDeps) {}

  send(event: { sender: SenderLike }, payload: RequestOperationPayload): Promise<ResponseOperationResultV2> {
    const sender = event.sender;
    if (this.activeOperation && this.activeOperation.settledResult === null) {
      return Promise.resolve({ version: 2, operationId: payload.operationId, kind: 'busy' } satisfies ResponseOperationResultV2);
    }

    const historyMetadata = buildHistoryRequestMetadata(payload.request);
    const resolvedParentWindow = this.deps.resolveParentWindow?.() ?? this.deps.mainWindow ?? undefined;
    const now = this.deps.now ?? Date.now;
    const setTimer = this.deps.setTimeout ?? globalThis.setTimeout;
    const clearTimer = this.deps.clearTimeout ?? globalThis.clearTimeout;

    let active = this.activeOperation;
    const operation = {
      operationId: payload.operationId,
      sender,
      payload,
      result: Promise.resolve({ version: 2, operationId: payload.operationId, kind: 'cancelled' } as ResponseOperationResultV2),
      settledResult: null as ResponseOperationResultV2 | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      pendingProgress: null as RequestProgressEvent | null,
      lastProgressAt: 0,
      hasSentProgress: false,
      destroyedListener: null as (() => void) | null,
    };
    this.activeOperation = operation;

    const cleanup = () => {
      if (operation.timer !== null) {
        clearTimer(operation.timer);
        operation.timer = null;
      }
      if (operation.destroyedListener) {
        if (sender.off) sender.off('destroyed', operation.destroyedListener);
        else sender.removeListener?.('destroyed', operation.destroyedListener);
        operation.destroyedListener = null;
      }
      if (this.activeOperation === operation) this.activeOperation = null;
    };

    const flushProgress = () => {
      operation.timer = null;
      if (!operation.pendingProgress || sender.isDestroyed?.()) return;
      sender.send('request:progress', { version: 2, operationId: operation.operationId, ...operation.pendingProgress });
      operation.lastProgressAt = now();
      operation.hasSentProgress = true;
      operation.pendingProgress = null;
    };

    const onProgress = (progress: RequestProgressEvent) => {
      if (progress.requestId !== operation.payload.request.id || sender.isDestroyed?.()) return;
      const currentNow = now();
      const message = { version: 2, operationId: operation.operationId, ...progress };
      if (!operation.hasSentProgress) {
        sender.send('request:progress', message);
        operation.lastProgressAt = currentNow;
        operation.hasSentProgress = true;
        operation.pendingProgress = null;
        if (operation.timer !== null) {
          clearTimer(operation.timer);
          operation.timer = null;
        }
        return;
      }

      if (currentNow - operation.lastProgressAt >= 100) {
        sender.send('request:progress', message);
        operation.lastProgressAt = currentNow;
        operation.pendingProgress = null;
        if (operation.timer !== null) {
          clearTimer(operation.timer);
          operation.timer = null;
        }
        return;
      }

      operation.pendingProgress = progress;
      if (operation.timer === null) {
        operation.timer = setTimer(flushProgress, 100 - (currentNow - operation.lastProgressAt));
      }
    };

    operation.destroyedListener = () => {
      if (operation.settledResult) return;
      this.deps.requestEngine.cancel();
    };
    if (sender.once) sender.once('destroyed', operation.destroyedListener);
    else sender.on?.('destroyed', operation.destroyedListener);

    const completion = this.deps.requestEngine.executeV2(payload, resolvedParentWindow, onProgress)
      .then(async (response) => {
        const snapshot = toPersistedResponseV2(response);
        const liveResponse = toRendererResponseV2(response);
        const result: ResponseOperationResultV2 = snapshot.download
          ? snapshot.download.state === 'failed'
            ? {
                version: 2,
                operationId: payload.operationId,
                kind: 'failed' as const,
                error: {
                  kind: 'transport' as const,
                  code: snapshot.download.failure?.code ?? null,
                  message: snapshot.download.failure?.message ?? 'Download failed.',
                  retryable: true,
                },
              }
            : { version: 2, operationId: payload.operationId, kind: 'download' as const, response: liveResponse, download: snapshot.download }
          : { version: 2, operationId: payload.operationId, kind: 'response' as const, response: liveResponse };
        await this.deps.historyStore.saveSnapshot(snapshot, historyMetadata);
        operation.settledResult = result;
        this.settledResults.set(operation.operationId, result);
        cleanup();
        return result;
      })
      .catch((err: unknown) => {
        const error = err instanceof RequestFailureError
          ? err.requestError
          : classifyRequestFailure(err, payload.request.url);

        const result: ResponseOperationResultV2 = error.kind === 'cancelled'
          ? { version: 2, operationId: payload.operationId, kind: 'cancelled' as const }
          : {
              version: 2,
              operationId: payload.operationId,
              kind: 'failed' as const,
              error: {
                kind: error.kind,
                code: error.code,
                message: error.message,
                retryable: error.retryable,
              },
            };
        operation.settledResult = result;
        this.settledResults.set(operation.operationId, result);
        cleanup();
        return result;
      });

    operation.result = completion;
    return completion;
  }

  cancel(event: { sender: SenderLike }, operationId: string): Promise<ResponseOperationResultV2> {
    const sender = event.sender;
    const active = this.activeOperation;
    if (!active || active.operationId !== operationId) {
      return Promise.resolve(this.settledResults.get(operationId) ?? { version: 2, operationId, kind: 'cancelled' } satisfies ResponseOperationResultV2);
    }
    if (active.sender !== sender) {
      return Promise.resolve(this.settledResults.get(operationId) ?? { version: 2, operationId, kind: 'cancelled' } satisfies ResponseOperationResultV2);
    }
    if (active.settledResult) {
      this.settledResults.set(operationId, active.settledResult);
      return Promise.resolve(active.settledResult);
    }
    this.deps.requestEngine.cancel();
    return active.result.then((result) => {
      this.settledResults.set(operationId, result);
      return result;
    });
  }
}

interface IpcDeps {
  mainWindow: BrowserWindow | null;
  collectionStore: CollectionStore;
  historyStore: HistoryStore;
  requestEngine: RequestEngine;
  autoUpdaterService: WindowsAutoUpdaterService;
}

export function setupIpcHandlers(deps: IpcDeps) {
  const { mainWindow, collectionStore, historyStore, requestEngine, autoUpdaterService } = deps;
  const updateSubscribers = new Map<Electron.WebContents, () => void>();
  const requestOperationCoordinator = new RequestOperationCoordinator({
    requestEngine,
    historyStore,
    mainWindow,
  });

  const emitUpdateStatus = (state: WindowsAutoUpdaterState): void => {
    const status = toRendererUpdateStatus(state);
    for (const [sender, removeSubscriber] of updateSubscribers) {
      if (sender.isDestroyed()) {
        removeSubscriber();
        continue;
      }
      try {
        sender.send('update:status', status);
      } catch {
        removeSubscriber();
      }
    }
  };

  autoUpdaterService.on('state', emitUpdateStatus);

  const checkForUpdate = async (): Promise<UpdateStatus> => {
    return toRendererUpdateStatus(await autoUpdaterService.checkForUpdates());
  };
  ipcMain.handle('update:check', checkForUpdate);

  const applyUpdate = async (): Promise<UpdateStatus> => {
    try {
      autoUpdaterService.applyDownloadedUpdate();
    } catch (error: unknown) {
      const state = autoUpdaterService.getState();
      if (state.kind === 'error' && state.stage === 'install') {
        return toRendererUpdateStatus(state);
      }
      return {
        kind: 'error',
        currentVersion: state.currentVersion,
        stage: 'install',
        message: sanitizeUpdateErrorMessage(error instanceof Error ? error.message : String(error)),
        retryable: false,
      } satisfies UpdateStatus;
    }
    return toRendererUpdateStatus(autoUpdaterService.getState());
  };
  ipcMain.handle('update:apply', applyUpdate);

  const subscribeToUpdates = (event: Electron.IpcMainEvent) => {
    const sender = event.sender;
    updateSubscribers.get(sender)?.();

    const removeSubscriber = () => {
      if (updateSubscribers.get(sender) !== removeSubscriber) return;
      updateSubscribers.delete(sender);
      sender.removeListener('destroyed', removeSubscriber);
    };

    updateSubscribers.set(sender, removeSubscriber);
    sender.once('destroyed', removeSubscriber);
    sender.send('update:status', toRendererUpdateStatus(autoUpdaterService.getState()));
  };
  ipcMain.on('update:subscribe', subscribeToUpdates);

  const unsubscribeFromUpdates = (event: Electron.IpcMainEvent) => {
    updateSubscribers.get(event.sender)?.();
  };
  ipcMain.on('update:unsubscribe', unsubscribeFromUpdates);

  // ─── Request Execution ──────────────────────────────────────
  ipcMain.handle('request:send', (event, payload: RequestOperationPayload) => {
    return requestOperationCoordinator.send(event, payload);
  });

  ipcMain.handle('request:cancel', (event, operationId: string) => {
    return requestOperationCoordinator.cancel(event, operationId);
  });

  ipcMain.handle('clipboard:import-curl', async () => {
    const curlText = clipboard.readText().trim();
    if (!curlText) {
      throw new Error('Clipboard is empty.');
    }
    return buildRequestFromCurl(curlText, createId);
  });

  ipcMain.handle('response:save-as', (event, payload: ResponseFileActionPayload) => {
    return saveResponseAs(event.sender, payload);
  });

  ipcMain.handle('response:open-external', (_event, payload: ResponseFileActionPayload) => {
    return openResponseExternally(payload);
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

  ipcMain.handle('collection:move-request', async (_event, data: CollectionMoveRequestPayload) => {
    const result = await collectionStore.moveRequest(data);
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
    const activeId = await collectionStore.deleteEnvironment(id);
    mainWindow?.webContents.send('env:changed', activeId);
    return activeId;
  });

  ipcMain.handle('env:switch', async (_event, id) => {
    const activeId = await collectionStore.switchEnvironment(id);
    mainWindow?.webContents.send('env:changed', activeId);
    return activeId;
  });

  // ─── History ────────────────────────────────────────────────
  ipcMain.handle('history:list', async (_event, filters) => {
    return historyStore.list(filters);
  });

  ipcMain.handle('history:get', async (_event, id: string) => {
    try {
      const row = await historyStore.getEntry(id);
      return row ? projectHistoryEntryForIpc(row) : null;
    } catch (error: unknown) {
      if (error instanceof HistoryDetailError) throw error;
      throw new HistoryDetailError('History entry could not be read.');
    }
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

  return () => {
    autoUpdaterService.removeListener('state', emitUpdateStatus);
    for (const removeSubscriber of updateSubscribers.values()) removeSubscriber();
    ipcMain.removeHandler('update:check');
    ipcMain.removeHandler('update:apply');
    ipcMain.removeHandler('request:send');
    ipcMain.removeHandler('request:cancel');
    ipcMain.removeHandler('response:save-as');
    ipcMain.removeHandler('response:open-external');
    ipcMain.removeHandler('env:list');
    ipcMain.removeHandler('env:create');
    ipcMain.removeHandler('env:update');
    ipcMain.removeHandler('env:delete');
    ipcMain.removeHandler('env:switch');
    ipcMain.removeHandler('history:list');
    ipcMain.removeHandler('history:get');
    ipcMain.removeHandler('history:clear');
    ipcMain.removeListener('update:subscribe', subscribeToUpdates);
    ipcMain.removeListener('update:unsubscribe', unsubscribeFromUpdates);
  };
}
