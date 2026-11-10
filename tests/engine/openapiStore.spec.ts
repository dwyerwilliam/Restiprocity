import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCollectionFile } from '../../src/main/ipc/collectionFileActions';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import type { RequestGroupNode } from '../../src/shared/types';

const ok = { '200': { description: 'ok' } };
const document = {
  openapi: '3.0.3',
  info: { title: 'Store API', version: '1' },
  servers: [{ url: 'https://api.example.test/v1' }],
  paths: {
    '/health': { get: { summary: 'Health', tags: ['Status'], responses: ok } },
    '/pets': { post: { summary: 'Create pet', requestBody: { content: { 'application/json': { example: { name: 'Milo' } } } }, responses: ok } },
  },
};

async function withStore(run: (store: CollectionStore, directory: string) => Promise<void>, files?: ConstructorParameters<typeof CollectionStore>[1]): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openapi-store-'));
  try {
    const store = new CollectionStore(directory, files);
    await store.init();
    await run(store, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[path.relative(directory, full).replaceAll('\\', '/')] = (await fs.readFile(full)).toString('base64');
    }
  };
  await walk(directory);
  return files;
}

async function seed(store: CollectionStore): Promise<void> {
  await store.createGroup({ name: 'Existing folder', children: [] });
  await store.createRequest({ name: 'Existing', method: 'GET', url: 'https://existing.example.test', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 30000 }, scripts: {} });
  await store.createEnvironment({ name: 'Staging', parentId: 'core', variables: [{ key: 'base', value: 'https://staging.example.test', type: 'standard' }] });
  await store.saveSettings({ theme: 'light', fontSize: 15 });
}

test('import into a populated store preserves prior records, order, and settings, and survives reopening', async () => {
  await withStore(async (store, directory) => {
    await seed(store);
    const before = await snapshot(directory);
    const priorRoots = (await store.listAll()).map(item => item.id);
    const settings = await store.getSettings();
    const result = await store.importBundle(document);
    expect(result).toMatchObject({ requests: 2, groups: 2, environments: 1 });
    const after = await snapshot(directory);
    for (const [file, bytes] of Object.entries(before)) expect(after[file], file).toBe(bytes);
    expect(await store.getSettings()).toEqual(settings);
    expect(settings).toMatchObject({ activeEnvironmentId: 'core', theme: 'light', fontSize: 15 });

    const reopened = new CollectionStore(directory);
    await reopened.init();
    const items = await reopened.listAll();
    const root = items.find(item => item.name === 'Store API') as RequestGroupNode;
    expect(JSON.parse(await fs.readFile(path.join(directory, 'collections', '.root-order.json'), 'utf8'))).toEqual([...priorRoots, root.id]);
    const byId = new Map(items.map(item => [item.id, item]));
    expect(root.children.map(id => byId.get(id)?.name)).toEqual(['Status', 'Create pet']);
    const status = byId.get(root.children[0]) as RequestGroupNode;
    expect(status.children.map(id => byId.get(id)?.name)).toEqual(['Health']);
    expect(byId.get(root.children[1])).toMatchObject({ method: 'POST', url: '{{openapi_server_1}}/pets', parentId: root.id, body: { type: 'raw', raw: { language: 'json', content: '{\n  "name": "Milo"\n}' } } });
    const imported = (await reopened.listEnvironments()).find(environment => environment.name === 'Store API (OpenAPI)');
    expect(imported).toMatchObject({ parentId: 'core', variables: [{ key: 'openapi_server_1', value: 'https://api.example.test/v1', type: 'standard' }] });
    expect((await reopened.getSettings()).activeEnvironmentId).toBe('core');
  });
});

test('repeated OpenAPI imports get disjoint IDs and independent environments', async () => {
  await withStore(async store => {
    await store.importBundle(document);
    await store.importBundle(document);
    const requests = (await store.listAll()).filter(item => !('children' in item));
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map(item => item.id)).size).toBe(4);
    const environments = (await store.listEnvironments()).filter(item => item.name === 'Store API (OpenAPI)');
    expect(environments).toHaveLength(2);
    expect(new Set(environments.map(item => item.id)).size).toBe(2);
    expect((await store.getSettings()).activeEnvironmentId).toBe('core');
  });
});

test('a failed environment install after requests land restores every file byte for byte', async () => {
  let failing = false;
  const files = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    unlink: fs.unlink,
    rename: async (from: string | Buffer | URL, to: string | Buffer | URL) => {
      if (failing && path.basename(path.dirname(String(to))) === 'environments') {
        failing = false;
        throw new Error('disk full');
      }
      return fs.rename(from, to);
    },
  };
  await withStore(async (store, directory) => {
    await seed(store);
    const before = await snapshot(directory);
    failing = true;
    await expect(store.importBundle(document)).rejects.toThrow('original collection files were restored');
    expect(failing).toBe(false);
    expect(await snapshot(directory)).toEqual(before);
  }, files);
});

test('malformed, limit, and reference failures write nothing', async () => {
  await withStore(async (store, directory) => {
    await seed(store);
    const before = await snapshot(directory);
    const manyValues = { ...document, 'x-values': Array.from({ length: 100_000 }, () => 0) };
    const bigExamplePaths: Record<string, unknown> = {};
    for (let index = 0; index < 17; index += 1) bigExamplePaths['/r' + index] = { post: { requestBody: { content: { 'text/plain': { examples: { big: { $ref: '#/components/examples/big' } } } } }, responses: ok } };
    const failures: Array<[unknown, string]> = [
      [{ ...document, openapi: '3.2.0' }, 'Only OpenAPI 3.0.x and 3.1.x documents are supported'],
      [{ ...document, paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Missing' }], responses: ok } } } }, 'points to a missing component'],
      [{ ...document, paths: { '/x': { post: { requestBody: { $ref: 'https://specs.example.test/bodies.yaml#/Pet' }, responses: ok } } } }, 'is external or unsupported'],
      [{ ...document, paths: { '/x': { get: { parameters: [{ name: 'a', in: 'query' }, { name: 'a', in: 'query' }], responses: ok } } } }, 'duplicate query parameter'],
      [manyValues, 'more than 100,000 values'],
      [{ ...document, components: { examples: { big: { value: 'x'.repeat(1_000_000) } } }, paths: bigExamplePaths }, 'larger than the 16 MiB import limit'],
      [parseCollectionFile("openapi: 3.0.3\ninfo: {title: Y, version: '1'}\nx-loop: &loop\n  self: *loop\npaths:\n  /a: {get: {responses: {'200': {description: ok}}}}\n"), 'cyclic object graph'],
    ];
    for (const [input, message] of failures) {
      await expect(store.importBundle(input), message).rejects.toThrow(message);
      expect(await snapshot(directory)).toEqual(before);
    }
  });
});
