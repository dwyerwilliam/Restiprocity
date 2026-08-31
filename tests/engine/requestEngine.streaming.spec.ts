import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, test as base } from '@playwright/test';
import type { Session } from 'electron';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { RequestFailureError } from '../../src/main/engine/requestErrors';
import type { ResponseDownloadFileSystemAdapter } from '../../src/main/engine/responseDownloadCoordinator';
import type {
  RequestRuntimeAdapters,
  RuntimeFetchResponse,
  SessionFetchAdapter,
} from '../../src/main/engine/requestRuntimeAdapters';
import { RESPONSE_PREVIEW_MAX_BYTES, RESPONSE_TEXT_STAGING_MAX_BYTES } from '../../src/shared/responseLimits';
import type { Request, ResponseV2 } from '../../src/shared/types';
import {
  createFetchAdapter,
  createNetResponseFixture,
  createTestRuntimeAdapters,
  DeterministicTimers,
  FakeClientRequest,
  FakeIncomingMessage,
} from './fixtures/httpResponseFixture';

const collectionStore = {
  getActiveEnvironmentId: () => null,
  getEnvironment: async () => null,
};

const test = base.extend<{ tempDirectory: string }>({
  tempDirectory: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-engine-stream-'));
    try {
      await use(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
});

interface StreamingFetchOptions {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  chunks?: readonly Uint8Array[];
  headerPending?: boolean;
  bodyStallsAfter?: number;
  bodyError?: Error;
  finalUrl?: string;
  onCancel?: () => void;
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  const now = 1_700_000_000_000;
  return {
    id: 'request-streaming',
    name: 'Streaming response',
    method: 'GET',
    url: 'https://api.example.test/final.txt',
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 100, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function patternedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (Math.imul(index, 31) + 17) & 0xff;
  return bytes;
}

function chunkBytes(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.byteLength) break;
    const end = Math.min(offset + size, bytes.byteLength);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (offset < bytes.byteLength) chunks.push(bytes.subarray(offset));
  return chunks;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createSession(fetch: SessionFetchAdapter): Session {
  return {
    fetch: (url: string, init?: RequestInit) => fetch({} as Session, url, init ?? {}),
    allowNTLMCredentialsForDomains: () => {},
  } as unknown as Session;
}

function createEngine(
  runtime: RequestRuntimeAdapters,
  fileSystem?: ResponseDownloadFileSystemAdapter,
): RequestEngine {
  return new RequestEngine(createSession(runtime.fetch), collectionStore, runtime, fileSystem ? {
    fileSystem,
    logger: { error: () => {} },
  } : {});
}

function streamingFetch(options: StreamingFetchOptions): SessionFetchAdapter {
  return async (_requestSession, _url, init) => {
    if (options.headerPending) {
      return await new Promise<RuntimeFetchResponse>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }

    const chunks = options.chunks ?? [];
    let index = 0;
    const body = {
      getReader() {
        return {
          async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
            if (options.bodyStallsAfter !== undefined && index >= options.bodyStallsAfter) {
              return await new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            }
            if (index < chunks.length) return { done: false, value: chunks[index++] };
            if (options.bodyError) throw options.bodyError;
            return { done: true, value: undefined };
          },
          async cancel(): Promise<void> { options.onCancel?.(); },
          releaseLock(): void {},
        };
      },
    };
    const headers = new Headers(options.headers);
    return {
      status: options.status ?? 200,
      statusText: options.statusText ?? 'OK',
      headers,
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      body,
      url: options.finalUrl ?? 'https://api.example.test/final.txt',
      async arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error('executeV2 must not call arrayBuffer');
      },
      async json(): Promise<unknown> {
        throw new Error('executeV2 must not call json');
      },
    } as RuntimeFetchResponse & {
      body: typeof body;
      url: string;
    };
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1_000 && !predicate(); attempts += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

async function advanceNetChunks(timers: DeterministicTimers, chunkCount: number): Promise<void> {
  timers.runReady();
  for (let index = 0; index < chunkCount; index += 1) {
    timers.advanceBy(1);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  }
}

async function captureFailure(promise: Promise<unknown>): Promise<RequestFailureError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RequestFailureError) return error;
    throw error;
  }
  throw new Error('Expected request execution to fail');
}

function responseMetadata(response: ResponseV2) {
  return {
    status: response.status,
    statusText: response.statusText,
    preview: response.preview,
    size: response.size,
    declaredSize: response.declaredSize,
    download: response.download,
  };
}

test.describe('RequestEngine V2 streaming transports', () => {
  test('streams equivalent false-length downloads through fetch and net', async ({ tempDirectory }) => {
    const payload = patternedBytes(RESPONSE_TEXT_STAGING_MAX_BYTES + 1);
    const chunks = chunkBytes(payload, [13, RESPONSE_PREVIEW_MAX_BYTES - 13, 777_777, 2_000_000]);
    const expectedHash = sha256(payload);

    const fetchDestination = path.join(tempDirectory, 'fetch.txt');
    const fetchTimers = new DeterministicTimers();
    const fetchProgress: number[] = [];
    const fetchRuntime = {
      ...createTestRuntimeAdapters({
        timers: fetchTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'text/plain', 'content-length': '7' },
          chunks,
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      showSaveDialog: async () => ({ canceled: false, filePath: fetchDestination }),
      emitProgress: (event) => fetchProgress.push(event.receivedBytes),
    } satisfies RequestRuntimeAdapters;
    const fetchResponse = await createEngine(fetchRuntime).executeV2({ request: makeRequest() });

    const netDestination = path.join(tempDirectory, 'net.txt');
    const netTimers = new DeterministicTimers();
    const netFixture = createNetResponseFixture({
      headers: { 'content-type': 'text/plain' },
      contentLength: 7,
      chunks: chunks.map((data) => ({ data: Buffer.from(data), delayMs: 1 })),
    }, netTimers);
    const netProgress: number[] = [];
    const netRuntime = {
      ...createTestRuntimeAdapters({
        timers: netTimers,
        fetch: createFetchAdapter({}, netTimers),
        netRequest: netFixture.netRequest,
      }),
      showSaveDialog: async () => ({ canceled: false, filePath: netDestination }),
      emitProgress: (event) => netProgress.push(event.receivedBytes),
    } satisfies RequestRuntimeAdapters;
    const netExecution = createEngine(netRuntime).executeV2({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    await waitFor(() => netFixture.request.ended);
    await advanceNetChunks(netTimers, chunks.length);
    const netResponse = await netExecution;

    expect(responseMetadata(fetchResponse)).toEqual(responseMetadata(netResponse));
    expect(fetchResponse.preview).toMatchObject({
      kind: 'text',
      capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
      totalBytes: payload.byteLength,
      truncated: true,
    });
    expect(fetchResponse.download).toMatchObject({
      state: 'saved',
      reason: 'preview-limit',
      receivedBytes: payload.byteLength,
      declaredSize: 7,
    });
    expect(sha256(await fs.readFile(fetchDestination))).toBe(expectedHash);
    expect(sha256(await fs.readFile(netDestination))).toBe(expectedHash);
    expect(fetchProgress).toContain(RESPONSE_TEXT_STAGING_MAX_BYTES + 1);
    expect(netProgress).toContain(RESPONSE_TEXT_STAGING_MAX_BYTES + 1);
    expect(fetchTimers.pendingCount).toBe(0);
    expect(netTimers.pendingCount).toBe(0);
  });

  test('separates transport header deadline from collector body idle timeout', async ({ tempDirectory }) => {
    const headerTimers = new DeterministicTimers();
    const headerEngine = createEngine(createTestRuntimeAdapters({
      timers: headerTimers,
      fetch: streamingFetch({ headerPending: true }),
      netRequest: () => new FakeClientRequest(),
    }));
    const headerExecution = headerEngine.executeV2({ request: makeRequest() });
    await waitFor(() => headerTimers.pendingCount === 1);
    headerTimers.advanceBy(100);
    expect((await captureFailure(headerExecution)).requestError).toMatchObject({ kind: 'timeout' });
    expect(headerTimers.pendingCount).toBe(0);

    const bodyTimers = new DeterministicTimers();
    const received: number[] = [];
    const bodyRuntime = {
      ...createTestRuntimeAdapters({
        timers: bodyTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'text/plain' },
          chunks: [Buffer.from('progress')],
          bodyStallsAfter: 1,
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      emitProgress: (event) => received.push(event.receivedBytes),
    } satisfies RequestRuntimeAdapters;
    const bodyExecution = createEngine(bodyRuntime).executeV2({ request: makeRequest() });
    await waitFor(() => received.length === 1);
    bodyTimers.advanceBy(99);
    expect(received).toEqual([8]);
    bodyTimers.advanceBy(1);
    expect((await captureFailure(bodyExecution)).requestError).toMatchObject({ kind: 'timeout' });
    expect(bodyTimers.pendingCount).toBe(0);

    let resolveDialog!: (value: { canceled: false; filePath: string }) => void;
    const dialog = new Promise<{ canceled: false; filePath: string }>((resolve) => { resolveDialog = resolve; });
    const dialogTimers = new DeterministicTimers();
    const phases: string[] = [];
    const dialogRuntime = {
      ...createTestRuntimeAdapters({
        timers: dialogTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'application/octet-stream' },
          chunks: [Buffer.from('seed')],
          bodyStallsAfter: 1,
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      showSaveDialog: async () => dialog,
      emitProgress: (event) => phases.push(event.phase),
    } satisfies RequestRuntimeAdapters;
    const dialogExecution = createEngine(dialogRuntime).executeV2({ request: makeRequest() });
    await waitFor(() => phases.includes('awaiting-destination'));
    dialogTimers.advanceBy(1_000);
    let dialogSettlements = 0;
    void dialogExecution.then(
      () => { dialogSettlements += 1; },
      () => { dialogSettlements += 1; },
    );
    await Promise.resolve();
    expect(dialogSettlements).toBe(0);
    resolveDialog({ canceled: false, filePath: path.join(tempDirectory, 'idle.bin') });
    await waitFor(() => phases.includes('downloading'));
    dialogTimers.advanceBy(99);
    expect(dialogSettlements).toBe(0);
    dialogTimers.advanceBy(1);
    expect((await captureFailure(dialogExecution)).requestError).toMatchObject({ kind: 'timeout' });
    expect(dialogTimers.pendingCount).toBe(0);
  });

  test('preserves delivered entity bytes for identity gzip and Brotli streams', async () => {
    const delivered = Buffer.from('delivered entity bytes');
    for (const encoding of ['identity', 'gzip', 'br']) {
      const fetchTimers = new DeterministicTimers();
      const fetchResponse = await createEngine(createTestRuntimeAdapters({
        timers: fetchTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'text/plain', 'content-encoding': encoding },
          chunks: [delivered.subarray(0, 5), delivered.subarray(5)],
        }),
        netRequest: () => new FakeClientRequest(),
      })).executeV2({ request: makeRequest() });

      const netTimers = new DeterministicTimers();
      const fixture = createNetResponseFixture({
        headers: { 'content-type': 'text/plain' },
        contentEncoding: encoding,
        chunks: [{ data: delivered.subarray(0, 5), delayMs: 1 }, { data: delivered.subarray(5), delayMs: 1 }],
      }, netTimers);
      const netExecution = createEngine(createTestRuntimeAdapters({
        timers: netTimers,
        fetch: createFetchAdapter({}, netTimers),
        netRequest: fixture.netRequest,
      })).executeV2({
        request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
      });
      await waitFor(() => fixture.request.ended);
      await advanceNetChunks(netTimers, 2);
      const netResponse = await netExecution;

      expect(responseMetadata(fetchResponse)).toEqual(responseMetadata(netResponse));
      expect(fetchResponse.preview).toMatchObject({ kind: 'text', text: delivered.toString(), totalBytes: delivered.byteLength });
      expect(fetchResponse.size).toBe(delivered.byteLength);
    }
  });

  test('settles cancellation and fetch or net stream errors exactly once', async () => {
    const cancellationTimers = new DeterministicTimers();
    const cancellationProgress: number[] = [];
    const cancellationRuntime = {
      ...createTestRuntimeAdapters({
        timers: cancellationTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'text/plain' },
          chunks: [Buffer.from('prefix')],
          bodyStallsAfter: 1,
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      emitProgress: (event) => cancellationProgress.push(event.receivedBytes),
    } satisfies RequestRuntimeAdapters;
    const cancellationEngine = createEngine(cancellationRuntime);
    let cancellationSettlements = 0;
    const cancellation = cancellationEngine.executeV2({ request: makeRequest() });
    void cancellation.then(
      () => { cancellationSettlements += 1; },
      () => { cancellationSettlements += 1; },
    );
    await waitFor(() => cancellationProgress.length === 1);
    cancellationEngine.cancel();
    expect((await captureFailure(cancellation)).requestError).toMatchObject({ kind: 'cancelled' });
    expect(cancellationSettlements).toBe(1);
    expect(cancellationTimers.pendingCount).toBe(0);

    const fetchTimers = new DeterministicTimers();
    const fetchError = createEngine(createTestRuntimeAdapters({
      timers: fetchTimers,
      fetch: streamingFetch({
        headers: { 'content-type': 'text/plain' },
        chunks: [Buffer.from('prefix')],
        bodyError: new Error('fetch body failed'),
      }),
      netRequest: () => new FakeClientRequest(),
    })).executeV2({ request: makeRequest() });
    expect((await captureFailure(fetchError)).requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'fetch body failed',
    });

    const netTimers = new DeterministicTimers();
    const fixture = createNetResponseFixture({
      headers: { 'content-type': 'text/plain' },
      chunks: [{ data: 'prefix' }],
      termination: 'error',
      terminationError: new Error('net body failed'),
    }, netTimers);
    const engine = createEngine(createTestRuntimeAdapters({
      timers: netTimers,
      fetch: createFetchAdapter({}, netTimers),
      netRequest: fixture.netRequest,
    }));
    let settlements = 0;
    const netExecution = engine.executeV2({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    void netExecution.then(() => { settlements += 1; }, () => { settlements += 1; });
    await waitFor(() => fixture.request.ended);
    netTimers.runReady();
    expect((await captureFailure(netExecution)).requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'net body failed',
    });
    fixture.response.emit('data', Buffer.from('late'));
    fixture.response.emit('end');
    await Promise.resolve();
    expect(settlements).toBe(1);
    expect(netTimers.pendingCount).toBe(0);

    const nativeTimers = new DeterministicTimers();
    const nativeError = Object.assign(new Error('NTLM native stream failure'), { code: 'ERR_FAILED' });
    let nativeRequest!: FakeClientRequest;
    nativeRequest = new FakeClientRequest(() => {}, () => {
      nativeTimers.setImmediate(() => nativeRequest.emit('error', nativeError));
    });
    const nativeExecution = createEngine(createTestRuntimeAdapters({
      timers: nativeTimers,
      fetch: createFetchAdapter({}, nativeTimers),
      netRequest: () => nativeRequest,
    })).executeV2({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    await waitFor(() => nativeRequest.ended);
    expect(nativeTimers.pendingCount).toBeGreaterThan(0);
    nativeTimers.advanceBy(100);
    expect((await captureFailure(nativeExecution)).requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'NTLM native stream failure',
      code: 'ERR_FAILED',
    });
    expect(nativeRequest.abortCalls).toBe(1);
    expect(nativeTimers.pendingCount).toBe(0);

    const writeTimers = new DeterministicTimers();
    const writeFileSystem: ResponseDownloadFileSystemAdapter = {
      openExclusive: async () => ({
        write: async () => { throw Object.assign(new Error('injected disk failure'), { code: 'EIO' }); },
        sync: async () => {},
        close: async () => {},
      }),
      pathExists: async () => false,
      rename: async () => {},
      rm: async () => {},
    };
    const writeRuntime = {
      ...createTestRuntimeAdapters({
        timers: writeTimers,
        fetch: streamingFetch({
          headers: { 'content-type': 'application/octet-stream' },
          chunks: [Buffer.from('download bytes')],
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      showSaveDialog: async () => ({ canceled: false, filePath: 'C:/deterministic/response.bin' }),
    } satisfies RequestRuntimeAdapters;
    const writeResponse = await createEngine(writeRuntime, writeFileSystem).executeV2({ request: makeRequest() });
    expect(writeResponse.download).toMatchObject({
      state: 'failed',
      receivedBytes: 0,
      failure: { code: 'io-error' },
    });
    expect(writeResponse.size).toBe(Buffer.byteLength('download bytes'));
    expect(writeTimers.pendingCount).toBe(0);
  });

  test('fails aborted and premature close net bodies without waiting for idle timeout', async () => {
    for (const terminal of ['aborted', 'close'] as const) {
      const timers = new DeterministicTimers();
      const fixture = createNetResponseFixture({
        headers: { 'content-type': 'text/plain' },
        chunks: [{ data: 'prefix' }],
        termination: 'stall',
      }, timers);
      const engine = createEngine(createTestRuntimeAdapters({
        timers,
        fetch: createFetchAdapter({}, timers),
        netRequest: fixture.netRequest,
      }));
      let settlements = 0;
      const execution = engine.executeV2({
        request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
      });
      void execution.then(() => { settlements += 1; }, () => { settlements += 1; });
      await waitFor(() => fixture.request.ended);
      timers.runReady();
      await waitFor(() => fixture.response.listenerCount('data') === 1);
      fixture.response.emit(terminal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (timers.pendingCount > 0) timers.advanceBy(100);

      const failure = await captureFailure(execution);
      expect(failure.requestError).toMatchObject({
        kind: 'transport',
        rawMessage: terminal === 'aborted'
          ? 'Response body terminated by remote peer before completion'
          : 'Response body closed before completion',
      });
      fixture.response.emit('data', Buffer.from('late'));
      fixture.response.emit('end');
      await Promise.resolve();
      expect(settlements).toBe(1);
      expect(fixture.request.abortCalls).toBe(1);
      for (const eventName of ['data', 'error', 'end', 'aborted', 'close']) {
        expect(fixture.response.listenerCount(eventName), `${terminal}: ${eventName}`).toBe(0);
      }
      expect(timers.pendingCount).toBe(0);
    }
  });

  test('cancels unread fetch bodies for bodyless final responses', async () => {
    const timers = new DeterministicTimers();
    let cancelCalls = 0;
    const response = await createEngine(createTestRuntimeAdapters({
      timers,
      fetch: streamingFetch({
        status: 204,
        headers: { 'content-type': 'text/plain' },
        chunks: [Buffer.from('must not be read')],
        onCancel: () => { cancelCalls += 1; },
      }),
      netRequest: () => new FakeClientRequest(),
    })).executeV2({ request: makeRequest() });

    expect(response.preview).toEqual({
      kind: 'empty',
      capturedBytes: 0,
      totalBytes: 0,
      truncated: false,
      completeness: 'complete',
    });
    expect(cancelCalls).toBe(1);
    expect(timers.pendingCount).toBe(0);
  });

  test('renders small error bodies as text when the content type is missing (issue #3)', async () => {
    const timers = new DeterministicTimers();
    const response = await createEngine(createTestRuntimeAdapters({
      timers,
      fetch: streamingFetch({
        status: 404,
        statusText: 'Not Found',
        headers: {},
        chunks: [Buffer.from('Not Found')],
      }),
      netRequest: () => new FakeClientRequest(),
    })).executeV2({ request: makeRequest() });

    expect(response.preview).toMatchObject({
      kind: 'text',
      format: 'text',
      text: 'Not Found',
      decodeError: false,
      totalBytes: 9,
    });
    expect(response.download).toBeUndefined();
    expect(timers.pendingCount).toBe(0);
  });

  test('keeps the download flow for binary-typed error bodies (issue #3)', async ({ tempDirectory }) => {
    const timers = new DeterministicTimers();
    const destination = path.join(tempDirectory, 'error-body.bin');
    const binary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
    const response = await createEngine({
      ...createTestRuntimeAdapters({
        timers,
        fetch: streamingFetch({
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/octet-stream' },
          chunks: [binary],
        }),
        netRequest: () => new FakeClientRequest(),
      }),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    }).executeV2({ request: makeRequest() });

    expect(response.preview).toMatchObject({
      kind: 'download-only',
      mediaType: 'application/octet-stream',
    });
    expect(response.download).toMatchObject({ state: 'saved', reason: 'unsupported-media-type' });
    expect(timers.pendingCount).toBe(0);
  });

  test('bodyless error responses preview as empty so the viewer shows the inline status message (issue #3)', async () => {
    const timers = new DeterministicTimers();
    const response = await createEngine(createTestRuntimeAdapters({
      timers,
      fetch: streamingFetch({
        status: 404,
        statusText: 'Not Found',
        headers: {},
        chunks: [],
      }),
      netRequest: () => new FakeClientRequest(),
    })).executeV2({ request: makeRequest() });

    expect(response.preview).toEqual({
      kind: 'empty',
      capturedBytes: 0,
      totalBytes: 0,
      truncated: false,
      completeness: 'complete',
    });
    expect(response.download).toBeUndefined();
    expect(timers.pendingCount).toBe(0);
  });

  test('paces net chunks through pause and resume without overwriting queued bytes', async () => {
    const timers = new DeterministicTimers();
    const chunks = [Buffer.from('first-'), Buffer.from('second-'), Buffer.from('third')];
    const response = new FakeIncomingMessage({ headers: { 'content-type': 'text/plain' } }) as FakeIncomingMessage & {
      pause(): void;
      resume(): void;
    };
    let index = 0;
    let pauseCalls = 0;
    let resumeCalls = 0;
    response.pause = () => { pauseCalls += 1; };
    response.resume = () => {
      resumeCalls += 1;
      const chunk = chunks[index++];
      queueMicrotask(() => {
        if (chunk) response.emit('data', chunk);
        else {
          response.emit('end');
          request.emit('close');
        }
      });
    };
    const request = new FakeClientRequest(() => request.emit('response', response));
    const execution = createEngine(createTestRuntimeAdapters({
      timers,
      fetch: createFetchAdapter({}, timers),
      netRequest: () => request,
    })).executeV2({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    const result = await execution;

    expect(result.preview).toMatchObject({ kind: 'text', text: 'first-second-third', totalBytes: 18 });
    expect(result.size).toBe(18);
    expect(pauseCalls).toBeGreaterThanOrEqual(chunks.length);
    expect(resumeCalls).toBe(chunks.length + 1);
    expect(timers.pendingCount).toBe(0);
  });
});
