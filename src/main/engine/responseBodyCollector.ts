import {
  RESPONSE_PREVIEW_MAX_BYTES,
  RESPONSE_TEXT_STAGING_MAX_BYTES,
} from '@shared/responseLimits';
import type { DownloadReasonV2 } from '@shared/types';
import type { RequestTimerAdapter, RequestTimerHandle } from './requestRuntimeAdapters';
import type { ResponseClassification } from './responseClassifier';
import { validateRasterPreview, type RasterMediaType } from './responsePreview';

export interface ResponseBodySink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): Promise<void>;
}

export type ResponseBodyDownloadTrigger = 'immediate' | 'threshold' | 'invalid-raster';

export interface ResponseBodyDownloadRequest {
  readonly trigger: ResponseBodyDownloadTrigger;
  readonly reason: DownloadReasonV2;
  readonly receivedBytes: number;
  readonly declaredSize: number | undefined;
  readonly mediaType: string | null;
  readonly suggestedFileName: string;
}

export type ResponseBodyCollectorFailureReason =
  | 'idle-timeout'
  | 'source-read'
  | 'destination'
  | 'sink-write'
  | 'sink-close';

export type ResponseBodyCollectorTerminal =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed';
      readonly reason: ResponseBodyCollectorFailureReason;
      readonly error: Error;
    };

export interface ResponseBodyCollectorHighWaterMark {
  readonly previewBytes: number;
  readonly stagedBytes: number;
}

export interface ResponseBodyCollectorResult {
  readonly terminal: ResponseBodyCollectorTerminal;
  readonly totalBytes: number;
  readonly previewBytes: Uint8Array;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly download?: ResponseBodyDownloadRequest;
  readonly highWaterMark: ResponseBodyCollectorHighWaterMark;
}

export interface CollectResponseBodyOptions {
  readonly source: AsyncIterable<Uint8Array>;
  readonly classification: ResponseClassification;
  readonly idleTimeoutMs: number;
  readonly timers: RequestTimerAdapter;
  readonly signal?: AbortSignal;
  readonly onDownload: (
    request: ResponseBodyDownloadRequest,
  ) => Promise<ResponseBodySink | null>;
  readonly onProgress?: (receivedBytes: number) => void;
  readonly onTerminal?: (terminal: ResponseBodyCollectorTerminal) => void;
}

type OperationOutcome<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'terminal' };

const TEXT_STAGING_TAIL_BYTES = RESPONSE_TEXT_STAGING_MAX_BYTES - RESPONSE_PREVIEW_MAX_BYTES;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function completeCleanupBestEffort(operation: PromiseLike<unknown>): Promise<void> {
  return Promise.resolve(operation).then(() => undefined, () => undefined);
}

function terminalError(terminal: ResponseBodyCollectorTerminal): Error {
  if (terminal.kind === 'failed') return terminal.error;
  if (terminal.kind === 'cancelled') return new Error('Response body collection cancelled');
  return new Error('Response body collection completed');
}

function downloadRequest(
  classification: Exclude<ResponseClassification, { kind: 'empty' }>,
  trigger: ResponseBodyDownloadTrigger,
  reason: DownloadReasonV2,
  receivedBytes: number,
): ResponseBodyDownloadRequest {
  return {
    trigger,
    reason,
    receivedBytes,
    declaredSize: classification.declaredSize,
    mediaType: classification.mediaType,
    suggestedFileName: classification.suggestedFileName,
  };
}

export async function collectResponseBody(
  options: CollectResponseBodyOptions,
): Promise<ResponseBodyCollectorResult> {
  const previewBuffer = new Uint8Array(RESPONSE_PREVIEW_MAX_BYTES);
  const stagingTail = options.classification.kind === 'text'
    ? new Uint8Array(TEXT_STAGING_TAIL_BYTES)
    : undefined;
  let previewBytes = 0;
  let stagingTailBytes = 0;
  let previewHighWater = 0;
  let stagedHighWater = 0;
  let totalBytes = 0;
  let download: ResponseBodyDownloadRequest | undefined;
  let sink: ResponseBodySink | undefined;
  let sinkClosed = false;
  let sinkAborted = false;
  let idleTimer: RequestTimerHandle | undefined;
  let timerSuspended = false;
  let sourceFinished = false;
  let sourceReturned = false;
  let terminal: ResponseBodyCollectorTerminal | undefined;
  let resolveTerminal!: (value: ResponseBodyCollectorTerminal) => void;
  const terminalPromise = new Promise<ResponseBodyCollectorTerminal>((resolve) => {
    resolveTerminal = resolve;
  });

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    options.timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const settle = (nextTerminal: ResponseBodyCollectorTerminal): boolean => {
    if (terminal) return false;
    terminal = nextTerminal;
    clearIdleTimer();
    options.signal?.removeEventListener('abort', onAbort);
    resolveTerminal(nextTerminal);
    options.onTerminal?.(nextTerminal);
    return true;
  };

  const fail = (reason: ResponseBodyCollectorFailureReason, error: unknown): boolean =>
    settle({ kind: 'failed', reason, error: toError(error) });

  const armIdleTimer = () => {
    if (options.idleTimeoutMs <= 0 || timerSuspended || terminal) return;
    idleTimer = options.timers.setTimeout(() => {
      idleTimer = undefined;
      fail(
        'idle-timeout',
        new Error(`Response body idle timeout after ${options.idleTimeoutMs}ms`),
      );
    }, options.idleTimeoutMs);
  };

  const resetIdleTimerForProgress = () => {
    clearIdleTimer();
    armIdleTimer();
  };

  const recordProgress = (byteLength: number): boolean => {
    if (byteLength <= 0 || terminal) return !terminal;
    totalBytes += byteLength;
    resetIdleTimerForProgress();
    options.onProgress?.(totalBytes);
    return !terminal;
  };

  async function waitForOperation<T>(operation: Promise<T>): Promise<OperationOutcome<T>> {
    const observed: Promise<OperationOutcome<T>> = operation.then(
      (value): OperationOutcome<T> => ({ kind: 'value', value }),
      (error: unknown): OperationOutcome<T> => ({ kind: 'error', error }),
    );
    return Promise.race([
      observed,
      terminalPromise.then<OperationOutcome<T>>(() => ({ kind: 'terminal' })),
    ]);
  }

  function onAbort(): void {
    settle({ kind: 'cancelled' });
  }

  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const iterator = options.source[Symbol.asyncIterator]();

  const stopSource = async () => {
    if (sourceFinished || sourceReturned || !iterator.return) return;
    sourceReturned = true;
    await completeCleanupBestEffort(iterator.return());
  };

  const abortSink = async () => {
    if (!sink || sinkClosed || sinkAborted || !terminal) return;
    sinkAborted = true;
    await completeCleanupBestEffort(sink.abort(terminalError(terminal)));
  };

  const writeToSink = async (chunk: Uint8Array): Promise<boolean> => {
    if (chunk.byteLength === 0) return !terminal;
    if (!sink) throw new Error('Response body sink is unavailable');

    const outcome = await waitForOperation(Promise.resolve().then(() => sink!.write(chunk)));
    if (outcome.kind === 'terminal') return false;
    if (outcome.kind === 'error') {
      fail('sink-write', outcome.error);
      return false;
    }
    return true;
  };

  const closeSink = async (): Promise<boolean> => {
    if (!sink || sinkClosed) return !terminal;

    const outcome = await waitForOperation(Promise.resolve().then(() => sink!.close()));
    if (outcome.kind === 'terminal') return false;
    if (outcome.kind === 'error') {
      fail('sink-close', outcome.error);
      return false;
    }
    sinkClosed = true;
    return true;
  };

  const retain = (chunk: Uint8Array) => {
    let offset = 0;
    if (previewBytes < RESPONSE_PREVIEW_MAX_BYTES) {
      const retained = Math.min(
        chunk.byteLength,
        RESPONSE_PREVIEW_MAX_BYTES - previewBytes,
      );
      previewBuffer.set(chunk.subarray(0, retained), previewBytes);
      previewBytes += retained;
      previewHighWater = Math.max(previewHighWater, previewBytes);
      offset = retained;
    }

    if (stagingTail && offset < chunk.byteLength && stagingTailBytes < stagingTail.byteLength) {
      const retained = Math.min(
        chunk.byteLength - offset,
        stagingTail.byteLength - stagingTailBytes,
      );
      stagingTail.set(chunk.subarray(offset, offset + retained), stagingTailBytes);
      stagingTailBytes += retained;
    }

    stagedHighWater = Math.max(
      stagedHighWater,
      previewBytes + (stagingTail ? stagingTailBytes : 0),
    );
  };

  const flushStagedPrefix = async (): Promise<boolean> => {
    if (previewBytes > 0 && !await writeToSink(previewBuffer.subarray(0, previewBytes))) {
      return false;
    }
    if (stagingTailBytes > 0 && stagingTail
      && !await writeToSink(stagingTail.subarray(0, stagingTailBytes))) {
      return false;
    }
    return true;
  };

  const acquireSink = async (request: ResponseBodyDownloadRequest): Promise<boolean> => {
    timerSuspended = true;
    clearIdleTimer();
    const destination = Promise.resolve().then(() => options.onDownload(request));
    const outcome = await waitForOperation(destination);
    timerSuspended = false;

    if (outcome.kind === 'terminal') {
      void destination.then(async (lateSink) => {
        if (!lateSink || !terminal) return;
        await completeCleanupBestEffort(lateSink.abort(terminalError(terminal)));
      }, () => undefined);
      return false;
    }
    if (outcome.kind === 'error') {
      fail('destination', outcome.error);
      return false;
    }
    if (outcome.value === null) {
      settle({ kind: 'cancelled' });
      return false;
    }

    sink = outcome.value;
    download = request;
    armIdleTimer();
    return true;
  };

  let downloadSinkRequested = false;

  const acquireDownloadSink = async (): Promise<boolean> => {
    if (sink) return true;
    if (downloadSinkRequested) return false;
    downloadSinkRequested = true;
    const classification = options.classification as Extract<ResponseClassification, { kind: 'download' }>;
    const request = downloadRequest(classification, 'immediate', classification.reason, totalBytes);
    return acquireSink(request);
  };

  const processDownloadedChunk = async (chunk: Uint8Array): Promise<boolean> => {
    if (!recordProgress(chunk.byteLength)) return false;
    if (!sink && !await acquireDownloadSink()) return false;
    return writeToSink(chunk);
  };

  const processCandidateChunk = async (chunk: Uint8Array): Promise<boolean> => {
    if (sink) return processDownloadedChunk(chunk);

    const candidateLimit = options.classification.kind === 'text'
      ? RESPONSE_TEXT_STAGING_MAX_BYTES
      : RESPONSE_PREVIEW_MAX_BYTES;
    const threshold = candidateLimit + 1;
    const bytesUntilThreshold = threshold - totalBytes;

    if (chunk.byteLength < bytesUntilThreshold) {
      retain(chunk);
      return recordProgress(chunk.byteLength);
    }

    const crossingLength = bytesUntilThreshold;
    retain(chunk.subarray(0, crossingLength));
    if (!recordProgress(crossingLength)) return false;

    const request = downloadRequest(
      options.classification as Exclude<ResponseClassification, { kind: 'empty' }>,
      'threshold',
      'preview-limit',
      totalBytes,
    );
    if (!await acquireSink(request)) return false;
    if (!await flushStagedPrefix()) return false;

    const forwarded = chunk.subarray(crossingLength - 1);
    const bytesAfterThreshold = forwarded.byteLength - 1;
    if (bytesAfterThreshold > 0 && !recordProgress(bytesAfterThreshold)) return false;
    return writeToSink(forwarded);
  };

  const result = (): ResponseBodyCollectorResult => {
    const settledTerminal = terminal ?? { kind: 'completed' as const };
    const boundedPreview = previewBuffer.slice(0, previewBytes);
    return {
      terminal: settledTerminal,
      totalBytes,
      previewBytes: boundedPreview,
      truncated: totalBytes > boundedPreview.byteLength,
      complete: settledTerminal.kind === 'completed',
      ...(download ? { download } : {}),
      highWaterMark: {
        previewBytes: previewHighWater,
        stagedBytes: stagedHighWater,
      },
    };
  };

  if (options.classification.kind === 'empty') {
    settle({ kind: 'completed' });
    return result();
  }

  if (!terminal) {
    armIdleTimer();
  }

  while (!terminal) {
    const next = await waitForOperation(Promise.resolve().then(() => iterator.next()));
    if (next.kind === 'terminal') break;
    if (next.kind === 'error') {
      fail('source-read', next.error);
      break;
    }
    if (next.value.done) {
      sourceFinished = true;
      break;
    }

    const chunk = next.value.value;
    if (chunk.byteLength === 0) continue;
    const processed = options.classification.kind === 'download'
      ? await processDownloadedChunk(chunk)
      : await processCandidateChunk(chunk);
    if (!processed) break;
  }

  if (!terminal && sourceFinished && options.classification.kind === 'raster' && !sink && totalBytes > 0) {
    const validation = validateRasterPreview({
      chunks: [previewBuffer.subarray(0, previewBytes)],
      mediaType: options.classification.mediaType as RasterMediaType,
      complete: true,
      totalBytes,
    });
    if (!validation.eligible) {
      const request = downloadRequest(
        options.classification,
        'invalid-raster',
        'invalid-image',
        totalBytes,
      );
      if (await acquireSink(request)) await flushStagedPrefix();
    }
  }

  if (!terminal && sourceFinished && sink) await closeSink();
  if (!terminal && sourceFinished) settle({ kind: 'completed' });

  if (terminal?.kind !== 'completed') {
    await stopSource();
    await abortSink();
  }

  return result();
}
