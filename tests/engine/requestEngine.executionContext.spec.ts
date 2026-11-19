import { expect, test } from '@playwright/test';
import { RequestEngine, type ExecutionContext } from '../../src/main/engine/requestEngine';
import type { RequestProgressEvent } from '../../src/main/engine/requestRuntimeAdapters';
import type { Request } from '../../src/shared/types';
import { FakeClientRequest, FakeIncomingMessage } from './fixtures/httpResponseFixture';

const store = { getActiveEnvironmentId: () => undefined } as never;
const request = (patch: Partial<Request> = {}): Request => ({
  id: 'req', name: 'Request', method: 'GET', url: 'http://api.example.test/items', headers: [], parameters: [],
  body: { type: 'none' }, auth: { type: 'none' }, scripts: {}, settings: { timeout: 0, followRedirect: true },
  createdAt: 0, updatedAt: 0, ...patch,
});
const context = (signal: AbortSignal, patch: Partial<ExecutionContext> = {}): ExecutionContext => ({
  signal, purpose: 'send', protectCredentialsOnRedirect: false, ...patch,
});

/** Paths ending in /hang wait until their signal aborts; others answer `ok:<path>` at once. */
function fetchHarness(overrides: Record<string, unknown> = {}) {
  const seen = { aborted: [] as string[], timingCaptures: 0, saveDialogs: 0, runtimeProgress: [] as RequestProgressEvent[] };
  const release = new Map<string, () => void>();
  const engine = new RequestEngine({} as never, store, {
    responseTransport: 'fetch',
    captureConnectionTimings: async () => { seen.timingCaptures++; return null; },
    showSaveDialog: async () => { seen.saveDialogs++; return { canceled: true, filePath: '' }; },
    emitProgress: event => { seen.runtimeProgress.push(event); },
    fetch: async (_session, url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/hang') || path.endsWith('/wait')) {
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => { seen.aborted.push(path); reject(init.signal!.reason); }, { once: true });
          release.set(path, () => resolve(new Response(`ok:${path}`)));
        });
      }
      if (path.endsWith('/download')) {
        return new Response('file-bytes', { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="a.bin"' } });
      }
      return new Response(`ok:${path}`, { headers: { 'content-type': 'text/plain' } });
    },
    ...overrides,
  });
  return { engine, seen, release };
}

function bodyText(response: { preview: { kind: string } }): string {
  return response.preview.kind === 'text' ? (response.preview as { text: string }).text : '';
}

test('two overlapping executions keep their own signals', async () => {
  const { engine, seen, release } = fetchHarness();
  const a = new AbortController();
  const b = new AbortController();
  const first = engine.executeInternal(request({ url: 'http://api.example.test/a/hang' }), undefined, context(a.signal)).catch(error => error);
  const second = engine.executeInternal(request({ url: 'http://api.example.test/b/wait' }), undefined, context(b.signal));
  await expect.poll(() => release.size).toBe(2);

  a.abort();
  expect((await first).requestError).toMatchObject({ kind: 'cancelled' });
  expect(seen.aborted).toEqual(['/a/hang']);

  release.get('/b/wait')!();
  expect(bodyText(await second)).toBe('ok:/b/wait');
});

test('cancel() reaches only the UI operation', async () => {
  const { engine, seen, release } = fetchHarness();
  const internal = new AbortController();
  const ui = engine.executeV2({ request: request({ url: 'http://api.example.test/ui/hang' }) }).catch(error => error);
  const token = engine.executeInternal(request({ url: 'http://api.example.test/token/wait' }), undefined, context(internal.signal, { purpose: 'token' }));
  await expect.poll(() => release.size).toBe(2);

  engine.cancel();
  expect((await ui).requestError).toMatchObject({ kind: 'cancelled' });
  expect(seen.aborted).toEqual(['/ui/hang']);

  release.get('/token/wait')!();
  expect(bodyText(await token)).toBe('ok:/token/wait');
});

test('executeV2 delivers progress to the callback it is given', async () => {
  const { engine, seen } = fetchHarness();
  const progress: RequestProgressEvent[] = [];
  await engine.executeV2({ request: request() }, undefined, event => progress.push(event));
  expect(progress.some(event => event.phase === 'receiving' && event.requestId === 'req')).toBe(true);
  expect(seen.runtimeProgress).toEqual([]);

  await engine.executeV2({ request: request() });
  expect(seen.runtimeProgress.some(event => event.phase === 'receiving')).toBe(true);
});

test('a token run records no timings, emits no progress and never opens a Save dialog', async () => {
  const { engine, seen } = fetchHarness();
  const progress: RequestProgressEvent[] = [];
  const signal = new AbortController().signal;
  const ok = await engine.executeInternal(request(), undefined, context(signal, { purpose: 'token', onProgress: event => progress.push(event) }));
  expect(bodyText(ok)).toBe('ok:/items');
  expect(seen.timingCaptures).toBe(0);

  const failure = await engine.executeInternal(request({ url: 'http://api.example.test/download' }), undefined, context(signal, { purpose: 'token' }))
    .catch(error => error);
  expect(failure.cause?.code ?? failure.requestError?.code).toBe('TOKEN_SOURCE_NOT_TEXT');
  expect(seen.saveDialogs).toBe(0);
  expect(progress).toEqual([]);
  expect(seen.runtimeProgress).toEqual([]);

  await engine.executeInternal(request(), undefined, context(signal));
  expect(seen.timingCaptures).toBe(1);
});

test.describe('redirect protection on net', () => {
  function netHarness(redirectUrl: string) {
    const requests: FakeClientRequest[] = [];
    const engine = new RequestEngine({} as never, store, {
      responseTransport: 'net',
      captureConnectionTimings: async () => null,
      netRequest: () => {
        const clientRequest = new FakeClientRequest(current => {
          setImmediate(() => {
            current.emit('redirect', 302, 'GET', redirectUrl, {});
            setImmediate(() => {
              const response = new FakeIncomingMessage({ status: 200, headers: { 'content-type': 'text/plain' } });
              current.emit('response', response);
              setImmediate(() => { response.emit('data', Buffer.from('done')); response.emit('end'); current.emit('close'); });
            });
          });
        });
        requests.push(clientRequest);
        return clientRequest;
      },
    });
    return { engine, requests };
  }

  test('output protection blocks a cross-origin redirect with its own message', async () => {
    const { engine, requests } = netHarness('https://elsewhere.example.test/next');
    const failure = await engine.executeInternal(request({ url: 'https://api.example.test/items' }), undefined,
      context(new AbortController().signal, { protectCredentialsOnRedirect: 'output' })).catch(error => error);
    expect(failure.requestError.rawMessage).toContain('was blocked because the request carries a fetched token');
    expect(requests[0].followRedirectCalls).toBe(0);
  });

  test('output protection follows a same-origin redirect', async () => {
    const { engine, requests } = netHarness('https://api.example.test/next');
    const response = await engine.executeInternal(request({ url: 'https://api.example.test/items' }), undefined,
      context(new AbortController().signal, { protectCredentialsOnRedirect: 'output' }));
    expect(response.status).toBe(200);
    expect(requests[0].followRedirectCalls).toBe(1);
  });

  test('output protection refuses a downgrade to http on the same host', async () => {
    const { engine } = netHarness('http://api.example.test/next');
    const failure = await engine.executeInternal(request({ url: 'https://api.example.test/items' }), undefined,
      context(new AbortController().signal, { protectCredentialsOnRedirect: 'output' })).catch(error => error);
    expect(failure.requestError.rawMessage).toContain('fetched token');
  });

  test('oauth protection keeps its original message', async () => {
    const { engine } = netHarness('https://elsewhere.example.test/next');
    const failure = await engine.executeInternal(request({ url: 'https://api.example.test/items' }), undefined,
      context(new AbortController().signal, { protectCredentialsOnRedirect: 'oauth' })).catch(error => error);
    expect(failure.requestError.rawMessage).toContain('OAuth redirect to https://elsewhere.example.test/next was blocked before Authorization could be forwarded');
  });

  test('no protection follows a cross-origin redirect as before', async () => {
    const { engine, requests } = netHarness('https://elsewhere.example.test/next');
    const response = await engine.executeInternal(request({ url: 'https://api.example.test/items' }), undefined, context(new AbortController().signal));
    expect(response.status).toBe(200);
    expect(requests[0].followRedirectCalls).toBe(1);
  });
});
