import { clipboard, ipcMain } from 'electron';
import { BrowserWindow } from 'electron';
import { CollectionStore } from '../stores/collectionStore';
import { HistoryStore } from '../stores/historyStore';
import { RequestEngine } from '../engine/requestEngine';
import { classifyRequestFailure, RequestFailureError } from '../engine/requestErrors';
import { buildRequestFromCurl } from '../../shared/curlImport';
import { createId } from '../../renderer/utils/id';
import { toPersistedResponseV2, toRendererResponseV2 } from '../../shared/responseContracts';
import type {
  CollectionMoveRequestPayload,
  IpcRequestPayload,
  PersistedResponseSnapshotV2,
  ResponseOperationResultV2,
  ResponseV2,
  UpdateDownloadProgress,
  UpdateStatus,
} from '@shared/types';
import type { RequestProgressEvent } from '../engine/requestRuntimeAdapters';
import type { WindowsAutoUpdaterService, WindowsAutoUpdaterState } from '../update/autoUpdater';

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
    saveSnapshot(snapshot: PersistedResponseSnapshotV2): Promise<void>;
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
  request_name?: string;
  requestName?: string;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  size?: number;
  timestamp?: number;
  headers?: Array<{ key: string; value: string; enabled: boolean }>;
  response_headers?: Array<{ key: string; value: string; enabled: boolean }>;
  timings?: Record<string, unknown>;
  response_timings?: Record<string, unknown>;
  cookies?: Array<Record<string, unknown>>;
  cookies_json?: Array<Record<string, unknown>>;
  preview_kind?: string;
  preview_bytes?: Uint8Array | Buffer | number[] | null;
  preview_captured_bytes?: number;
  preview_truncated?: number | boolean;
  status_text?: string;
  charset?: string | null;
  media_type?: string | null;
};

function decodePreviewBytes(bytes: HistoryProjectionRow['preview_bytes']): string {
  if (!bytes) return '';
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes)) return bytes.toString('utf8');
  if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes);
  if (Array.isArray(bytes)) return new TextDecoder().decode(Uint8Array.from(bytes));
  return '';
}

function sanitizeHeaders(headers: Array<{ key: string; value: string; enabled: boolean }> | undefined) {
  return (headers ?? []).filter((header) => !['set-cookie', 'cookie'].includes(header.key.toLowerCase()));
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

export function projectHistoryEntryForIpc(row: HistoryProjectionRow): Record<string, unknown> {
  const headers = sanitizeHeaders(row.response_headers ?? row.headers);
  const previewKind = row.preview_kind ?? 'text';
  const previewBytes = row.preview_bytes;
  return {
    version: 2,
    id: row.id,
    requestId: row.requestId ?? row.request_id ?? '',
    requestName: row.requestName ?? row.request_name ?? '',
    method: row.method ?? '',
    url: row.url ?? '',
    status: row.status ?? 0,
    duration: row.duration ?? sanitizeTimings(row.response_timings ?? row.timings).total ?? 0,
    size: row.size ?? 0,
    timestamp: row.timestamp ?? 0,
    statusText: row.status_text ?? '',
    headers,
    timings: sanitizeTimings(row.response_timings ?? row.timings),
    cookies: [],
    preview: previewKind === 'empty'
      ? {
          kind: 'empty' as const,
          capturedBytes: 0,
          totalBytes: 0,
          truncated: false,
          completeness: 'unknown' as const,
        }
      : {
          kind: 'text' as const,
          format: 'text' as const,
          text: decodePreviewBytes(previewBytes),
          parseState: 'valid' as const,
          charset: row.charset ?? 'utf-8',
          decodeError: false,
          capturedBytes: row.preview_captured_bytes ?? (previewBytes ? (previewBytes instanceof Uint8Array ? previewBytes.byteLength : Array.isArray(previewBytes) ? previewBytes.length : 0) : 0),
          totalBytes: row.preview_captured_bytes ?? (previewBytes ? (previewBytes instanceof Uint8Array ? previewBytes.byteLength : Array.isArray(previewBytes) ? previewBytes.length : 0) : 0),
          truncated: Boolean(row.preview_truncated),
          completeness: 'complete' as const,
        },
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
            : { version: 2, operationId: payload.operationId, kind: 'download' as const, response: toRendererResponseV2(snapshot), download: snapshot.download }
          : { version: 2, operationId: payload.operationId, kind: 'response' as const, response: toRendererResponseV2(snapshot) };
        await this.deps.historyStore.saveSnapshot(snapshot);
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

  return () => {
    autoUpdaterService.removeListener('state', emitUpdateStatus);
    for (const removeSubscriber of updateSubscribers.values()) removeSubscriber();
    ipcMain.removeHandler('update:check');
    ipcMain.removeHandler('update:apply');
    ipcMain.removeHandler('request:send');
    ipcMain.removeHandler('request:cancel');
    ipcMain.removeListener('update:subscribe', subscribeToUpdates);
    ipcMain.removeListener('update:unsubscribe', unsubscribeFromUpdates);
  };
}
