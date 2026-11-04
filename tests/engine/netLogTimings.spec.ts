import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test } from '@playwright/test';
import type { Session } from 'electron';
import { parseNetLogConnectionTimings } from '../../src/main/engine/netLogTimings';
import { startNetLogCapture, type ConnectionTimingCapture } from '../../src/main/engine/netLogCapture';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import type { CollectionStore } from '../../src/main/stores/collectionStore';
import type { RequestRuntimeAdapterOverrides } from '../../src/main/engine/requestRuntimeAdapters';
import type { Request } from '../../src/shared/types';
import { createNetResponseFixture, DeterministicTimers } from './fixtures/httpResponseFixture';

// Fixtures are real Electron 39 captures, trimmed to event types, phases, times and source links
// (no addresses, URLs or headers). See tests/engine/fixtures/netlog/.
const fixtureDir = path.join(__dirname, 'fixtures', 'netlog');
const readFixture = (name: string) => fs.readFileSync(path.join(fixtureDir, name), 'utf8');

test.describe('parseNetLogConnectionTimings with real captures', () => {
  test('new HTTPS/h2 connection counts the racing QUIC job lookup, happy-eyeballs TCP attempts and TLS', () => {
    // DNS ran on the alternative QUIC job (25ms) while the TCP job waited; PAC (wpad) and network
    // quality estimator lookups in the same log are not part of the request.
    expect(parseNetLogConnectionTimings(readFixture('https-h2-new-connection.json')))
      .toEqual({ dns: 25, tcp: 25, tls: 46, connection: 'new-tcp' });
  });

  test('a request served by an existing h2 session is reused even though a QUIC session was opened in parallel', () => {
    expect(parseNetLogConnectionTimings(readFixture('https-h2-reused-with-racing-quic.json')))
      .toEqual({ dns: 0, tcp: 0, tls: 0, connection: 'reused' });
  });

  test('plain HTTP/1.1 distinguishes a new connection from a keep-alive reuse', () => {
    expect(parseNetLogConnectionTimings(readFixture('http1-new-connection.json')))
      .toEqual({ dns: 0, tcp: 0, tls: 0, connection: 'new-tcp' });
    expect(parseNetLogConnectionTimings(readFixture('http1-reused.json')))
      .toEqual({ dns: 0, tcp: 0, tls: 0, connection: 'reused' });
  });

  test('every redirect hop must be attributed; both hops reused the socket', () => {
    expect(parseNetLogConnectionTimings(readFixture('http1-redirect-reused.json')))
      .toEqual({ dns: 0, tcp: 0, tls: 0, connection: 'reused' });
  });

  test('an unfinalized log (cut off mid-events) is still read', () => {
    const complete = readFixture('https-h2-new-connection.json');
    const cut = complete.slice(0, complete.lastIndexOf(']'));
    expect(parseNetLogConnectionTimings(`${cut},\n`)).toEqual({ dns: 25, tcp: 25, tls: 46, connection: 'new-tcp' });
  });
});

const EVENT_TYPES = [
  'HTTP_STREAM_REQUEST', 'HTTP_STREAM_JOB_CONTROLLER_BOUND', 'HTTP_STREAM_REQUEST_BOUND_TO_JOB',
  'HTTP_STREAM_REQUEST_STARTED_JOB', 'BOUND_TO_QUIC_SESSION_POOL_JOB', 'HOST_RESOLVER_MANAGER_REQUEST',
  'QUIC_SESSION_POOL_JOB_CONNECT', 'QUIC_SESSION_CREATED', 'TCP_CONNECT',
] as const;
const SOURCE_TYPES = ['URL_REQUEST', 'HTTP_STREAM_JOB_CONTROLLER', 'HTTP_STREAM_JOB', 'QUIC_SESSION_POOL_DIRECT_JOB', 'QUIC_SESSION'] as const;
type SyntheticEvent = [time: number, source: [id: number, type: typeof SOURCE_TYPES[number]], type: typeof EVENT_TYPES[number],
  phase: 0 | 1 | 2, dependency?: [id: number, type: typeof SOURCE_TYPES[number]]];

function syntheticLog(events: SyntheticEvent[]): string {
  const sourceType = (name: typeof SOURCE_TYPES[number]) => SOURCE_TYPES.indexOf(name);
  return JSON.stringify({
    constants: {
      logEventTypes: Object.fromEntries(EVENT_TYPES.map((name, id) => [name, id])),
      logSourceType: Object.fromEntries(SOURCE_TYPES.map((name, id) => [name, id])),
      logEventPhase: { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 },
    },
    events: events.map(([time, [id, type], eventType, phase, dependency]) => ({
      time: String(time), source: { id, type: sourceType(type) }, type: EVENT_TYPES.indexOf(eventType), phase,
      ...(dependency ? { params: { source_dependency: { id: dependency[0], type: sourceType(dependency[1]) } } } : {}),
    })),
  });
}

test.describe('parseNetLogConnectionTimings graph rules', () => {
  test('a new QUIC session reports its handshake as TLS and no TCP', () => {
    expect(parseNetLogConnectionTimings(syntheticLog([
      [100, [1, 'URL_REQUEST'], 'HTTP_STREAM_REQUEST', 1],
      [100, [1, 'URL_REQUEST'], 'HTTP_STREAM_JOB_CONTROLLER_BOUND', 0, [2, 'HTTP_STREAM_JOB_CONTROLLER']],
      [101, [2, 'HTTP_STREAM_JOB_CONTROLLER'], 'HTTP_STREAM_REQUEST_STARTED_JOB', 0, [3, 'HTTP_STREAM_JOB']],
      [101, [3, 'HTTP_STREAM_JOB'], 'BOUND_TO_QUIC_SESSION_POOL_JOB', 0, [4, 'QUIC_SESSION_POOL_DIRECT_JOB']],
      [102, [4, 'QUIC_SESSION_POOL_DIRECT_JOB'], 'HOST_RESOLVER_MANAGER_REQUEST', 1],
      [112, [4, 'QUIC_SESSION_POOL_DIRECT_JOB'], 'HOST_RESOLVER_MANAGER_REQUEST', 2],
      [112, [4, 'QUIC_SESSION_POOL_DIRECT_JOB'], 'QUIC_SESSION_POOL_JOB_CONNECT', 1],
      [113, [4, 'QUIC_SESSION_POOL_DIRECT_JOB'], 'QUIC_SESSION_CREATED', 0, [5, 'QUIC_SESSION']],
      [142, [4, 'QUIC_SESSION_POOL_DIRECT_JOB'], 'QUIC_SESSION_POOL_JOB_CONNECT', 2],
      [143, [1, 'URL_REQUEST'], 'HTTP_STREAM_REQUEST_BOUND_TO_JOB', 0, [3, 'HTTP_STREAM_JOB']],
    ]))).toEqual({ dns: 10, tcp: 0, tls: 30, connection: 'new-quic' });
  });

  test('a stream that was never bound is not guessed at', () => {
    expect(parseNetLogConnectionTimings(syntheticLog([
      [100, [1, 'URL_REQUEST'], 'HTTP_STREAM_REQUEST', 1],
      [100, [1, 'URL_REQUEST'], 'HTTP_STREAM_JOB_CONTROLLER_BOUND', 0, [2, 'HTTP_STREAM_JOB_CONTROLLER']],
    ]))).toBeNull();
  });

  test('a bound job with no connect job and no reuse evidence is unrecognized, not "reused"', () => {
    expect(parseNetLogConnectionTimings(syntheticLog([
      [100, [1, 'URL_REQUEST'], 'HTTP_STREAM_REQUEST', 1],
      [105, [1, 'URL_REQUEST'], 'HTTP_STREAM_REQUEST_BOUND_TO_JOB', 0, [3, 'HTTP_STREAM_JOB']],
    ]))).toBeNull();
  });

  test('logs without requests, without constants, or not JSON yield null', () => {
    expect(parseNetLogConnectionTimings(syntheticLog([]))).toBeNull();
    expect(parseNetLogConnectionTimings(JSON.stringify({ events: [] }))).toBeNull();
    expect(parseNetLogConnectionTimings('not a net log')).toBeNull();
  });
});

test.describe('startNetLogCapture', () => {
  function fakeSession(netLog: Partial<Session['netLog']> | undefined) {
    return { netLog } as Pick<Session, 'netLog'>;
  }

  test('records to a temp file, parses it on finish, and deletes it', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restiprocity-netlog-test-'));
    let logPath = '';
    const capture = await startNetLogCapture(fakeSession({
      currentlyLogging: false,
      startLogging: async (filePath: string) => { logPath = filePath; },
      stopLogging: async () => { fs.writeFileSync(logPath, readFixture('http1-reused.json')); },
    }), () => tempRoot);

    expect(capture).not.toBeNull();
    expect(path.dirname(logPath)).toBe(tempRoot);
    const first = capture!.finish();
    expect(capture!.finish()).toBe(first);
    expect(await first).toEqual({ dns: 0, tcp: 0, tls: 0, connection: 'reused' });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('leaves a log someone else is recording alone, and survives start/stop failures', async () => {
    let started = false;
    expect(await startNetLogCapture(fakeSession({ currentlyLogging: true, startLogging: async () => { started = true; } }), os.tmpdir)).toBeNull();
    expect(started).toBe(false);
    expect(await startNetLogCapture(fakeSession(undefined), os.tmpdir)).toBeNull();
    expect(await startNetLogCapture(fakeSession({ currentlyLogging: false, startLogging: async () => { throw new Error('denied'); } }), os.tmpdir)).toBeNull();

    const capture = await startNetLogCapture(fakeSession({
      currentlyLogging: false,
      startLogging: async () => {},
      stopLogging: async () => { throw new Error('flush failed'); },
    }), os.tmpdir);
    expect(await capture!.finish()).toBeNull();
  });
});

test.describe('RequestEngine connection timings', () => {
  const now = 1_700_000_000_000;
  const request: Request = {
    id: 'timing-request', name: 'Timing request', method: 'GET', url: 'https://timing.example.test/',
    headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 1000, cookiesEnabled: true }, scripts: {}, createdAt: now, updatedAt: now,
  };

  function setup(overrides: RequestRuntimeAdapterOverrides, fixtureOptions: Parameters<typeof createNetResponseFixture>[0] = {}) {
    const timers = new DeterministicTimers();
    const fixture = createNetResponseFixture({ headers: { 'content-type': 'text/plain' }, chunks: [{ data: 'ok' }], ...fixtureOptions }, timers);
    const end = fixture.request.end.bind(fixture.request);
    fixture.request.end = () => {
      end();
      queueMicrotask(() => timers.runAll());
      return fixture.request;
    };
    const session = { allowNTLMCredentialsForDomains: () => {} } as unknown as Session;
    return new RequestEngine(session, { getActiveEnvironmentId: () => null } as CollectionStore, {
      clock: { wallNow: () => now, monotonicNow: () => timers.now },
      timers,
      netRequest: () => fixture.request,
      ...overrides,
    });
  }

  test('measured phases flow into the response timings', async () => {
    const engine = setup({ captureConnectionTimings: async () => ({ finish: async () => ({ dns: 3, tcp: 4, tls: 5, connection: 'new-tcp' }) }) });
    const response = await engine.executeV2({ request });
    expect(response.timings).toMatchObject({ dns: 3, tcp: 4, tls: 5, connection: 'new-tcp' });
  });

  test('unavailable or failing measurement is reported as unmeasured and never fails the send', async () => {
    for (const captureConnectionTimings of [
      async () => null,
      async () => { throw new Error('netLog unavailable'); },
      async () => ({ finish: async () => null }),
    ] satisfies RequestRuntimeAdapterOverrides['captureConnectionTimings'][]) {
      const response = await setup({ captureConnectionTimings }).executeV2({ request });
      expect(response.status).toBe(200);
      expect(response.timings).toMatchObject({ dns: 0, tcp: 0, tls: 0, connection: 'unmeasured' });
    }
  });

  test('the capture is stopped when the request fails before headers', async () => {
    let finishCalls = 0;
    const capture: ConnectionTimingCapture = { finish: async () => { finishCalls += 1; return null; } };
    const engine = setup({ captureConnectionTimings: async () => capture }, { emitResponse: false, termination: 'stall' });
    const sending = engine.executeV2({ request: { ...request, settings: { ...request.settings, timeout: 5 } } });
    await expect(sending).rejects.toBeTruthy();
    expect(finishCalls).toBe(1);
  });
});
