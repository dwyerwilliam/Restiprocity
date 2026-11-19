import { EventEmitter } from 'events';
import { expect, test } from '@playwright/test';
import { projectHistoryEntryForIpc, RequestOperationCoordinator } from '../../src/main/ipc/handlers';
import type { RequestProgressEvent } from '../../src/main/engine/requestRuntimeAdapters';
import { defaultRequestOutputs } from '../../src/shared/requestOutputs';
import type { IpcRequestPayload, PersistedResponseSnapshotV2, Request, ResponseV2 } from '../../src/shared/types';

class FakeSender extends EventEmitter {
  readonly messages: Array<{ channel: string; payload: unknown }> = [];
  send(channel: string, payload: unknown): void { this.messages.push({ channel, payload }); }
  isDestroyed(): boolean { return false; }
}

class FakeEngine {
  readonly calls: Array<{ payload: IpcRequestPayload; onProgress?: (event: RequestProgressEvent) => void; resolve(response: ResponseV2): void }> = [];
  executeV2(payload: IpcRequestPayload, _parent?: unknown, onProgress?: (event: RequestProgressEvent) => void): Promise<ResponseV2> {
    return new Promise(resolve => this.calls.push({ payload, onProgress, resolve }));
  }
  cancel(): void {}
}

class FakeHistory {
  readonly saved: PersistedResponseSnapshotV2[] = [];
  async saveSnapshot(snapshot: PersistedResponseSnapshotV2): Promise<void> { this.saved.push(snapshot); }
}

function request(patch: Partial<Request> = {}): Request {
  return {
    id: 'login', name: 'Get session token', method: 'POST', url: 'https://auth.test/token', headers: [], parameters: [],
    body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 0 }, scripts: {}, createdAt: 1, updatedAt: 1, ...patch,
  };
}

function tokenResponse(patch: Partial<ResponseV2> = {}): ResponseV2 {
  return {
    version: 2, id: 'r1', requestId: 'login', status: 200, statusText: 'OK',
    headers: [{ key: 'content-type', value: 'application/json', enabled: true }, { key: 'x-session', value: 'session-secret', enabled: true }],
    preview: { kind: 'text', format: 'json', text: '{"access_token":"tok-secret-1"}', parseState: 'valid', charset: 'utf-8', decodeError: false, capturedBytes: 31, totalBytes: 31, truncated: false, completeness: 'complete' },
    timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 }, timestamp: 2, size: 31, cookies: [], ...patch,
  };
}

async function sendOnce(payloadRequest: Request, response: ResponseV2) {
  const engine = new FakeEngine();
  const history = new FakeHistory();
  const sender = new FakeSender();
  const coordinator = new RequestOperationCoordinator({ requestEngine: engine, historyStore: history });
  const sending = coordinator.send({ sender }, { operationId: 'op-1', request: payloadRequest });
  engine.calls[0].resolve(response);
  return { result: await sending, history, sender, engine };
}

test('the history entry of a request with outputs keeps no body and no output header; the live result keeps both', async () => {
  const outputs = { ...defaultRequestOutputs(), values: [...defaultRequestOutputs().values, { name: 'session', source: { kind: 'header' as const, name: 'X-Session' } }] };
  const { result, history } = await sendOnce(request({ outputs }), tokenResponse({ outputsNote: { kind: 'updated', names: ['api_token', 'session'] } }));
  expect(history.saved[0].preview.kind).toBe('empty');
  expect(history.saved[0].bodyWithheld).toBe('outputs');
  expect(history.saved[0].outputsNote).toEqual({ kind: 'updated', names: ['api_token', 'session'] });
  expect(JSON.stringify(history.saved[0])).not.toMatch(/tok-secret-1|session-secret/);
  expect(result).toMatchObject({ kind: 'response', response: { preview: { kind: 'text' }, outputsNote: { kind: 'updated' } } });
});

test('a note alone is enough to withhold the body, and a plain request keeps its body', async () => {
  const noted = await sendOnce(request(), tokenResponse({ outputsNote: { kind: 'not-updated', message: 'HTTP 403' } }));
  expect(noted.history.saved[0].bodyWithheld).toBe('outputs');
  const plain = await sendOnce(request(), tokenResponse());
  expect(plain.history.saved[0].preview.kind).toBe('text');
  expect(plain.history.saved[0].bodyWithheld).toBeUndefined();
  // Outputs that arrive malformed from the window are not trusted, and not used to keep the body either way.
  const malformed = await sendOnce(request({ outputs: { enabled: true, values: 'x' } as never }), tokenResponse());
  expect(malformed.history.saved[0].preview.kind).toBe('text');
});

test('progress is mapped field by field, including the token source', async () => {
  const engine = new FakeEngine();
  const sender = new FakeSender();
  const coordinator = new RequestOperationCoordinator({ requestEngine: engine, historyStore: new FakeHistory() });
  const sending = coordinator.send({ sender }, { operationId: 'op-2', request: request({ id: 'child' }) });
  engine.calls[0].onProgress?.({ requestId: 'child', phase: 'acquiring-token', receivedBytes: 0, tokenSource: 'Get session token' });
  expect(sender.messages[0]).toEqual({
    channel: 'request:progress',
    payload: { version: 2, operationId: 'op-2', phase: 'acquiring-token', receivedBytes: 0, tokenSource: 'Get session token' },
  });
  engine.calls[0].resolve(tokenResponse({ requestId: 'child' }));
  await sending;
});

test('a reopened history entry carries the withheld mark', () => {
  const detail = projectHistoryEntryForIpc({
    id: 'h1', request_id: 'login', request_name: 'Get session token', method: 'POST', url: 'https://auth.test/token',
    status: 200, duration: 2, size: 31, timestamp: 2, preview_kind: 'empty', body_withheld: 'outputs',
  });
  expect(detail.bodyWithheld).toBe('outputs');
  const plain = projectHistoryEntryForIpc({
    id: 'h2', request_id: 'x', method: 'GET', url: 'https://a.test', status: 200, duration: 1, size: 0, timestamp: 1, preview_kind: 'empty',
  });
  expect(plain.bodyWithheld).toBeUndefined();
});
