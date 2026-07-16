import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { RESPONSE_PREVIEW_MAX_BYTES } from '../../src/shared/responseLimits';

const LEGACY_BODY = 'legacy-response-'.repeat(180_000);

function legacyRequest(id: string, name: string) {
  return {
    id,
    type: 'request',
    name,
    method: 'POST',
    url: 'https://example.test/persist',
    headers: [{ key: 'X-Unrelated', value: 'preserved', enabled: false }],
    parameters: [{ key: 'page', value: '2', enabled: true }],
    body: { type: 'raw', raw: { language: 'json', content: '{"request":true}' } },
    auth: { type: 'none' },
    settings: { followRedirect: false, timeout: 12_345, cookiesEnabled: false },
    scripts: { preRequest: 'console.log("preserved")' },
    parentId: 'group-1',
    createdAt: 10,
    updatedAt: 20,
    lastResponse: {
      id: `response-${id}`,
      requestId: id,
      status: 201,
      statusText: 'Created',
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: LEGACY_BODY,
      timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
      timestamp: 30,
      size: LEGACY_BODY.length,
      cookies: [],
      destinationPath: 'C:\\unsafe\\response.json',
      progress: { receivedBytes: LEGACY_BODY.length },
      bytes: [1, 2, 3],
    },
  };
}

function expectBoundedPersistedResponse(request: Record<string, any>) {
  const response = request.lastResponse;
  expect(response.version).toBe(2);
  expect(response.body).toBeUndefined();
  expect(response.destinationPath).toBeUndefined();
  expect(response.progress).toBeUndefined();
  expect(response.bytes).toBeUndefined();
  expect(response.preview.kind).toBe('text');
  expect(new TextEncoder().encode(response.preview.text).byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
}

async function readRequest(userDataPath: string, id: string): Promise<Record<string, any>> {
  const filePath = path.join(userDataPath, 'collections', `${id}.req.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, any>;
}

test.describe('CollectionStore response persistence', () => {
  test('bounds legacy responses across load duplicate import and save', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-response-store-'));
    const collectionsPath = path.join(userDataPath, 'collections');

    try {
      await fs.mkdir(collectionsPath, { recursive: true });
      await fs.writeFile(
        path.join(collectionsPath, 'legacy.req.json'),
        JSON.stringify(legacyRequest('legacy', 'Legacy Request'), null, 2),
        'utf-8',
      );

      const store = new CollectionStore(userDataPath);
      const loaded = await store.getRequest('legacy');

      expect(loaded).not.toBeNull();
      expect(new TextEncoder().encode(loaded?.lastResponse?.body ?? '').byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
      expect(loaded).toMatchObject({
        id: 'legacy',
        name: 'Legacy Request',
        method: 'POST',
        url: 'https://example.test/persist',
        headers: [{ key: 'X-Unrelated', value: 'preserved', enabled: false }],
        parameters: [{ key: 'page', value: '2', enabled: true }],
        settings: { followRedirect: false, timeout: 12_345, cookiesEnabled: false },
        parentId: 'group-1',
        createdAt: 10,
      });

      const saved = await store.updateRequest('legacy', {
        name: 'Saved Request',
        lastResponse: legacyRequest('legacy', 'Legacy Request').lastResponse as any,
      });
      expect(new TextEncoder().encode(saved.lastResponse?.body ?? '').byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
      expectBoundedPersistedResponse(await readRequest(userDataPath, 'legacy'));

      const duplicate = await store.duplicate('legacy');
      expect(duplicate.name).toBe('Saved Request (copy)');
      expect(new TextEncoder().encode(duplicate.lastResponse.body).byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
      expectBoundedPersistedResponse(await readRequest(userDataPath, duplicate.id));

      await store.import(legacyRequest('imported', 'Imported Request'));
      const imported = await store.getRequest('imported');
      expect(new TextEncoder().encode(imported?.lastResponse?.body ?? '').byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
      expectBoundedPersistedResponse(await readRequest(userDataPath, 'imported'));
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
