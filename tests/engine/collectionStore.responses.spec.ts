import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';

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
      version: 1,
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

function v2Response() {
  return {
    version: 2,
    id: 'response-v2',
    requestId: 'legacy',
    status: 204,
    statusText: 'No Content',
    headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
    preview: {
      kind: 'text',
      format: 'text',
      text: 'ok',
      parseState: 'valid',
      charset: 'utf-8',
      decodeError: false,
      capturedBytes: 2,
      totalBytes: 2,
      truncated: false,
      completeness: 'complete',
    },
    timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
    timestamp: 30,
    size: 2,
    cookies: [],
  };
}

async function readRequest(userDataPath: string, id: string): Promise<Record<string, any>> {
  const filePath = path.join(userDataPath, 'collections', `${id}.req.json`);
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<string, any>;
}

test.describe('CollectionStore response persistence', () => {
  test('purges legacy response snapshots on load and keeps v2 snapshots intact', async () => {
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
      expect(loaded?.lastResponse).toBeUndefined();
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

      expect(await readRequest(userDataPath, 'legacy')).not.toHaveProperty('lastResponse');

      const saved = await store.updateRequest('legacy', {
        name: 'Saved Request',
        lastResponse: v2Response() as any,
      });
      expect(saved.lastResponse).toMatchObject({ version: 2, preview: { kind: 'text', text: 'ok' } });
      expect(await readRequest(userDataPath, 'legacy')).toMatchObject({
        name: 'Saved Request',
        lastResponse: { version: 2, id: 'response-v2', requestId: 'legacy', status: 204, statusText: 'No Content' },
      });

      const duplicate = await store.duplicate('legacy');
      expect(duplicate.name).toBe('Saved Request (copy)');
      expect(duplicate.lastResponse).toMatchObject({ version: 2, preview: { kind: 'text', text: 'ok' } });
      expect(await readRequest(userDataPath, duplicate.id)).toMatchObject({
        name: 'Saved Request (copy)',
        lastResponse: { version: 2, preview: { kind: 'text', text: 'ok' } },
      });

      await store.import(legacyRequest('imported', 'Imported Request'));
      const imported = await store.getRequest('imported');
      expect(imported?.lastResponse).toBeUndefined();
      expect(await readRequest(userDataPath, 'imported')).toMatchObject({
        name: 'Imported Request',
      });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });
});
