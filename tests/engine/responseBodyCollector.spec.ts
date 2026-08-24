import { createHash } from 'crypto';
import { expect, test } from '@playwright/test';
import {
  collectResponseBody,
  type ResponseBodyDownloadRequest,
  type ResponseBodySink,
  type ResponseBodyCollectorTerminal,
} from '../../src/main/engine/responseBodyCollector';
import type { ResponseClassification } from '../../src/main/engine/responseClassifier';
import {
  RESPONSE_PREVIEW_MAX_BYTES,
  RESPONSE_TEXT_STAGING_MAX_BYTES,
} from '../../src/shared/responseLimits';
import { DeterministicTimers } from './fixtures/httpResponseFixture';

const IDLE_TIMEOUT_MS = 100;

const textClassification: ResponseClassification = {
  kind: 'text',
  mediaType: 'text/plain',
  format: 'text',
  declaredSize: undefined,
  suggestedFileName: 'response.txt',
  filters: [{ name: 'Text', extensions: ['txt'] }],
};

const rasterClassification: ResponseClassification = {
  kind: 'raster',
  mediaType: 'image/gif',
  declaredSize: undefined,
  suggestedFileName: 'response.gif',
  filters: [{ name: 'GIF', extensions: ['gif'] }],
};

const immediateClassification: ResponseClassification = {
  kind: 'download',
  reason: 'attachment',
  mediaType: 'application/octet-stream',
  declaredSize: 1,
  suggestedFileName: 'response.bin',
  filters: [{ name: 'All Files', extensions: ['*'] }],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function patternedBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (Math.imul(index, 31) + 17) & 0xff;
  }
  return bytes;
}

function validGif(length: number): Uint8Array {
  const bytes = patternedBytes(length);
  bytes.set(new TextEncoder().encode('GIF89a'));
  bytes.set([1, 0, 1, 0, 0, 0, 0], 6);
  bytes[bytes.byteLength - 1] = 0x3b;
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function randomizedChunks(bytes: Uint8Array, seed: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let state = seed >>> 0;
  let offset = 0;
  while (offset < bytes.byteLength) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const size = 1 + (state % 131_071);
    const end = Math.min(offset + size, bytes.byteLength);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

class HashingSink implements ResponseBodySink {
  readonly hash = createHash('sha256');
  writeCalls = 0;
  closeCalls = 0;
  abortCalls = 0;
  bytes = 0;

  async write(chunk: Uint8Array): Promise<void> {
    this.writeCalls += 1;
    this.bytes += chunk.byteLength;
    this.hash.update(chunk);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  completedDigest(): string {
    return this.hash.digest('hex');
  }
}

class TrackedSource implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  nextCalls = 0;
  returnCalls = 0;
  private index = 0;

  constructor(private readonly chunks: readonly Uint8Array[]) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    this.nextCalls += 1;
    const chunk = this.chunks[this.index];
    if (chunk === undefined) return { done: true, value: undefined };
    this.index += 1;
    return { done: false, value: chunk };
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    this.returnCalls += 1;
    return { done: true, value: undefined };
  }
}

class InstrumentedTimers extends DeterministicTimers {
  timeoutSets = 0;
  timeoutClears = 0;

  override setTimeout(callback: () => void, delayMs: number) {
    this.timeoutSets += 1;
    return super.setTimeout(callback, delayMs);
  }

  override clearTimeout(handle: ReturnType<DeterministicTimers['setTimeout']>): void {
    this.timeoutClears += 1;
    super.clearTimeout(handle);
  }
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test.describe('Transport-independent bounded response collector', () => {
  test('converts unknown-length text to download without losing its prefix', async () => {
    const payload = patternedBytes(RESPONSE_TEXT_STAGING_MAX_BYTES + 197_321);
    const source = new TrackedSource(randomizedChunks(payload, 0x5eed));
    const timers = new InstrumentedTimers();
    const destination = deferred<ResponseBodySink | null>();
    const sink = new HashingSink();
    const requests: ResponseBodyDownloadRequest[] = [];

    const collecting = collectResponseBody({
      source,
      classification: textClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      onDownload: async (request) => {
        requests.push(request);
        return destination.promise;
      },
    });

    while (requests.length === 0) await settleMicrotasks();
    const readsAtHandoff = source.nextCalls;

    expect(requests).toEqual([expect.objectContaining({
      trigger: 'threshold',
      reason: 'preview-limit',
      receivedBytes: RESPONSE_TEXT_STAGING_MAX_BYTES + 1,
    })]);
    expect(timers.pendingCount).toBe(0);
    await settleMicrotasks();
    expect(source.nextCalls).toBe(readsAtHandoff);

    destination.resolve(sink);
    const result = await collecting;

    expect(result.terminal).toEqual({ kind: 'completed' });
    expect(result.totalBytes).toBe(payload.byteLength);
    expect(result.previewBytes.byteLength).toBe(RESPONSE_PREVIEW_MAX_BYTES);
    expect(result.previewBytes).toEqual(payload.subarray(0, RESPONSE_PREVIEW_MAX_BYTES));
    expect(result.truncated).toBe(true);
    expect(result.download).toMatchObject({ trigger: 'threshold', reason: 'preview-limit' });
    expect(result.highWaterMark).toEqual({
      previewBytes: RESPONSE_PREVIEW_MAX_BYTES,
      stagedBytes: RESPONSE_TEXT_STAGING_MAX_BYTES,
    });
    expect(sink.bytes).toBe(payload.byteLength);
    expect(sink.completedDigest()).toBe(digest(payload));
    expect(sink.closeCalls).toBe(1);
    expect(sink.abortCalls).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });

  test('enforces text and raster thresholds across exact one-byte and randomized boundaries', async () => {
    const cases: Array<{
      name: string;
      classification: ResponseClassification;
      payload: Uint8Array;
      layouts: Uint8Array[][];
      downloads: boolean;
      threshold: number;
    }> = [];

    for (const [name, classification, limit, validExact] of [
      ['text', { ...textClassification, declaredSize: 1 }, RESPONSE_TEXT_STAGING_MAX_BYTES, false],
      ['raster', rasterClassification, RESPONSE_PREVIEW_MAX_BYTES, true],
    ] as const) {
      const exact = validExact ? validGif(limit) : patternedBytes(limit);
      const over = patternedBytes(limit + 1);
      cases.push({
        name: `${name} exact`,
        classification,
        payload: exact,
        layouts: [
          [exact],
          [exact.subarray(0, limit - 1), exact.subarray(limit - 1)],
          randomizedChunks(exact, 0x1234),
        ],
        downloads: false,
        threshold: limit + 1,
      });
      cases.push({
        name: `${name} over`,
        classification,
        payload: over,
        layouts: [
          [over],
          [over.subarray(0, limit), over.subarray(limit)],
          randomizedChunks(over, 0xabcd),
        ],
        downloads: true,
        threshold: limit + 1,
      });
    }

    for (const boundaryCase of cases) {
      for (const chunks of boundaryCase.layouts) {
        const requests: ResponseBodyDownloadRequest[] = [];
        const sink = new HashingSink();
        const result = await collectResponseBody({
          source: new TrackedSource(chunks),
          classification: boundaryCase.classification,
          idleTimeoutMs: 0,
          timers: new DeterministicTimers(),
          onDownload: async (request) => {
            requests.push(request);
            return sink;
          },
        });

        expect(requests.length, boundaryCase.name).toBe(boundaryCase.downloads ? 1 : 0);
        if (boundaryCase.downloads) {
          expect(requests[0].receivedBytes, boundaryCase.name).toBe(boundaryCase.threshold);
          expect(sink.completedDigest(), boundaryCase.name).toBe(digest(boundaryCase.payload));
        }
        expect(result.totalBytes, boundaryCase.name).toBe(boundaryCase.payload.byteLength);
        expect(result.previewBytes.byteLength, boundaryCase.name).toBe(
          Math.min(boundaryCase.payload.byteLength, RESPONSE_PREVIEW_MAX_BYTES),
        );
        expect(result.highWaterMark.previewBytes, boundaryCase.name).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
        expect(result.highWaterMark.stagedBytes, boundaryCase.name).toBeLessThanOrEqual(RESPONSE_TEXT_STAGING_MAX_BYTES);
      }
    }
  });

  test('opens immediate downloads after reading the first chunk and honors sink backpressure', async () => {
    const firstWrite = deferred<void>();
    const destination = deferred<ResponseBodySink | null>();
    const source = new TrackedSource([patternedBytes(8), patternedBytes(13)]);
    const timers = new DeterministicTimers();
    let writes = 0;
    const sink: ResponseBodySink = {
      async write(): Promise<void> {
        writes += 1;
        if (writes === 1) await firstWrite.promise;
      },
      async close(): Promise<void> {},
      async abort(): Promise<void> {},
    };

    const collecting = collectResponseBody({
      source,
      classification: immediateClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      onDownload: async (request) => {
        expect(request).toMatchObject({ trigger: 'immediate', receivedBytes: 8, reason: 'attachment' });
        expect(source.nextCalls).toBe(1);
        expect(timers.pendingCount).toBe(0);
        return destination.promise;
      },
    });

    await settleMicrotasks();
    expect(source.nextCalls).toBe(1);
    destination.resolve(sink);
    while (writes === 0) await settleMicrotasks();
    expect(source.nextCalls).toBe(1);
    await settleMicrotasks();
    expect(source.nextCalls).toBe(1);

    firstWrite.resolve();
    const result = await collecting;
    expect(result.totalBytes).toBe(21);
    expect(source.nextCalls).toBe(3);
    expect(timers.pendingCount).toBe(0);
  });

  test('cancels once while awaiting destination and aborts a late sink without writing', async () => {
    const controller = new AbortController();
    const destination = deferred<ResponseBodySink | null>();
    const source = new TrackedSource([patternedBytes(32)]);
    const sink = new HashingSink();
    const timers = new DeterministicTimers();
    const terminals: ResponseBodyCollectorTerminal[] = [];
    const progress: number[] = [];
    let downloadCalls = 0;

    const collecting = collectResponseBody({
      source,
      classification: immediateClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      signal: controller.signal,
      onDownload: async () => {
        downloadCalls += 1;
        return destination.promise;
      },
      onProgress: (receivedBytes) => progress.push(receivedBytes),
      onTerminal: (terminal) => terminals.push(terminal),
    });

    while (downloadCalls === 0) await settleMicrotasks();
    expect(source.nextCalls).toBe(1);
    expect(timers.pendingCount).toBe(0);

    controller.abort();
    const result = await collecting;
    expect(result.terminal).toEqual({ kind: 'cancelled' });
    expect(terminals).toEqual([result.terminal]);
    expect(source.nextCalls).toBe(1);
    expect(source.returnCalls).toBe(1);
    expect(timers.pendingCount).toBe(0);
    expect(progress).toEqual([32]);

    destination.resolve(sink);
    await settleMicrotasks();
    expect(sink.abortCalls).toBe(1);
    expect(sink.closeCalls).toBe(0);
    expect(sink.writeCalls).toBe(0);

    controller.abort();
    timers.runAll();
    await settleMicrotasks();
    expect(terminals).toHaveLength(1);
    expect(progress).toEqual([32]);
    expect(source.nextCalls).toBe(1);
    expect(sink.abortCalls).toBe(1);
  });

  test('completes zero-byte downloads without opening a destination', async () => {
    const timers = new DeterministicTimers();
    const terminals: ResponseBodyCollectorTerminal[] = [];
    let downloadCalls = 0;

    const result = await collectResponseBody({
      source: new TrackedSource([]),
      classification: immediateClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      onDownload: async () => {
        downloadCalls += 1;
        return null;
      },
      onTerminal: (terminal) => terminals.push(terminal),
    });

    expect(downloadCalls).toBe(0);
    expect(result.terminal).toEqual({ kind: 'completed' });
    expect(terminals).toEqual([result.terminal]);
    expect(result.totalBytes).toBe(0);
    expect(result.previewBytes.byteLength).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.download).toBeUndefined();
    expect(timers.pendingCount).toBe(0);
  });

  test('falls back from an invalid complete raster using captured bytes without replay', async () => {
    const payload = patternedBytes(4_097);
    const source = new TrackedSource([payload]);
    const sink = new HashingSink();
    const requests: ResponseBodyDownloadRequest[] = [];

    const result = await collectResponseBody({
      source,
      classification: rasterClassification,
      idleTimeoutMs: 0,
      timers: new DeterministicTimers(),
      onDownload: async (request) => {
        requests.push(request);
        return sink;
      },
    });

    expect(requests).toEqual([expect.objectContaining({
      trigger: 'invalid-raster',
      reason: 'invalid-image',
      receivedBytes: payload.byteLength,
    })]);
    expect(source.nextCalls).toBe(2);
    expect(source.returnCalls).toBe(0);
    expect(result.totalBytes).toBe(payload.byteLength);
    expect(result.previewBytes).toEqual(payload);
    expect(sink.bytes).toBe(payload.byteLength);
    expect(sink.completedDigest()).toBe(digest(payload));
  });

  test('resets idle timing only for delivered bytes and emits unthrottled progress', async () => {
    const timers = new InstrumentedTimers();
    const progress: number[] = [];
    const result = await collectResponseBody({
      source: new TrackedSource([
        new Uint8Array(),
        Uint8Array.of(1),
        new Uint8Array(),
        Uint8Array.of(2, 3),
      ]),
      classification: textClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      onDownload: async () => null,
      onProgress: (receivedBytes) => progress.push(receivedBytes),
    });

    expect(result.terminal).toEqual({ kind: 'completed' });
    expect(result.totalBytes).toBe(3);
    expect(progress).toEqual([1, 3]);
    expect(timers.timeoutSets).toBe(3);
    expect(timers.pendingCount).toBe(0);
  });

  test('settles body idle timeout and cancellation exactly once', async () => {
    for (const winner of ['timeout', 'cancel'] as const) {
      const timers = new DeterministicTimers();
      const controller = new AbortController();
      const sourceReturn = deferred<IteratorResult<Uint8Array>>();
      let nextCalls = 0;
      let returnCalls = 0;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              nextCalls += 1;
              return new Promise<IteratorResult<Uint8Array>>(() => {});
            },
            return: async () => {
              returnCalls += 1;
              sourceReturn.resolve({ done: true, value: undefined });
              return sourceReturn.promise;
            },
          };
        },
      };
      const terminals: ResponseBodyCollectorTerminal[] = [];
      const progress: number[] = [];
      const collecting = collectResponseBody({
        source,
        classification: textClassification,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        timers,
        signal: controller.signal,
        onDownload: async () => null,
        onProgress: (receivedBytes) => progress.push(receivedBytes),
        onTerminal: (terminal) => terminals.push(terminal),
      });

      await settleMicrotasks();
      expect(nextCalls).toBe(1);
      if (winner === 'timeout') {
        timers.advanceBy(IDLE_TIMEOUT_MS);
        controller.abort();
      } else {
        controller.abort();
        timers.advanceBy(IDLE_TIMEOUT_MS);
      }

      const result = await collecting;
      expect(result.terminal.kind).toBe(winner === 'timeout' ? 'failed' : 'cancelled');
      if (winner === 'timeout' && result.terminal.kind === 'failed') {
        expect(result.terminal.reason).toBe('idle-timeout');
      }
      expect(terminals).toEqual([result.terminal]);
      expect(returnCalls).toBe(1);
      expect(timers.pendingCount).toBe(0);

      controller.abort();
      timers.runAll();
      await settleMicrotasks();
      expect(terminals).toHaveLength(1);
      expect(progress).toEqual([]);
    }
  });

  test('settles source read sink write and sink close failures once', async () => {
    const sourceFailure = new Error('source failed');
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw sourceFailure; },
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    const sourceTerminals: ResponseBodyCollectorTerminal[] = [];
    const sourceResult = await collectResponseBody({
      source,
      classification: textClassification,
      idleTimeoutMs: 0,
      timers: new DeterministicTimers(),
      onDownload: async () => null,
      onTerminal: (terminal) => sourceTerminals.push(terminal),
    });
    expect(sourceResult.terminal).toMatchObject({ kind: 'failed', reason: 'source-read', error: sourceFailure });
    expect(sourceTerminals).toEqual([sourceResult.terminal]);

    for (const failureAt of ['write', 'close'] as const) {
      const failure = new Error(`${failureAt} failed`);
      let abortCalls = 0;
      const terminals: ResponseBodyCollectorTerminal[] = [];
      const sink: ResponseBodySink = {
        async write(): Promise<void> {
          if (failureAt === 'write') throw failure;
        },
        async close(): Promise<void> {
          if (failureAt === 'close') throw failure;
        },
        async abort(): Promise<void> {
          abortCalls += 1;
        },
      };
      const result = await collectResponseBody({
        source: new TrackedSource([Uint8Array.of(1, 2, 3)]),
        classification: immediateClassification,
        idleTimeoutMs: 0,
        timers: new DeterministicTimers(),
        onDownload: async () => sink,
        onTerminal: (terminal) => terminals.push(terminal),
      });

      expect(result.terminal).toMatchObject({
        kind: 'failed',
        reason: failureAt === 'write' ? 'sink-write' : 'sink-close',
        error: failure,
      });
      expect(terminals).toEqual([result.terminal]);
      expect(abortCalls).toBe(1);
    }
  });

  test('lets idle timeout win a pending sink close and suppresses late settlement', async () => {
    const close = deferred<void>();
    const closeStarted = deferred<void>();
    const timers = new DeterministicTimers();
    const terminals: ResponseBodyCollectorTerminal[] = [];
    let abortCalls = 0;
    const sink: ResponseBodySink = {
      async write(): Promise<void> {},
      async close(): Promise<void> { closeStarted.resolve(); return close.promise; },
      async abort(): Promise<void> { abortCalls += 1; },
    };
    const collecting = collectResponseBody({
      source: new TrackedSource([Uint8Array.of(1)]),
      classification: immediateClassification,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      timers,
      onDownload: async () => sink,
      onTerminal: (terminal) => terminals.push(terminal),
    });

    // Under deferred-download semantics the sink is only acquired once the first
    // chunk has been read, so wait until close() is actually invoked (i.e. the
    // collector is awaiting a pending close) before firing the idle timeout.
    await closeStarted.promise;
    while (timers.pendingCount === 0) await settleMicrotasks();
    timers.advanceBy(IDLE_TIMEOUT_MS);
    const result = await collecting;
    expect(result.terminal).toMatchObject({ kind: 'failed', reason: 'idle-timeout' });
    expect(abortCalls).toBe(1);
    expect(terminals).toEqual([result.terminal]);

    close.resolve();
    await settleMicrotasks();
    expect(terminals).toHaveLength(1);
  });
});
