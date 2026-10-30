import { expect, test } from '@playwright/test';
import type { Session } from 'electron';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import type { Request } from '../../src/shared/types';
import type { NetRequestOptions, RequestRuntimeAdapterOverrides } from '../../src/main/engine/requestRuntimeAdapters';
import { createNetResponseFixture, DeterministicTimers } from './fixtures/httpResponseFixture';
import { getApiSession } from '../../src/main/engine/apiSession';
import { toPersistedResponseV2 } from '../../src/shared/responseContracts';

const now = 1_700_000_000_000;
const cookieLines = ['first=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly', 'first=two; Path=/other; Max-Age=60'];
const strictSession = { allowNTLMCredentialsForDomains: () => {} } as Session;
const insecureSession = { allowNTLMCredentialsForDomains: () => {} } as Session;

function makeRequest(): Request {
  return {
    id: 'cookie-request', name: 'Cookie request', method: 'GET', url: 'https://example.test/start',
    headers: [{ key: 'Cookie', value: 'authored=deliberate', enabled: true }], parameters: [],
    body: { type: 'none' }, auth: { type: 'bearer', bearer: { token: 'explicit-token' } },
    settings: { followRedirect: true, timeout: 1000, cookiesEnabled: false }, scripts: {}, createdAt: now, updatedAt: now,
  };
}

for (const enabled of [true, false, undefined]) {
  for (const legacy of [false, true]) {
    test(`cookie setting matrix ${String(enabled)} ${legacy ? 'legacy' : 'V2'}`, async () => {
      const { engine, options } = setup();
      const request = makeRequest();
      if (enabled === undefined) Reflect.deleteProperty(request.settings, 'cookiesEnabled');
      else request.settings.cookiesEnabled = enabled;
      const response = legacy ? await engine.execute({ request }) : await engine.executeV2({ request });
      expect(options[0]).toMatchObject({ useSessionCookies: enabled !== false, redirect: 'manual' });
      expect(options[0]).not.toHaveProperty('credentials');
      expect(response?.cookies).toHaveLength(2);
    });
  }
}

for (const enabled of [true, false, undefined]) {
  for (const legacy of [false, true]) {
    test(`fetch cookie credentials and complete observations ${String(enabled)} ${legacy ? 'legacy' : 'V2'}`, async () => {
      const calls: RequestInit[] = [];
      const headers = new Headers({ 'content-type': 'text/plain' });
      cookieLines.forEach((line) => headers.append('set-cookie', line));
      const { engine } = setup({ responseTransport: 'fetch', fetch: async (_session, _url, init) => {
        calls.push(init);
        const response = new globalThis.Response('ok', { headers });
        return { headers: response.headers, status: 200, statusText: 'OK', ok: true,
          url: 'https://fetch-final.test/folder/leaf', body: response.body,
          arrayBuffer: () => response.arrayBuffer(), json: () => response.json() };
      } });
      const request = makeRequest();
      if (enabled === undefined) Reflect.deleteProperty(request.settings, 'cookiesEnabled');
      else request.settings.cookiesEnabled = enabled;
      const response = legacy ? await engine.execute({ request }) : await engine.executeV2({ request });
      expect(calls[0]).toMatchObject({ credentials: enabled !== false ? 'include' : 'omit',
        headers: { cookie: 'authored=deliberate', authorization: 'Bearer explicit-token' } });
      expect(response?.cookies).toHaveLength(2);
      expect(response?.cookies[0]).toMatchObject({ domain: 'fetch-final.test', path: '/folder' });
    });
  }
}

for (const legacy of [false, true]) {
  for (const currentContext of [false, true]) {
    test(`cookie-disabled login remains available ${currentContext ? 'current' : 'manual'} ${legacy ? 'legacy' : 'V2'}`, async () => {
      const { engine, fixture, options } = setup();
      const callbacks: Array<readonly [string | undefined, string | undefined]> = [];
      const end = fixture.request.end.bind(fixture.request);
      fixture.request.end = () => {
        for (const isProxy of [false, true]) fixture.request.emit('login', { isProxy }, (username?: string, password?: string) => callbacks.push([username, password]));
        return end();
      };
      const request = makeRequest();
      request.auth = { type: 'ntlm', ntlm: { useCurrentAuthContext: currentContext, username: 'user', password: 'secret', domain: 'DOMAIN' } };
      if (legacy) await engine.execute({ request });
      else await engine.executeV2({ request });
      expect(callbacks).toEqual([currentContext ? [undefined, undefined] : ['DOMAIN\\user', 'secret'], [undefined, undefined]]);
      expect(options[0]).toMatchObject({ useSessionCookies: false });
      expect(options[0]).not.toHaveProperty('credentials');
    });
  }
}

test('cookie isolation uses named memory partitions and changes only the insecure verifier', () => {
  const partitions: Array<{ name: string; cache: boolean | undefined }> = [];
  const verified: string[] = [];
  const fromPartition: Parameters<typeof getApiSession>[1] = (name, options) => {
    partitions.push({ name, cache: options?.cache });
    return { setCertificateVerifyProc: () => verified.push(name) } as Session;
  };
  getApiSession(false, fromPartition);
  getApiSession(true, fromPartition);
  expect(partitions).toEqual([{ name: 'restiprocity-api', cache: false }, { name: 'restiprocity-api-insecure', cache: false }]);
  expect(verified).toEqual(['restiprocity-api-insecure']);
});

test('cookie isolation preserves strict OAuth token exchange without ambient cookies', async () => {
  const tokens: Array<{ session: Session; init: RequestInit }> = [];
  const { engine, options, fixture } = setup({ getInsecureSession: () => insecureSession, fetch: async (session, _url, init) => {
    tokens.push({ session, init });
    return new globalThis.Response(JSON.stringify({ access_token: 'issued-token' }));
  } });
  const request = makeRequest();
  request.settings.allowInsecureCertificates = true;
  request.auth = { type: 'oauth2', oauth2: { grantType: 'client_credentials', tokenUrl: 'https://auth.test/token',
    authorizationUrl: '', clientId: 'client', clientSecret: 'secret', scope: '', redirectUri: '' } };
  await engine.executeV2({ request });
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toMatchObject({ session: strictSession, init: { credentials: 'omit' } });
  expect(options[0].session).toBe(insecureSession);
  expect(fixture.request.headers.get('authorization')).toBe('Bearer issued-token');
});

test('cookie isolation provider failures reject without any fallback transport', async () => {
  const { engine, options } = setup({ getInsecureSession: () => { throw new Error('session unavailable'); } });
  const request = makeRequest();
  request.settings.allowInsecureCertificates = true;
  await expect(engine.executeV2({ request })).rejects.toMatchObject({ requestError: { rawMessage: 'session unavailable' } });
  expect(options).toEqual([]);
  expect(() => getApiSession(false, () => { throw new Error('strict session unavailable'); })).toThrow('strict session unavailable');
});

test('malformed cookie observations do not fail a response or leak into durable snapshots', async () => {
  const { engine, fixture } = setup();
  fixture.response.headers['set-cookie'] = ['invalid', 'id=one, other=two', 'live=secret; Path=/'];
  const response = await engine.executeV2({ request: makeRequest() });
  expect(response.status).toBe(200);
  expect(response.cookies.map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'live', value: 'secret' }]);
  const persisted = toPersistedResponseV2(response);
  expect(persisted.cookies).toEqual([]);
  expect(persisted.headers.some(({ key }) => key.toLowerCase() === 'set-cookie')).toBe(false);
  expect(response.headers.filter(({ key }) => key === 'set-cookie')).toHaveLength(3);
});

function setup(overrides: RequestRuntimeAdapterOverrides = {}) {
  const timers = new DeterministicTimers();
  const fixture = createNetResponseFixture({
    headers: { 'content-type': 'text/plain', 'set-cookie': cookieLines },
    redirect: { statusCode: 302, method: 'GET', url: 'https://final.example.test/folder/leaf',
      headers: { 'set-cookie': ['intermediate=hidden'] } },
  }, timers);
  const options: NetRequestOptions[] = [];
  const end = fixture.request.end.bind(fixture.request);
  fixture.request.end = () => {
    end();
    queueMicrotask(() => timers.runAll());
    return fixture.request;
  };
  const engine = new RequestEngine(strictSession, {
    getActiveEnvironmentId: () => null,
  } as CollectionStore, {
    clock: { wallNow: () => now, monotonicNow: () => timers.now },
    timers,
    netRequest: (next) => { options.push(next); return fixture.request; },
    ...overrides,
  });
  return { engine, options, fixture };
}

for (const legacy of [false, true]) {
  test(`native cookie controls preserve explicit headers and final observations ${legacy ? 'legacy' : 'V2'}`, async () => {
    const { engine, options, fixture } = setup();
    const request = makeRequest();
    request.auth = { type: 'ntlm', ntlm: { useCurrentAuthContext: true } };
    request.headers.push({ key: 'Authorization', value: 'Bearer explicit-token', enabled: true });

    const response = legacy ? await engine.execute({ request }) : await engine.executeV2({ request });

    expect(options[0]).toMatchObject({ session: strictSession, useSessionCookies: false });
    expect(options[0]).not.toHaveProperty('credentials');
    expect(fixture.request.headers.get('cookie')).toBe('authored=deliberate');
    expect(fixture.request.headers.get('authorization')).toBe('Bearer explicit-token');
    expect(response?.cookies).toEqual([
      { name: 'first', value: 'one', domain: 'final.example.test', path: '/folder',
        expires: Date.parse('Wed, 21 Oct 2037 07:28:00 GMT'), httpOnly: true, secure: false, sameSite: 'lax' },
      { name: 'first', value: 'two', domain: 'final.example.test', path: '/other',
        expires: now + 60000, httpOnly: false, secure: false, sameSite: 'lax' },
    ]);
  });
}
