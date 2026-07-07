import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CORE_ENVIRONMENT_ID, Request } from '../../src/shared/types';

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

      const engine = new RequestEngine(session as never, store);
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
});
