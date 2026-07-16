import { EventEmitter } from 'events';
import path from 'path';
import type {
  NetRequestAdapter,
  RequestFileSystemAdapter,
  RequestRuntimeAdapters,
  RequestTimerHandle,
  RequestTimerAdapter,
  RuntimeClientRequest,
  RuntimeIncomingMessage,
  SessionFetchAdapter,
} from '../../../src/main/engine/requestRuntimeAdapters';

export interface ResponseChunkFixture {
  data: string | Buffer;
  delayMs?: number;
}

export interface RedirectFixture {
  statusCode: number;
  method: string;
  url: string;
  headers?: Record<string, string[]>;
}

export interface HttpResponseFixtureOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[]>;
  chunks?: ResponseChunkFixture[];
  headersDelayMs?: number;
  redirect?: RedirectFixture;
  contentEncoding?: string;
  contentLength?: 'actual' | 'missing' | number;
  emitResponse?: boolean;
  termination?: 'end' | 'error' | 'stall';
  terminationError?: Error;
}

interface ScheduledTask {
  handle: RequestTimerHandle;
  dueAt: number;
  order: number;
  callback: () => void;
}

export class DeterministicTimers implements RequestTimerAdapter {
  private currentTime = 0;
  private nextOrder = 0;
  private readonly tasks = new Map<RequestTimerHandle, ScheduledTask>();

  get now(): number {
    return this.currentTime;
  }

  get pendingCount(): number {
    return this.tasks.size;
  }

  setTimeout(callback: () => void, delayMs: number): RequestTimerHandle {
    return this.schedule(callback, Math.max(delayMs, 0));
  }

  clearTimeout(handle: RequestTimerHandle): void {
    this.tasks.delete(handle);
  }

  setImmediate(callback: () => void): RequestTimerHandle {
    return this.schedule(callback, 0);
  }

  clearImmediate(handle: RequestTimerHandle): void {
    this.tasks.delete(handle);
  }

  advanceBy(milliseconds: number): void {
    const targetTime = this.currentTime + milliseconds;
    this.runUntil(targetTime);
    this.currentTime = targetTime;
  }

  runReady(): void {
    this.runUntil(this.currentTime);
  }

  runAll(): void {
    while (this.tasks.size > 0) {
      const next = this.nextTask();
      if (!next) return;
      this.runUntil(next.dueAt);
      this.currentTime = next.dueAt;
    }
  }

  private schedule(callback: () => void, delayMs: number): RequestTimerHandle {
    const handle: RequestTimerHandle = { id: Symbol('test-timer') };
    this.tasks.set(handle, {
      handle,
      dueAt: this.currentTime + delayMs,
      order: this.nextOrder++,
      callback,
    });
    return handle;
  }

  private runUntil(targetTime: number): void {
    while (true) {
      const next = this.nextTask();
      if (!next || next.dueAt > targetTime) return;
      this.currentTime = next.dueAt;
      this.tasks.delete(next.handle);
      next.callback();
    }
  }

  private nextTask(): ScheduledTask | undefined {
    return [...this.tasks.values()].sort((left, right) =>
      left.dueAt - right.dueAt || left.order - right.order
    )[0];
  }
}

export class FakeIncomingMessage extends EventEmitter implements RuntimeIncomingMessage {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: Record<string, string | string[]>;

  constructor(options: HttpResponseFixtureOptions) {
    super();
    this.statusCode = options.status ?? 200;
    this.statusMessage = options.statusText ?? 'OK';
    this.headers = buildHeaders(options);
  }
}

export class FakeClientRequest extends EventEmitter implements RuntimeClientRequest {
  readonly headers = new Map<string, string>();
  abortCalls = 0;
  endCalls = 0;
  followRedirectCalls = 0;
  ended = false;

  constructor(
    private readonly onEnd: (request: FakeClientRequest) => void = () => {},
    private readonly onAbort: (request: FakeClientRequest) => void = () => {},
  ) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  end(): this {
    this.endCalls += 1;
    this.ended = true;
    this.onEnd(this);
    return this;
  }

  abort(): void {
    this.abortCalls += 1;
    this.onAbort(this);
  }

  followRedirect(): void {
    this.followRedirectCalls += 1;
  }
}

export interface NetResponseFixture {
  request: FakeClientRequest;
  response: FakeIncomingMessage;
  netRequest: NetRequestAdapter;
}

export function createNetResponseFixture(
  options: HttpResponseFixtureOptions,
  timers: DeterministicTimers,
  onAbort?: (request: FakeClientRequest) => void,
): NetResponseFixture {
  const response = new FakeIncomingMessage(options);
  const request = new FakeClientRequest((currentRequest) => {
    let elapsed = options.headersDelayMs ?? 0;

    if (options.redirect) {
      const redirect = options.redirect;
      timers.setTimeout(() => {
        currentRequest.emit('redirect', redirect.statusCode, redirect.method, redirect.url, redirect.headers ?? {});
      }, elapsed);
    }

    if (options.emitResponse === false) return;

    timers.setTimeout(() => currentRequest.emit('response', response), elapsed);

    for (const chunk of options.chunks ?? []) {
      elapsed += chunk.delayMs ?? 0;
      timers.setTimeout(() => response.emit('data', toBuffer(chunk.data)), elapsed);
    }

    if ((options.termination ?? 'end') !== 'stall') {
      timers.setTimeout(() => {
        if (options.termination === 'error') {
          response.emit('error', options.terminationError ?? new Error('fixture response terminated'));
        } else {
          response.emit('end');
        }
        currentRequest.emit('close');
      }, elapsed);
    }
  }, onAbort);

  return {
    request,
    response,
    netRequest: () => request,
  };
}

export function createFetchAdapter(
  options: HttpResponseFixtureOptions,
  timers: DeterministicTimers,
  calls: Array<{ url: string; init: RequestInit }> = [],
): SessionFetchAdapter {
  return async (_requestSession, url, init) => {
    calls.push({ url, init });
    timers.advanceBy(options.headersDelayMs ?? 0);
    const chunks = options.chunks ?? [];
    const headers = new Headers();

    for (const [name, value] of Object.entries(buildHeaders(options))) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }

    return {
      status: options.status ?? 200,
      statusText: options.statusText ?? 'OK',
      headers,
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buffers: Buffer[] = [];
        for (const chunk of chunks) {
          timers.advanceBy(chunk.delayMs ?? 0);
          buffers.push(toBuffer(chunk.data));
        }
        if (options.termination === 'error') {
          throw options.terminationError ?? new Error('fixture response terminated');
        }
        if (options.termination === 'stall') {
          return await new Promise<ArrayBuffer>(() => {});
        }
        const body = Buffer.concat(buffers);
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
      async json(): Promise<unknown> {
        const body = Buffer.from(await this.arrayBuffer()).toString('utf-8');
        return JSON.parse(body) as unknown;
      },
    };
  };
}

export class SafeTestFileSystem implements RequestFileSystemAdapter {
  private readonly files = new Map<string, Buffer>();

  constructor(readonly root: string) {}

  async readFile(filePath: string, encoding: BufferEncoding): Promise<string> {
    const content = this.files.get(this.assertOwned(filePath));
    if (!content) throw new Error('Test file does not exist');
    return content.toString(encoding);
  }

  async writeFile(filePath: string, data: string | Uint8Array): Promise<void> {
    this.files.set(this.assertOwned(filePath), Buffer.from(data));
  }

  async mkdir(directoryPath: string): Promise<void> {
    this.assertOwned(directoryPath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const source = this.assertOwned(oldPath);
    const destination = this.assertOwned(newPath);
    const content = this.files.get(source);
    if (!content) throw new Error('Test file does not exist');
    this.files.set(destination, content);
    this.files.delete(source);
  }

  async rm(filePath: string): Promise<void> {
    this.files.delete(this.assertOwned(filePath));
  }

  has(filePath: string): boolean {
    return this.files.has(this.assertOwned(filePath));
  }

  private assertOwned(filePath: string): string {
    const resolvedRoot = path.resolve(this.root);
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Test filesystem path escapes its owned temp root');
    }
    return resolvedPath;
  }
}

export function createTestRuntimeAdapters(options: {
  timers: DeterministicTimers;
  fetch: SessionFetchAdapter;
  netRequest: NetRequestAdapter;
  tempRoot?: string;
}): RequestRuntimeAdapters {
  const fileSystem = new SafeTestFileSystem(options.tempRoot ?? path.resolve('test-temp'));
  return {
    fetch: options.fetch,
    netRequest: options.netRequest,
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    fileSystem,
    clock: {
      monotonicNow: () => options.timers.now,
      wallNow: () => 1_700_000_000_000,
    },
    timers: options.timers,
    getTempRoot: () => fileSystem.root,
    emitProgress: () => {},
  };
}

function buildHeaders(options: HttpResponseFixtureOptions): Record<string, string | string[]> {
  const headers = { ...(options.headers ?? {}) };
  const bodyLength = Buffer.concat((options.chunks ?? []).map((chunk) => toBuffer(chunk.data))).byteLength;

  if (options.contentEncoding) headers['content-encoding'] = options.contentEncoding;
  if (options.contentLength === 'actual') headers['content-length'] = String(bodyLength);
  if (typeof options.contentLength === 'number') headers['content-length'] = String(options.contentLength);
  if (options.contentLength === 'missing') delete headers['content-length'];

  return headers;
}

function toBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
