import { EventEmitter } from 'events';
import path from 'path';
import { expect, test } from '@playwright/test';
import { HistoryDetailError, projectHistoryEntryForIpc, RequestOperationCoordinator } from '../../src/main/ipc/handlers';
import { RequestFailureError } from '../../src/main/engine/requestErrors';
import type { RequestProgressEvent } from '../../src/main/engine/requestRuntimeAdapters';
import type { HistoryRequestMetadata } from '../../src/main/stores/historyMetadata';
import { liveCookieResponse } from './fixtures/liveCookieResponse';
import type {
  IpcRequestPayload,
  PersistedResponseSnapshotV2,
  Request,
  ResponseOperationResultV2,
  ResponseV2,
} from '../../src/shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function request(id: string): Request {
  return {
    id,
    name: id,
    method: 'GET',
    url: `https://example.test/${id}`,
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 30_000, cookiesEnabled: true },
    scripts: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

function response(requestId: string, download?: ResponseV2['download']): ResponseV2 {
  return {
    version: 2,
    id: `response-${requestId}`,
    requestId,
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'content-type', value: download ? 'application/octet-stream' : 'text/plain', enabled: true }],
    preview: download
      ? {
          kind: 'download-only',
          mediaType: 'application/octet-stream',
          capturedBytes: 0,
          totalBytes: download.receivedBytes,
          truncated: download.receivedBytes > 0,
          download,
        }
      : {
          kind: 'text',
          format: 'text',
          text: 'bounded response',
          parseState: 'not-applicable',
          charset: 'utf-8',
          decodeError: false,
          capturedBytes: 16,
          totalBytes: 16,
          truncated: false,
          completeness: 'complete',
        },
    timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 2, total: 3 },
    timestamp: 2,
    size: download?.receivedBytes ?? 16,
    cookies: [],
    ...(download ? { download } : {}),
  };
}

class FakeSender extends EventEmitter {
  readonly messages: Array<{ channel: string; payload: unknown }> = [];
  private destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  send(channel: string, payload: unknown): void {
    this.messages.push({ channel, payload });
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

interface EngineCall {
  payload: IpcRequestPayload;
  parentWindow: unknown;
  onProgress?: (event: RequestProgressEvent) => void;
  completion: Deferred<ResponseV2>;
}

class FakeEngine {
  readonly calls: EngineCall[] = [];
  cancelCount = 0;
  disposeCount = 0;
  onCancel: (() => void) | undefined;

  executeV2(
    payload: IpcRequestPayload,
    parentWindow?: unknown,
    onProgress?: (event: RequestProgressEvent) => void,
  ): Promise<ResponseV2> {
    const completion = deferred<ResponseV2>();
    this.calls.push({ payload, parentWindow, onProgress, completion });
    return completion.promise;
  }

  cancel(): void {
    this.cancelCount += 1;
    this.onCancel?.();
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}

class FakeHistory {
  readonly saved: PersistedResponseSnapshotV2[] = [];
  readonly metadata: Array<HistoryRequestMetadata | undefined> = [];

  async saveSnapshot(snapshot: PersistedResponseSnapshotV2, metadata?: HistoryRequestMetadata): Promise<void> {
    this.saved.push(snapshot);
    this.metadata.push(metadata);
  }

  async getEntry(): Promise<null> {
    return null;
  }
}

function payload(operationId: string, requestId: string) {
  return { operationId, request: request(requestId) };
}

function event(sender: FakeSender) {
  return { sender } as never;
}

async function settleTurns(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function containsForbiddenPayload(value: unknown): boolean {
  if (Buffer.isBuffer(value) || value instanceof Error) return true;
  if (typeof value === 'string') return path.isAbsolute(value) || value.includes('.part') || value.includes('.backup');
  if (Array.isArray(value)) return value.some(containsForbiddenPayload);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) => (
    /(?:destination|part|backup|recovery)path|password|credential|downloadedbytes/i.test(key)
    || containsForbiddenPayload(nested)
  ));
}

test.describe('operation-scoped response IPC lifecycle', () => {
  test('captures send-time history metadata and preserves live cookies when input changes during execution', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const coordinator = new RequestOperationCoordinator({ requestEngine: engine, historyStore: history });
    const input = payload('metadata-operation', 'req-1');
    input.request.name = 'Send-time name';
    input.request.method = 'POST';
    input.request.url = 'https://{{host}}/path?x={{ value }}&token=literal-secret#fragment';

    const sending = coordinator.send({ sender: new FakeSender(40) }, input);
    input.request.name = 'Later collection rename';
    input.request.method = 'DELETE';
    input.request.url = 'https://later.test/changed';
    engine.calls[0].completion.resolve(liveCookieResponse());
    await sending;

    expect(history.metadata).toEqual([{
      requestName: 'Send-time name', method: 'POST',
      url: 'https://{{host}}/path?x={{ value }}&token=[REDACTED]',
    }]);
  });

  test('captures send-time history metadata and preserves live cookies in the live result only', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const coordinator = new RequestOperationCoordinator({ requestEngine: engine, historyStore: history });
    const live = liveCookieResponse();
    const original = structuredClone(live);

    const sending = coordinator.send({ sender: new FakeSender(41) }, payload('cookies-operation', 'req-1'));
    engine.calls[0].completion.resolve(live);
    const result = await sending;

    expect(result).toMatchObject({ kind: 'response', response: { headers: original.headers, cookies: original.cookies } });
    expect(history.saved[0]).toMatchObject({ headers: [original.headers[0], original.headers[5]], cookies: [] });
    expect(JSON.stringify({ headers: history.saved[0].headers, cookies: history.saved[0].cookies })).not.toContain('live-cookie-marker');
    expect(live).toEqual(original);
  });

  for (const [url, expected] of [
    ['https://user:authority-secret@example.test/path?%54OKEN=one&token=two&custom=api-secret&copy=bearer-secret#fragment', 'https://example.test/path?%54OKEN=[REDACTED]&token=[REDACTED]&custom=[REDACTED]&copy=[REDACTED]'],
    ['https://[malformed/credential-secret', ''],
  ]) {
    test(`history metadata rejects credential leakage for ${expected ? 'sensitive' : 'malformed'} configured URL`, async () => {
      const engine = new FakeEngine();
      const history = new FakeHistory();
      const coordinator = new RequestOperationCoordinator({ requestEngine: engine, historyStore: history });
      const input = payload('private-operation', 'req-1');
      input.request.url = url;
      input.request.auth = { type: 'api_key', api_key: { key: 'custom', value: 'api-secret', in: 'query' }, bearer: { token: 'bearer-secret' } };

      const sending = coordinator.send({ sender: new FakeSender(42) }, input);
      input.request.auth = { type: 'none' };
      input.request.url = 'https://later.test/?token=stale-secret';
      engine.calls[0].completion.resolve(response('req-1'));
      await sending;

      expect(history.metadata).toEqual([{ requestName: 'req-1', method: 'GET', url: expected }]);
      expect(JSON.stringify(history.metadata)).not.toMatch(/authority-secret|api-secret|bearer-secret|credential-secret|stale-secret/);
    });
  }

  test('projects bounded history details without paths runtime objects credentials or downloaded bytes', () => {
    const projected = projectHistoryEntryForIpc({
        id: 'history-1',
        request_id: 'request-1',
        method: 'GET',
        url: 'https://example.test/history',
        status: 200,
        duration: 3,
      status_text: 'OK',
      size: 4,
      timestamp: 2,
      headers: [
        { key: 'content-type', value: 'text/plain', enabled: true },
        { key: 'SeT-CoOkIe', value: 'session=credential', enabled: true },
      ],
      timings: { total: 3, runtime: new Error('unsafe runtime') },
      cookies: [{ name: 'session', value: 'credential' }],
      preview_kind: 'text',
      preview_bytes: Buffer.from('safe'),
      preview_captured_bytes: 4,
      preview_truncated: 0,
      destinationPath: 'C:\\private\\download.bin',
      downloadedBytes: Buffer.alloc(32, 0x7f),
      credentials: { password: 'secret' },
    });

    expect(projected).toMatchObject({
      id: 'history-1',
      requestId: 'request-1',
      headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
      cookies: [],
      preview: { kind: 'text', text: 'safe', capturedBytes: 4 },
    });
    expect(containsForbiddenPayload(projected)).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('credential');
    expect(JSON.stringify(projected)).not.toContain(Buffer.alloc(32, 0x7f).toString('base64'));
  });

  test('projects every persisted response variant with honest unavailable payloads', () => {
    const base = {
      id: 'history-variants', request_id: 'request-1', method: 'GET', url: 'https://example.test/history',
      status: 200, duration: 3, size: 32, timestamp: 2, status_text: 'OK',
      headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }],
      timings: { total: 3 }, preview_captured_bytes: 0, preview_truncated: 0,
    };
    const empty = projectHistoryEntryForIpc({ ...base, id: 'empty', preview_kind: 'empty' });
    const text = projectHistoryEntryForIpc({
      ...base, id: 'text', size: 12, preview_kind: 'text', preview_bytes: Buffer.from('bounded text'), preview_captured_bytes: 12,
    });
    const truncated = projectHistoryEntryForIpc({
      ...base, id: 'truncated', preview_kind: 'text', preview_bytes: Buffer.from('prefix'), preview_captured_bytes: 6, preview_truncated: 1,
    });
    const image = projectHistoryEntryForIpc({ ...base, id: 'image', preview_kind: 'image', media_type: 'image/png', download_bytes: 64 });
    const binary = projectHistoryEntryForIpc({ ...base, id: 'binary', preview_kind: 'binary', media_type: 'application/octet-stream', download_bytes: 64 });
    const download = projectHistoryEntryForIpc({
      ...base, id: 'download', preview_kind: 'download-only', media_type: 'application/zip',
      download_outcome: 'saved', download_filename: 'saved.zip', download_bytes: 64,
    });

    expect(empty.preview).toMatchObject({ kind: 'empty', completeness: 'unknown' });
    expect(text.preview).toMatchObject({ kind: 'text', text: 'bounded text', truncated: false });
    expect(truncated.preview).toMatchObject({ kind: 'text', text: 'prefix', capturedBytes: 6, totalBytes: 32, truncated: true, completeness: 'truncated' });
    expect(image.preview).toMatchObject({ kind: 'download-only', download: { reason: 'invalid-image' } });
    expect(image.preview).not.toHaveProperty('dimensions');
    expect(binary.preview).toMatchObject({ kind: 'binary', capturedBytes: 0, totalBytes: 64 });
    expect(binary.preview).not.toHaveProperty('bytes');
    expect(download.preview).toMatchObject({ download: { state: 'saved', suggestedFileName: 'saved.zip' } });

    const oversized = projectHistoryEntryForIpc({
      ...base, id: 'oversized', headers: [{ key: 'X'.repeat(20_000), value: 'Y'.repeat(20_000), enabled: true }], preview_kind: 'empty',
    });
    expect(oversized.headers[0]?.key.length).toBe(16_384);
    expect(oversized.headers[0]?.value.length).toBe(16_384);
  });

  test('rejects unsupported persisted preview kinds as recoverable history detail errors', () => {
    expect(() => projectHistoryEntryForIpc({
      id: 'unsupported-preview-kind', request_id: 'request-1', method: 'GET', url: 'https://example.test/history',
      status: 200, duration: 1, size: 1, timestamp: 1, preview_kind: 'future-preview',
    })).toThrow(HistoryDetailError);
  });

  test('rejects malformed required history fields without returning partial detail', () => {
    expect(() => projectHistoryEntryForIpc({ id: 'bad', request_id: 'request-1', method: 'GET', url: '', status: 200, duration: 1, size: 1, timestamp: 1 })).toThrow(HistoryDetailError);
    expect(() => projectHistoryEntryForIpc({ id: 'bad', request_id: 'request-1', method: 'GET', url: 'https://example.test', status: -1, duration: 1, size: 1, timestamp: 1 })).toThrow(HistoryDetailError);
  });

  test('resolves the dialog parent from the sender that started each operation', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const senderA = new FakeSender(1);
    const senderB = new FakeSender(2);
    const windows = new Map<unknown, { owner: string }>([[senderA, { owner: 'A' }], [senderB, { owner: 'B' }]]);
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: (sender) => windows.get(sender),
    });

    const first = coordinator.send(event(senderA), payload('operation-a', 'request-a'));
    expect(engine.calls[0].parentWindow).toEqual({ owner: 'A' });
    engine.calls[0].completion.resolve(response('request-a'));
    await first;

    const second = coordinator.send(event(senderB), payload('operation-b', 'request-b'));
    expect(engine.calls[1].parentWindow).toEqual({ owner: 'B' });
    engine.calls[1].completion.resolve(response('request-b'));
    await second;
  });

  test('opens dialogs unparented when the sender has no window', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => undefined,
    });

    const sent = coordinator.send(event(new FakeSender(1)), payload('operation-a', 'request-a'));
    expect(engine.calls[0].parentWindow).toBeUndefined();
    engine.calls[0].completion.resolve(response('request-a'));
    await sent;
  });

  test('enforces one owner and throttles progress only to the initiating sender', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const senderA = new FakeSender(1);
    const senderB = new FakeSender(2);
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => ({ owner: 'A' }) as never,
      now: () => now,
      setTimeout: (callback) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => { timers.delete(id as number); },
    });

    const sendA = coordinator.send(event(senderA), payload('operation-a', 'request-a'));
    expect(engine.calls).toHaveLength(1);
    const busy = await coordinator.send(event(senderB), payload('operation-b', 'request-b'));
    expect(busy).toEqual({ version: 2, operationId: 'operation-b', kind: 'busy' });

    const progress = engine.calls[0].onProgress!;
    progress({ requestId: 'request-a', phase: 'receiving', receivedBytes: 1 });
    progress({ requestId: 'request-a', phase: 'receiving', receivedBytes: 2 });
    progress({ requestId: 'request-b', phase: 'receiving', receivedBytes: 999 });
    expect(senderA.messages).toHaveLength(1);
    expect(senderB.messages).toHaveLength(0);

    now = 100;
    for (const callback of [...timers.values()]) callback();
    expect(senderA.messages).toHaveLength(2);
    expect(senderA.messages[1]).toMatchObject({
      channel: 'request:progress',
      payload: { operationId: 'operation-a', receivedBytes: 2 },
    });

    engine.calls[0].completion.resolve(response('request-a'));
    expect(await sendA).toMatchObject({ version: 2, operationId: 'operation-a', kind: 'response' });
    progress({ requestId: 'request-a', phase: 'receiving', receivedBytes: 3 });
    expect(senderA.messages).toHaveLength(2);
    expect(history.saved).toHaveLength(1);
    expect(history.saved[0]).toMatchObject({ requestId: 'request-a', preview: { kind: 'text' } });
  });

  test('cancelled operation does not invent history when cancelled during destination selection', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const owner = new FakeSender(10);
    const stranger = new FakeSender(11);
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => undefined,
    });
    engine.onCancel = () => engine.calls[0].completion.reject(new RequestFailureError({
      kind: 'cancelled',
      message: 'Request was cancelled before an HTTP response was received',
      rawMessage: 'AbortError',
      code: null,
      url: 'https://example.test/request-a',
      retryable: false,
    }, new DOMException('cancelled', 'AbortError')));

    const sending = coordinator.send(event(owner), payload('operation-a', 'request-a'));
    expect(await coordinator.send(event(stranger), payload('busy-operation', 'busy-request'))).toMatchObject({ kind: 'busy' });
    const strangerCancel = await coordinator.cancel(event(stranger), 'operation-a');
    expect(strangerCancel).toEqual({ version: 2, operationId: 'operation-a', kind: 'cancelled' });
    expect(engine.cancelCount).toBe(0);

    const firstCancel = coordinator.cancel(event(owner), 'operation-a');
    const [sendResult, cancelResult] = await Promise.all([sending, firstCancel]);
    expect(sendResult).toEqual({ version: 2, operationId: 'operation-a', kind: 'cancelled' });
    expect(cancelResult).toEqual(sendResult);
    expect(await coordinator.cancel(event(owner), 'operation-a')).toEqual(sendResult);
    expect(engine.cancelCount).toBe(1);
    expect(history.saved).toHaveLength(0);
    expect(history.metadata).toHaveLength(0);
    expect(owner.messages).toHaveLength(0);
    expect(containsForbiddenPayload([sendResult, cancelResult, history.saved])).toBe(false);
  });

  test('persists and returns a terminal cancelled download after post-header cancellation', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const owner = new FakeSender(12);
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => undefined,
    });
    const cancelledDownload = {
      state: 'cancelled' as const,
      reason: 'attachment' as const,
      mediaType: 'application/octet-stream',
      suggestedFileName: 'cancelled.bin',
      receivedBytes: 4,
    };

    const sending = coordinator.send(event(owner), payload('operation-a', 'request-a'));
    const cancelling = coordinator.cancel(event(owner), 'operation-a');
    engine.calls[0].completion.resolve(response('request-a', cancelledDownload));

    const [sendResult, cancelResult] = await Promise.all([sending, cancelling]);
    expect(sendResult).toMatchObject({
      version: 2,
      operationId: 'operation-a',
      kind: 'download',
      response: { requestId: 'request-a', download: { state: 'cancelled' } },
      download: { state: 'cancelled', receivedBytes: 4 },
    });
    expect(cancelResult).toEqual(sendResult);
    expect(history.saved).toHaveLength(1);
    expect(history.saved[0]).toMatchObject({
      requestId: 'request-a',
      download: { state: 'cancelled', receivedBytes: 4 },
    });
    expect(containsForbiddenPayload([sendResult, history.saved])).toBe(false);
  });

  test('persists each post-header download outcome exactly once as bounded metadata', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const owner = new FakeSender(20);
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => undefined,
    });
    const outcomes = [
      { state: 'saved', receivedBytes: 20 },
      { state: 'cancelled', receivedBytes: 4 },
      { state: 'failed', receivedBytes: 7, failure: { code: 'disk-full', message: 'Download failed.' } },
    ] as const;
    const results: ResponseOperationResultV2[] = [];

    for (const [index, outcome] of outcomes.entries()) {
      const operationId = `operation-${index}`;
      const requestId = `request-${index}`;
      const sending = coordinator.send(event(owner), payload(operationId, requestId));
      const unsafeResponse = {
        ...response(requestId, {
          ...outcome,
          reason: 'attachment',
          mediaType: 'application/octet-stream',
          suggestedFileName: `${outcome.state}.bin`,
        }),
        destinationPath: `C:\\private\\${outcome.state}.bin`,
        downloadedBytes: Buffer.alloc(32, 0x7f),
        credentials: { password: 'secret' },
      };
      engine.calls[index].completion.resolve(unsafeResponse);
      results.push(await sending);
    }

    expect(results.map((result) => result.kind)).toEqual(['download', 'download', 'failed']);
    expect(results[1]).toMatchObject({
      kind: 'download',
      response: { requestId: 'request-1', download: { state: 'cancelled' } },
      download: { state: 'cancelled', receivedBytes: 4 },
    });
    expect(history.saved).toHaveLength(3);
    expect(history.saved.map((snapshot) => snapshot.download?.state)).toEqual(['saved', 'cancelled', 'failed']);
    expect(containsForbiddenPayload([results, history.saved])).toBe(false);

    const failing = coordinator.send(event(owner), payload('operation-pre-header', 'request-pre-header'));
    engine.calls[3].completion.reject(new Error('connect failed C:\\private\\socket'));
    expect((await failing).kind).toBe('failed');
    expect(history.saved).toHaveLength(3);
  });

  test('sender destruction cancels only its active operation and ignores late events', async () => {
    const engine = new FakeEngine();
    const history = new FakeHistory();
    const owner = new FakeSender(30);
    const stranger = new FakeSender(31);
    const coordinator = new RequestOperationCoordinator({
      requestEngine: engine,
      historyStore: history,
      resolveParentWindow: () => undefined,
    });
    engine.onCancel = () => engine.calls[0].completion.reject(new DOMException('cancelled', 'AbortError'));

    const sending = coordinator.send(event(owner), payload('operation-a', 'request-a'));
    stranger.destroy();
    await settleTurns();
    expect(engine.cancelCount).toBe(0);

    const lateProgress = engine.calls[0].onProgress!;
    owner.destroy();
    expect((await sending).kind).toBe('cancelled');
    expect(engine.cancelCount).toBe(1);
    lateProgress({ requestId: 'request-a', phase: 'receiving', receivedBytes: 99 });
    expect(owner.messages).toHaveLength(0);
    expect(history.saved).toHaveLength(0);
  });
});
