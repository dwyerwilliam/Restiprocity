import { expect, test } from '@playwright/test';
import { computeProducerFingerprint, stableStringify } from '../../src/main/outputs/producerFingerprint';
import { RequestOutputService, type OutputBinding, type ProducerResult } from '../../src/main/outputs/requestOutputService';
import { TokenSourceError } from '../../src/main/outputs/tokenErrors';
import { defaultRequestOutputs } from '../../src/shared/requestOutputs';
import type { Request } from '../../src/shared/types';

class FakeClock {
  wall = 1_700_000_000_000;
  mono = 5_000;
  wallNow = () => this.wall;
  monotonicNow = () => this.mono;
  advance(ms: number) { this.wall += ms; this.mono += ms; }
}

const binding = (patch: Partial<OutputBinding> = {}): OutputBinding => ({
  requestId: 'login', environmentId: 'staging', fingerprint: 'f1', names: ['api_token'], refreshAfterSeconds: 3600, ...patch,
});

function counter(values: (n: number) => ProducerResult = n => ({ values: { api_token: `tok-${n}` } })) {
  let calls = 0;
  const run = async (_signal: AbortSignal) => values(++calls);
  return { run, calls: () => calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const signal = () => new AbortController().signal;

test.describe('freshness', () => {
  test('fresh until the interval, stale at exactly the interval', async () => {
    const clock = new FakeClock();
    const service = new RequestOutputService({ clock });
    const producer = counter();
    expect(await service.acquire(binding(), { signal: signal(), run: producer.run })).toEqual({ values: { api_token: 'tok-1' }, fromCache: false, generation: expect.any(Number) });
    clock.advance(3_599_999);
    expect((await service.acquire(binding(), { signal: signal(), run: producer.run })).fromCache).toBe(true);
    clock.advance(1);
    const refreshed = await service.acquire(binding(), { signal: signal(), run: producer.run });
    expect(refreshed).toMatchObject({ values: { api_token: 'tok-2' }, fromCache: false });
    expect(producer.calls()).toBe(2);
  });

  test('a shorter expires_in wins, less 10%', async () => {
    const clock = new FakeClock();
    const service = new RequestOutputService({ clock });
    const producer = counter(n => ({ values: { api_token: `tok-${n}` }, expiresInSeconds: 600 }));
    await service.acquire(binding(), { signal: signal(), run: producer.run });
    clock.advance(569_999);
    expect(service.peek(binding())).not.toBeNull();
    clock.advance(1);
    expect(service.peek(binding())).toBeNull();
  });

  test('a wall clock moved backwards, or monotonic time past the interval, means stale', async () => {
    const clock = new FakeClock();
    const service = new RequestOutputService({ clock });
    await service.acquire(binding(), { signal: signal(), run: counter().run });
    clock.wall -= 1;
    expect(service.peek(binding())).toBeNull();
    clock.wall += 1;
    expect(service.peek(binding())).not.toBeNull();
    clock.mono += 3_600_000;
    expect(service.peek(binding())).toBeNull();
  });

  test('a different fingerprint fetches again and never returns the old value', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const producer = counter();
    await service.acquire(binding(), { signal: signal(), run: producer.run });
    expect(service.peek(binding({ fingerprint: 'f2' }))).toBeNull();
    expect((await service.acquire(binding({ fingerprint: 'f2' }), { signal: signal(), run: producer.run })).values.api_token).toBe('tok-2');
    expect(service.peek(binding())).toBeNull();
  });

  test('environments never share a value', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const producer = counter();
    await service.acquire(binding(), { signal: signal(), run: producer.run });
    expect((await service.acquire(binding({ environmentId: 'production' }), { signal: signal(), run: producer.run })).values.api_token).toBe('tok-2');
    expect(producer.calls()).toBe(2);
  });
});

test.describe('sharing and cancelling a fetch', () => {
  test('two callers share one fetch', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const gate = deferred<ProducerResult>();
    let calls = 0;
    const run = () => { calls++; return gate.promise; };
    const first = service.acquire(binding(), { signal: signal(), run });
    const second = service.acquire(binding(), { signal: signal(), run });
    gate.resolve({ values: { api_token: 'tok-1' } });
    expect((await first).values).toEqual((await second).values);
    expect(calls).toBe(1);
  });

  test('one caller leaving keeps the fetch; the last one leaving aborts it', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const gate = deferred<ProducerResult>();
    let fetchSignal!: AbortSignal;
    const run = (s: AbortSignal) => { fetchSignal = s; return gate.promise; };
    const a = new AbortController();
    const b = new AbortController();
    const first = service.acquire(binding(), { signal: a.signal, run }).catch(error => error);
    const second = service.acquire(binding(), { signal: b.signal, run }).catch(error => error);
    a.abort();
    expect((await first).name).toBe('AbortError');
    expect(fetchSignal.aborted).toBe(false);
    b.abort();
    expect((await second).name).toBe('AbortError');
    expect(fetchSignal.aborted).toBe(true);
    gate.reject(fetchSignal.reason);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(service.status(binding()).state).toBe('empty');
  });

  test('unwound waits for a fetch nobody waits for, and leaves one another caller still needs', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const gate = deferred<ProducerResult>();
    const run = () => gate.promise;
    const a = new AbortController();
    const b = new AbortController();
    const first = service.acquire(binding(), { signal: a.signal, run }).catch(error => error);
    const second = service.acquire(binding(), { signal: b.signal, run });
    a.abort();
    await first;
    await service.unwound(binding());
    expect(service.status(binding()).state).toBe('fetching');

    const lone = new AbortController();
    const other = binding({ requestId: 'other' });
    const otherGate = deferred<ProducerResult>();
    const leaving = service.acquire(other, { signal: lone.signal, run: s => { s.addEventListener('abort', () => otherGate.reject(s.reason)); return otherGate.promise; } }).catch(error => error);
    lone.abort();
    await leaving;
    await service.unwound(other);
    expect(service.status(other).state).toBe('empty');

    gate.resolve({ values: { api_token: 'tok-1' } });
    await second;
    await service.unwound(binding());
    expect(service.status(binding()).state).toBe('fresh');
  });

  test('clear during a fetch rejects its callers and discards the late result', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const gate = deferred<ProducerResult>();
    let fetchSignal!: AbortSignal;
    const pending = service.acquire(binding(), { signal: signal(), run: s => { fetchSignal = s; return gate.promise; } }).catch(error => error);
    service.clear('login');
    expect(fetchSignal.aborted).toBe(true);
    gate.resolve({ values: { api_token: 'late' } });
    const error = await pending;
    expect(error).toBeInstanceOf(TokenSourceError);
    expect(error.code).toBe('TOKEN_SOURCE_FAILED');
    expect(service.peek(binding())).toBeNull();
  });

  test('an already aborted caller does not start a fetch', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const producer = counter();
    const controller = new AbortController();
    controller.abort();
    await expect(service.acquire(binding(), { signal: controller.signal, run: producer.run })).rejects.toThrow();
    expect(producer.calls()).toBe(0);
  });
});

test.describe('invalidate, seed, status and limits', () => {
  test('invalidate drops only the value of the generation it names', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const producer = counter();
    const first = await service.acquire(binding(), { signal: signal(), run: producer.run });
    service.invalidate(binding(), first.generation - 1);
    expect(service.peek(binding())).not.toBeNull();
    service.invalidate(binding(), first.generation);
    expect(service.peek(binding())).toBeNull();
    expect((await service.acquire(binding(), { signal: signal(), run: producer.run })).values.api_token).toBe('tok-2');
  });

  test('a failure leaves no value, reports failed, and the next acquire tries again', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const failing = async () => { throw new TokenSourceError('TOKEN_SOURCE_HTTP', 'Couldn\'t get {{api_token}}: "Login" returned HTTP 500.'); };
    await expect(service.acquire(binding(), { signal: signal(), run: failing })).rejects.toThrow(/HTTP 500/);
    expect(service.status(binding())).toEqual({
      requestId: 'login', environmentId: 'staging', names: ['api_token'], state: 'failed',
      error: { code: 'TOKEN_SOURCE_HTTP', message: 'Couldn\'t get {{api_token}}: "Login" returned HTTP 500.' },
    });
    expect((await service.acquire(binding(), { signal: signal(), run: counter().run })).values.api_token).toBe('tok-1');
    expect(service.status(binding()).state).toBe('fresh');
  });

  test('a seeded value is used by the next send', async () => {
    const clock = new FakeClock();
    const service = new RequestOutputService({ clock });
    service.seed(binding(), { values: { api_token: 'manual' }, expiresInSeconds: 100 });
    const producer = counter();
    expect(await service.acquire(binding(), { signal: signal(), run: producer.run })).toMatchObject({ values: { api_token: 'manual' }, fromCache: true });
    expect(producer.calls()).toBe(0);
    expect(service.status(binding())).toMatchObject({ state: 'fresh', fetchedAt: clock.wall, refreshAt: clock.wall + 90_000 });
    clock.advance(90_000);
    expect(service.status(binding()).state).toBe('stale');
  });

  test('status never contains a value and reports fetching', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    const gate = deferred<ProducerResult>();
    const pending = service.acquire(binding(), { signal: signal(), run: () => gate.promise });
    expect(service.status(binding()).state).toBe('fetching');
    gate.resolve({ values: { api_token: 'tok-secret' } });
    await pending;
    expect(JSON.stringify(service.status(binding()))).not.toContain('tok-secret');
  });

  test('keeps at most the configured number of entries, least recently used out first', async () => {
    const service = new RequestOutputService({ clock: new FakeClock(), maxEntries: 2 });
    const producer = counter();
    await service.acquire(binding({ requestId: 'a' }), { signal: signal(), run: producer.run });
    await service.acquire(binding({ requestId: 'b' }), { signal: signal(), run: producer.run });
    service.peek(binding({ requestId: 'a' }));
    await service.acquire(binding({ requestId: 'c' }), { signal: signal(), run: producer.run });
    expect(service.peek(binding({ requestId: 'a' }))).not.toBeNull();
    expect(service.peek(binding({ requestId: 'b' }))).toBeNull();
    expect(service.peek(binding({ requestId: 'c' }))).not.toBeNull();
  });

  test('clearAll forgets everything', async () => {
    const service = new RequestOutputService({ clock: new FakeClock() });
    await service.acquire(binding(), { signal: signal(), run: counter().run });
    service.clearAll();
    expect(service.status(binding()).state).toBe('empty');
  });
});

test.describe('fingerprint', () => {
  const saved: Request = {
    id: 'login', name: 'Login', method: 'POST', url: '{{auth}}/token', headers: [], parameters: [],
    body: { type: 'raw', raw: { language: 'json', content: '{"secret":"{{secret}}"}' } }, auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 0 }, scripts: {}, outputs: defaultRequestOutputs(), createdAt: 1, updatedAt: 1,
  };
  const resolved = { ...saved, url: 'https://auth.test/token', body: { type: 'raw' as const, raw: { language: 'json' as const, content: '{"secret":"s1"}' } } };

  test('is stable for equal input and ignores names and timestamps', () => {
    const one = computeProducerFingerprint({ saved, resolved, environmentId: 'staging' });
    expect(computeProducerFingerprint({ saved: { ...saved, name: 'Renamed', updatedAt: 9 }, resolved: { ...resolved }, environmentId: 'staging' })).toBe(one);
  });

  test('changes with a resolved value, the outputs or the environment', () => {
    const one = computeProducerFingerprint({ saved, resolved, environmentId: 'staging' });
    expect(computeProducerFingerprint({ saved, resolved: { ...resolved, body: { type: 'raw', raw: { language: 'json', content: '{"secret":"s2"}' } } }, environmentId: 'staging' })).not.toBe(one);
    expect(computeProducerFingerprint({ saved: { ...saved, outputs: { ...defaultRequestOutputs(), refreshAfterSeconds: 60 } }, resolved, environmentId: 'staging' })).not.toBe(one);
    expect(computeProducerFingerprint({ saved, resolved, environmentId: 'production' })).not.toBe(one);
  });

  test('stableStringify sorts keys at every level', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"e":2,"f":1}]},"b":1}');
  });
});
