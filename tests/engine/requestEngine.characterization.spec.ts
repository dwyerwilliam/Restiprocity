import { expect, test } from '@playwright/test';
import type { Session } from 'electron';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { RequestFailureError } from '../../src/main/engine/requestErrors';
import type { RequestRuntimeAdapters, SessionFetchAdapter } from '../../src/main/engine/requestRuntimeAdapters';
import type { Request } from '../../src/shared/types';
import {
  createFetchAdapter,
  createNetResponseFixture,
  createTestRuntimeAdapters,
  DeterministicTimers,
  FakeClientRequest,
  SafeTestFileSystem,
} from './fixtures/httpResponseFixture';

const collectionStore = {
  getActiveEnvironmentId: () => null,
  getEnvironment: async () => null,
};

function makeRequest(overrides: Partial<Request> = {}): Request {
  const now = 1_700_000_000_000;
  return {
    id: 'request-characterization',
    name: 'Transport characterization',
    method: 'GET',
    url: 'https://api.example.test/resource',
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 0, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createSession(fetch: SessionFetchAdapter): Session {
  return {
    fetch: (url: string, init?: RequestInit) => fetch({} as Session, url, init ?? {}),
    allowNTLMCredentialsForDomains: () => {},
  } as unknown as Session;
}

function createEngine(runtime: RequestRuntimeAdapters): RequestEngine {
  return new RequestEngine(createSession(runtime.fetch), collectionStore, runtime);
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

async function waitForEnd(request: FakeClientRequest): Promise<void> {
  for (let attempts = 0; attempts < 20 && !request.ended; attempts += 1) {
    await Promise.resolve();
  }
  expect(request.ended).toBe(true);
}

test.describe('RequestEngine transport characterization', () => {
  test('preserves equivalent fetch and net response metadata', async () => {
    const options = {
      status: 206,
      statusText: 'Partial Content',
      headers: { 'content-type': 'application/octet-stream', 'x-fixture': ['one', 'two'] },
      chunks: [{ data: 'abc', delayMs: 7 }],
      headersDelayMs: 3,
      contentEncoding: 'gzip',
      contentLength: 99,
    } as const;

    const fetchTimers = new DeterministicTimers();
    const fetchRuntime = createTestRuntimeAdapters({
      timers: fetchTimers,
      fetch: createFetchAdapter(options, fetchTimers),
      netRequest: () => new FakeClientRequest(),
    });
    const fetchResponse = await createEngine(fetchRuntime).execute({ request: makeRequest() });

    const netTimers = new DeterministicTimers();
    const netFixture = createNetResponseFixture(options, netTimers);
    const netRuntime = createTestRuntimeAdapters({
      timers: netTimers,
      fetch: createFetchAdapter(options, netTimers),
      netRequest: netFixture.netRequest,
    });
    const netPromise = createEngine(netRuntime).execute({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    await waitForEnd(netFixture.request);
    netTimers.runAll();
    const netResponse = await netPromise;

    expect(fetchResponse).not.toBeNull();
    expect(netResponse).not.toBeNull();
    expect(fetchResponse && netResponse && {
      fetch: {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: fetchResponse.headers,
        body: fetchResponse.body,
        size: fetchResponse.size,
        timings: fetchResponse.timings,
        timestamp: fetchResponse.timestamp,
      },
      net: {
        status: netResponse.status,
        statusText: netResponse.statusText,
        headers: netResponse.headers,
        body: netResponse.body,
        size: netResponse.size,
        timings: netResponse.timings,
        timestamp: netResponse.timestamp,
      },
    }).toEqual({
      fetch: {
        status: 206,
        statusText: 'Partial Content',
        headers: expect.arrayContaining([
          { key: 'content-encoding', value: 'gzip', enabled: true },
          { key: 'content-length', value: '99', enabled: true },
        ]),
        body: 'abc',
        size: 3,
        timings: { dns: 0, tcp: 0, tls: 0, ttfb: 3, download: 7, total: 10 },
        timestamp: 1_700_000_000_000,
      },
      net: {
        status: 206,
        statusText: 'Partial Content',
        headers: expect.arrayContaining([
          { key: 'content-encoding', value: 'gzip', enabled: true },
          { key: 'content-length', value: '99', enabled: true },
        ]),
        body: 'abc',
        size: 3,
        timings: { dns: 0, tcp: 0, tls: 0, ttfb: 3, download: 7, total: 10 },
        timestamp: 1_700_000_000_000,
      },
    });
    expect(fetchTimers.pendingCount).toBe(0);
    expect(netTimers.pendingCount).toBe(0);
  });

  test('preserves fetch and net redirect policies', async () => {
    const fetchTimers = new DeterministicTimers();
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchRuntime = createTestRuntimeAdapters({
      timers: fetchTimers,
      fetch: createFetchAdapter({ chunks: [{ data: 'ok' }] }, fetchTimers, fetchCalls),
      netRequest: () => new FakeClientRequest(),
    });
    const fetchEngine = createEngine(fetchRuntime);
    await fetchEngine.execute({ request: makeRequest() });
    await fetchEngine.execute({
      request: makeRequest({ settings: { ...makeRequest().settings, followRedirect: false } }),
    });
    expect(fetchCalls.map((call) => call.init.redirect)).toEqual(['follow', 'manual']);

    const followTimers = new DeterministicTimers();
    const followFixture = createNetResponseFixture({
      redirect: { statusCode: 302, method: 'GET', url: 'https://api.example.test/final' },
      chunks: [{ data: 'ok' }],
    }, followTimers);
    const followPromise = createEngine(createTestRuntimeAdapters({
      timers: followTimers,
      fetch: createFetchAdapter({}, followTimers),
      netRequest: followFixture.netRequest,
    })).execute({ request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }) });
    await waitForEnd(followFixture.request);
    followTimers.runAll();
    await followPromise;
    expect(followFixture.request.followRedirectCalls).toBe(1);

    const blockedTimers = new DeterministicTimers();
    const blockedFixture = createNetResponseFixture({
      redirect: { statusCode: 307, method: 'GET', url: 'https://api.example.test/blocked' },
      termination: 'stall',
    }, blockedTimers);
    const blockedPromise = createEngine(createTestRuntimeAdapters({
      timers: blockedTimers,
      fetch: createFetchAdapter({}, blockedTimers),
      netRequest: blockedFixture.netRequest,
    })).execute({
      request: makeRequest({
        auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } },
        settings: { ...makeRequest().settings, followRedirect: false },
      }),
    });
    await waitForEnd(blockedFixture.request);
    blockedTimers.runReady();
    const blockedFailure = await captureFailure(blockedPromise);
    expect(blockedFailure.requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'Request failed: redirect to https://api.example.test/blocked (HTTP 307) was blocked',
    });
  });

  test('settles cancellation and timeout causes exactly once', async () => {
    const scenarios = [
      { name: 'no headers timeout', response: { emitResponse: false }, action: 'timeout' as const },
      {
        name: 'post-header body stall',
        response: { chunks: [{ data: 'prefix' }], termination: 'stall' as const },
        action: 'timeout' as const,
      },
      { name: 'user cancellation', response: { termination: 'stall' as const }, action: 'cancel' as const },
    ];

    for (const scenario of scenarios) {
      const timers = new DeterministicTimers();
      const fixture = createNetResponseFixture(scenario.response, timers, (request) => {
        timers.setImmediate(() => {
          request.emit('error', Object.assign(new Error('net::ERR_ABORTED'), { name: 'AbortError', code: 'ERR_ABORTED' }));
          request.emit('close');
        });
      });
      const engine = createEngine(createTestRuntimeAdapters({
        timers,
        fetch: createFetchAdapter({}, timers),
        netRequest: fixture.netRequest,
      }));
      let settlementCount = 0;
      const execution = engine.execute({
        request: makeRequest({
          auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } },
          settings: { ...makeRequest().settings, timeout: 25 },
        }),
      });
      void execution.then(
        () => { settlementCount += 1; },
        () => { settlementCount += 1; },
      );
      await waitForEnd(fixture.request);

      if (scenario.name === 'post-header body stall') timers.runReady();
      if (scenario.action === 'cancel') engine.cancel();
      else timers.advanceBy(25);
      timers.runReady();

      const failure = await captureFailure(execution);
      expect(failure.requestError.kind, scenario.name).toBe(scenario.action === 'cancel' ? 'cancelled' : 'timeout');
      fixture.request.emit('response', fixture.response);
      fixture.response.emit('end');
      await Promise.resolve();
      expect(settlementCount, scenario.name).toBe(1);
      expect(timers.pendingCount, scenario.name).toBe(0);
      expect(fixture.request.abortCalls, scenario.name).toBe(1);
      for (const eventName of ['redirect', 'login', 'response', 'error', 'close']) {
        expect(fixture.request.listenerCount(eventName), `${scenario.name}: ${eventName}`).toBe(0);
      }
      for (const eventName of ['data', 'error', 'end']) {
        expect(fixture.response.listenerCount(eventName), `${scenario.name}: response ${eventName}`).toBe(0);
      }
    }
  });

  test('preserves native abort, certificate, transport, and body errors', async () => {
    const nativeTimers = new DeterministicTimers();
    const nativeRequest = new FakeClientRequest();
    const nativeRuntime = createTestRuntimeAdapters({
      timers: nativeTimers,
      fetch: createFetchAdapter({}, nativeTimers),
      netRequest: () => nativeRequest,
    });
    const nativePromise = createEngine(nativeRuntime).execute({
      request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }),
    });
    await waitForEnd(nativeRequest);
    nativeRequest.emit('error', Object.assign(new Error('net::ERR_ABORTED'), { code: 'ERR_ABORTED' }));
    expect((await captureFailure(nativePromise)).requestError).toMatchObject({ kind: 'cancelled', code: 'ERR_ABORTED' });

    const cancellationTimers = new DeterministicTimers();
    let fetchStarted = false;
    const cancellableFetch: SessionFetchAdapter = async (_requestSession, _url, init) => {
      fetchStarted = true;
      return await new Promise((resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error('Expected cancellation signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const cancellationEngine = createEngine(createTestRuntimeAdapters({
      timers: cancellationTimers,
      fetch: cancellableFetch,
      netRequest: () => new FakeClientRequest(),
    }));
    const cancellationPromise = cancellationEngine.execute({ request: makeRequest() });
    for (let attempts = 0; attempts < 20 && !fetchStarted; attempts += 1) await Promise.resolve();
    expect(fetchStarted).toBe(true);
    cancellationEngine.cancel();
    expect((await captureFailure(cancellationPromise)).requestError).toMatchObject({ kind: 'cancelled' });

    const errors = [
      {
        error: new TypeError('fetch failed', {
          cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
        }),
        expected: { kind: 'certificate', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      },
      {
        error: new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
        expected: { kind: 'transport', code: 'ECONNREFUSED' },
      },
    ];
    for (const item of errors) {
      const timers = new DeterministicTimers();
      const fetch: SessionFetchAdapter = async () => { throw item.error; };
      const failure = await captureFailure(createEngine(createTestRuntimeAdapters({
        timers,
        fetch,
        netRequest: () => new FakeClientRequest(),
      })).execute({ request: makeRequest() }));
      expect(failure.requestError).toMatchObject(item.expected);
    }

    const bodyTimers = new DeterministicTimers();
    const bodyFixture = createNetResponseFixture({
      chunks: [{ data: 'prefix' }],
      termination: 'error',
      terminationError: new Error('socket closed during body'),
    }, bodyTimers);
    const bodyPromise = createEngine(createTestRuntimeAdapters({
      timers: bodyTimers,
      fetch: createFetchAdapter({}, bodyTimers),
      netRequest: bodyFixture.netRequest,
    })).execute({ request: makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }) });
    await waitForEnd(bodyFixture.request);
    bodyTimers.runAll();
    expect((await captureFailure(bodyPromise)).requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'Request failed: socket closed during body',
    });
  });

  test('keeps test filesystem writes inside its owned temp root', async () => {
    const fileSystem = new SafeTestFileSystem('C:/test-owned/restiprocity');
    const ownedPath = 'C:/test-owned/restiprocity/response.part';
    await fileSystem.writeFile(ownedPath, 'bytes');
    expect(fileSystem.has(ownedPath)).toBe(true);
    await expect(fileSystem.writeFile('C:/Users/example/response.bin', 'forbidden')).rejects.toThrow(
      'Test filesystem path escapes its owned temp root',
    );
  });
});
