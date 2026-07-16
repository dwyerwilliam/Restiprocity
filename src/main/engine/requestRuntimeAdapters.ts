import { app, dialog, net } from 'electron';
import type {
  AuthInfo,
  BaseWindow,
  ClientRequestConstructorOptions,
  SaveDialogOptions,
  SaveDialogReturnValue,
  Session,
} from 'electron';
import fs from 'fs/promises';

export interface RuntimeFetchResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Pick<Headers, 'entries'>;
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

export type SessionFetchAdapter = (
  requestSession: Session,
  url: string,
  init: RequestInit,
) => Promise<RuntimeFetchResponse>;

export interface RuntimeIncomingMessage {
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
  off(event: 'data', listener: (chunk: Buffer) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'end', listener: () => void): this;
}

export interface RuntimeClientRequest {
  setHeader(name: string, value: string): void;
  end(chunk?: string | Buffer): this;
  abort(): void;
  followRedirect(): void;
  on(event: 'redirect', listener: (
    statusCode: number,
    method: string,
    redirectUrl: string,
    responseHeaders: Record<string, string[]>,
  ) => void): this;
  on(event: 'login', listener: (
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => void): this;
  on(event: 'response', listener: (response: RuntimeIncomingMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  off(event: 'redirect', listener: (
    statusCode: number,
    method: string,
    redirectUrl: string,
    responseHeaders: Record<string, string[]>,
  ) => void): this;
  off(event: 'login', listener: (
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => void): this;
  off(event: 'response', listener: (response: RuntimeIncomingMessage) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: () => void): this;
}

export type NetRequestOptions = Pick<ClientRequestConstructorOptions, 'url' | 'method' | 'session'>;
export type NetRequestAdapter = (options: NetRequestOptions) => RuntimeClientRequest;

export interface RequestFileSystemAdapter {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(filePath: string): Promise<void>;
}

export interface RequestClockAdapter {
  monotonicNow(): number;
  wallNow(): number;
}

export interface RequestTimerHandle {
  readonly id: symbol;
}

export interface RequestTimerAdapter {
  setTimeout(callback: () => void, delayMs: number): RequestTimerHandle;
  clearTimeout(handle: RequestTimerHandle): void;
  setImmediate(callback: () => void): RequestTimerHandle;
  clearImmediate(handle: RequestTimerHandle): void;
}

export interface RequestProgressEvent {
  requestId: string;
  phase: string;
  receivedBytes: number;
  totalBytes?: number;
}

export interface RequestRuntimeAdapters {
  fetch: SessionFetchAdapter;
  netRequest: NetRequestAdapter;
  showSaveDialog(parentWindow: BaseWindow | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  fileSystem: RequestFileSystemAdapter;
  clock: RequestClockAdapter;
  timers: RequestTimerAdapter;
  getTempRoot(): string;
  emitProgress(event: RequestProgressEvent): void;
}

export type RequestRuntimeAdapterOverrides = Partial<RequestRuntimeAdapters>;

function createProductionTimers(): RequestTimerAdapter {
  const timeouts = new Map<RequestTimerHandle, NodeJS.Timeout>();
  const immediates = new Map<RequestTimerHandle, NodeJS.Immediate>();

  return {
    setTimeout(callback, delayMs) {
      const handle: RequestTimerHandle = { id: Symbol('request-timeout') };
      const nativeHandle = setTimeout(() => {
        timeouts.delete(handle);
        callback();
      }, delayMs);
      timeouts.set(handle, nativeHandle);
      return handle;
    },
    clearTimeout(handle) {
      const nativeHandle = timeouts.get(handle);
      if (nativeHandle) clearTimeout(nativeHandle);
      timeouts.delete(handle);
    },
    setImmediate(callback) {
      const handle: RequestTimerHandle = { id: Symbol('request-immediate') };
      const nativeHandle = setImmediate(() => {
        immediates.delete(handle);
        callback();
      });
      immediates.set(handle, nativeHandle);
      return handle;
    },
    clearImmediate(handle) {
      const nativeHandle = immediates.get(handle);
      if (nativeHandle) clearImmediate(nativeHandle);
      immediates.delete(handle);
    },
  };
}

export const defaultRequestRuntimeAdapters: RequestRuntimeAdapters = {
  fetch: (requestSession, url, init) => requestSession.fetch(url, init),
  netRequest: (options) => net.request(options),
  showSaveDialog: (parentWindow, options) => parentWindow
    ? dialog.showSaveDialog(parentWindow, options)
    : dialog.showSaveDialog(options),
  fileSystem: {
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    writeFile: async (filePath, data) => { await fs.writeFile(filePath, data); },
    mkdir: async (directoryPath) => { await fs.mkdir(directoryPath, { recursive: true }); },
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    rm: async (filePath) => { await fs.rm(filePath, { force: true }); },
  },
  clock: {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  },
  timers: createProductionTimers(),
  getTempRoot: () => app.getPath('temp'),
  emitProgress: () => {},
};

export function createRequestRuntimeAdapters(
  overrides: RequestRuntimeAdapterOverrides = {},
): RequestRuntimeAdapters {
  return {
    ...defaultRequestRuntimeAdapters,
    ...overrides,
  };
}
