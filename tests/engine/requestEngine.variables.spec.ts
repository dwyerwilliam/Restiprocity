import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CORE_ENVIRONMENT_ID, Request } from '../../src/shared/types';
import type { Session } from 'electron';
import type { RequestRuntimeAdapterOverrides } from '../../src/main/engine/requestRuntimeAdapters';
import { createNetResponseFixture, DeterministicTimers } from './fixtures/httpResponseFixture';

function makeRequest(url: string): Request {
  const now = Date.now();

  return {
    id: 'req-env',
    name: 'Environment request',
    method: 'GET',
    url,
    headers: [{ key: 'x-token', value: '{{token}}', enabled: true }],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
  };
}

test.describe('RequestEngine environment interpolation', () => {
  test('resolves URL shorthand and template variables from the active environment chain before fetch', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-request-engine-'));
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const session = {
      setCertificateVerifyProc: () => {},
      fetch: async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return new globalThis.Response('ok', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/plain' },
        });
      },
    };

    try {
      const store = new CollectionStore(userDataPath);
      await store.init();
      await store.updateEnvironment(CORE_ENVIRONMENT_ID, {
        variables: [
          { key: 'host', value: 'api.example.test', type: 'standard' },
          { key: 'token', value: 'core-token', type: 'standard' },
        ],
      });
      const child = await store.createEnvironment({
        name: 'Local',
        parentId: CORE_ENVIRONMENT_ID,
        variables: [{ key: 'token', value: 'child-token', type: 'standard' }],
      });

      const engine = new RequestEngine(session as never, store, { responseTransport: 'fetch' });
      await engine.execute({ request: makeRequest('https://_.host/users?token={{token}}'), environmentId: child.id });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('https://api.example.test/users?token=child-token');
      expect(fetchCalls[0].init.headers).toMatchObject({
        'x-token': 'child-token',
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('resolves raw and form body fields from the active environment chain before fetch', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-request-engine-'));
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const session = {
      setCertificateVerifyProc: () => {},
      fetch: async (url: string, init: RequestInit) => {
        fetchCalls.push({ url, init });
        return new globalThis.Response('ok', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/plain' },
        });
      },
    };

    try {
      const store = new CollectionStore(userDataPath);
      await store.init();
      await store.updateEnvironment(CORE_ENVIRONMENT_ID, {
        variables: [
          { key: 'host', value: 'api.example.test', type: 'standard' },
          { key: 'token', value: 'core-token', type: 'standard' },
        ],
      });
      const child = await store.createEnvironment({
        name: 'Local',
        parentId: CORE_ENVIRONMENT_ID,
        variables: [{ key: 'token', value: 'child-token', type: 'standard' }],
      });

      const engine = new RequestEngine(session as never, store, { responseTransport: 'fetch' });

      await engine.execute({
        request: {
          ...makeRequest('https://example.test/raw'),
          method: 'POST',
          body: {
            type: 'raw',
            raw: {
              language: 'text',
              content: 'message={{token}} host=_.host',
            },
          },
        },
        environmentId: child.id,
      });

      await engine.execute({
        request: {
          ...makeRequest('https://example.test/form'),
          method: 'POST',
          body: {
            type: 'form-urlencoded',
            form: [
              { key: 'token', value: '{{token}}', enabled: true },
              { key: 'host', value: '_.host', enabled: true },
            ],
          },
        },
        environmentId: child.id,
      });

      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0].init.body).toBe('message=child-token host=api.example.test');
      expect(fetchCalls[1].init.body).toBe('token=child-token&host=api.example.test');
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});

for (const transport of ['fetch', 'net', 'legacy'] as const) {
  for (const bodyType of ['raw', 'form-urlencoded', 'multipart'] as const) {
    test(`per-send built-in context ${transport} ${bodyType}`, async () => {
      const timers = new DeterministicTimers();
      const calls: Array<{ url: string; headers: unknown; body: unknown }> = [];
      const counts = { uuid: 0, randomInt: 0 };
      const readPaths: string[] = [];
      const logins: Array<readonly [string | undefined, string | undefined]> = [];
      const store = {
        getActiveEnvironmentId: () => 'child',
        getEnvironment: async (id: string) => ({
          id, name: id, parentId: id === 'child' ? 'parent' : 'child',
          variables: [
            { key: 'ordinary', value: id }, { key: 'uuid', value: 'collision' },
            { key: 'timestamp', value: 'collision' }, { key: 'randomInt', value: 'collision' },
          ],
        }),
      };
      const runtime: RequestRuntimeAdapterOverrides = {
        responseTransport: 'fetch',
        uuid: () => `00000000-0000-4000-8000-${String(++counts.uuid).padStart(12, '0')}`,
        randomInt: () => ++counts.randomInt,
        clock: { wallNow: () => 1700000000000, monotonicNow: () => timers.now },
        fetch: async (_session, url, init) => {
          calls.push({ url, headers: init.headers, body: init.body });
          return new globalThis.Response('ok', { headers: { 'content-type': 'text/plain' } });
        },
        netRequest: (options) => {
          const fixture = createNetResponseFixture({ headers: { 'content-type': 'text/plain' } }, timers);
          const end = fixture.request.end.bind(fixture.request);
          fixture.request.end = (body?: string | Buffer) => {
            calls.push({ url: options.url, headers: Object.fromEntries(fixture.request.headers), body });
            fixture.request.emit('login', { scheme: 'ntlm' }, (username?: string, password?: string) => {
              logins.push([username, password]);
            });
            end();
            queueMicrotask(() => timers.runAll());
            return fixture.request;
          };
          return fixture.request;
        },
        fileSystem: {
          readFile: async (filePath) => { readPaths.push(filePath); return 'file-content'; },
          writeFile: async () => {}, mkdir: async () => {}, rename: async () => {}, rm: async () => {},
        },
      };
      const token = '{{uuid}}/{{ timestamp }}/{{randomInt}}/{{ordinary}}';
      const request: Request = {
        ...makeRequest(`https://example.test/${token}`), method: 'POST',
        headers: [{ key: 'x-identity', value: token, enabled: true }],
        parameters: [{ key: 'identity', value: token, enabled: true }],
        auth: transport === 'net' ? { type: 'ntlm', ntlm: { useCurrentAuthContext: false, username: '{{uuid}}', password: '{{uuid}}' } }
          : { type: 'bearer', bearer: { token: '{{uuid}}' } },
        body: { type: bodyType, raw: { language: 'text', content: token },
          form: [{ key: 'identity', value: token, enabled: true }],
          multipart: [{ key: 'identity', value: token, type: 'text', enabled: true },
            { key: 'file', value: '', filePath: '/{{uuid}}.txt', type: 'file', enabled: true }] },
      };
      const original = JSON.stringify(request);
      const engine = new RequestEngine({ allowNTLMCredentialsForDomains: () => {} } as Session, store, runtime);

      for (let send = 1; send <= 2; send += 1) {
        if (transport === 'legacy') await engine.execute({ request });
        else await engine.executeV2({ request });
        const uuid = `00000000-0000-4000-8000-${String(send).padStart(12, '0')}`;
        const identity = `${uuid}/1700000000000/${send}/child`;
        const call = calls[send - 1];
        if (transport === 'net') expect(logins[send - 1]).toEqual([uuid, uuid]);
        expect(new URL(call.url).pathname).toBe(`/${identity}`);
        expect(new URL(call.url).searchParams.get('identity')).toBe(identity);
        expect(call.headers).toMatchObject({ 'x-identity': identity,
          ...(transport === 'net' ? {} : { authorization: `Bearer ${uuid}` }) });
        const body = String(call.body);
        expect(bodyType === 'form-urlencoded' ? new URLSearchParams(body).get('identity') : body).toContain(identity);
        if (bodyType === 'multipart') expect(readPaths[send - 1]).toBe(`/${uuid}.txt`);
      }
      expect(counts).toEqual({ uuid: 2, randomInt: 2 });
      expect(JSON.stringify(request)).toBe(original);
    });
  }
}

test('built-ins with missing environment preserve unknown and malformed tokens after failed send', async () => {
  const urls: string[] = [];
  let generation = 0;
  const engine = new RequestEngine({} as Session, {
    getActiveEnvironmentId: () => null,
    getEnvironment: async (id: string) => id === 'empty' ? { id, name: id, variables: [] } : null,
  }, {
    responseTransport: 'fetch',
    uuid: () => `identity-${++generation}`, randomInt: () => generation,
    fetch: async (_session, url) => {
      urls.push(url);
      if (urls.length === 1) throw new Error('injected transport failure');
      return new globalThis.Response('ok', { headers: { 'content-type': 'text/plain' } });
    },
  });
  const request = makeRequest('https://example.test/{{uuid}}?unknown={{unknown}}&bad={{bad token}}');
  await expect(engine.executeV2({ request, environmentId: 'missing' })).rejects.toThrow();
  await engine.executeV2({ request });
  await engine.executeV2({ request, environmentId: 'empty' });
  expect(urls).toEqual([1, 2, 3].map((value) =>
    `https://example.test/identity-${value}?unknown={{unknown}}&bad={{bad token}}`));
  expect(generation).toBe(3);
});
