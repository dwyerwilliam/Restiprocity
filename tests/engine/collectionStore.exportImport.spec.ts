import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CollectionImportError } from '../../src/main/stores/collectionExport';
import type { CollectionFileOperations } from '../../src/main/stores/collectionMutation';
import type { CollectionExportBundle, Request, RequestGroupNode } from '../../src/shared/types';

const requestDefaults = {
  method: 'GET', url: '', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
  settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true }, scripts: {},
} satisfies Omit<Request, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

const lastResponse = {
  version: 2, id: 'resp', requestId: 'leaf', status: 200, statusText: 'OK', headers: [],
  preview: { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'complete' },
  timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 }, timestamp: 1, size: 0, cookies: [],
};

/** root order: [outer, loose]; outer → [inner, sibling]; inner → [leaf]. */
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-export-'));
  const collections = path.join(directory, 'collections');
  await fs.mkdir(collections);
  const records = {
    'outer.grp.json': { id: 'outer', name: 'Outer', children: ['inner', 'sibling'], auth: { type: 'bearer', bearer: { token: 't', prefix: '' } }, createdAt: 1, updatedAt: 1 },
    'inner.grp.json': { id: 'inner', name: 'Inner', parentId: 'outer', children: ['leaf'], createdAt: 1, updatedAt: 1 },
    'leaf.req.json': { ...requestDefaults, id: 'leaf', name: 'Leaf', method: 'POST', url: 'https://api.test/{{path}}', parentId: 'inner',
      headers: [{ key: 'X-Trace', value: '1', enabled: false }], body: { type: 'raw', raw: { language: 'json', content: '{"a":1}' } },
      auth: { type: 'basic', basic: { username: 'u', password: 'p' } }, lastResponse, createdAt: 1, updatedAt: 1 },
    'sibling.req.json': { ...requestDefaults, id: 'sibling', name: 'Sibling', parentId: 'outer', createdAt: 1, updatedAt: 1 },
    'loose.req.json': { ...requestDefaults, id: 'loose', name: 'Loose', createdAt: 1, updatedAt: 1 },
  };
  for (const [name, record] of Object.entries(records)) await fs.writeFile(path.join(collections, name), JSON.stringify(record) + '\n');
  await fs.writeFile(path.join(collections, '.root-order.json'), JSON.stringify(['outer', 'loose']) + '\n');
  return { directory, collections };
}

async function freshStore(files?: CollectionFileOperations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-import-'));
  await fs.mkdir(path.join(directory, 'collections'));
  return { directory, store: new CollectionStore(directory, files) };
}

/** Rebuilds the tree as names so ID remapping doesn't matter. */
async function treeOf(store: CollectionStore) {
  const items = await store.listAll();
  const byId = new Map(items.map((item) => [item.id, item]));
  const childIds = new Set(items.flatMap((item) => ('children' in item ? item.children : [])));
  const describe = (id: string): unknown => {
    const item = byId.get(id)!;
    return 'type' in item && item.type === 'group'
      ? { group: item.name, children: (item as RequestGroupNode).children.map(describe) }
      : item.name;
  };
  return items.filter((item) => !childIds.has(item.id)).map((item) => describe(item.id));
}

test('exporting the whole collection keeps folder nesting and order, and drops response data', async () => {
  const { directory } = await fixture();
  const bundle = await new CollectionStore(directory).exportBundle();

  expect(bundle).toMatchObject({ format: 'restiprocity.collection', version: 1, roots: ['outer', 'loose'] });
  expect(bundle.groups.map(({ id, children }) => ({ id, children }))).toEqual([
    { id: 'outer', children: ['inner', 'sibling'] },
    { id: 'inner', children: ['leaf'] },
  ]);
  expect(bundle.requests.map(({ id }) => id).sort()).toEqual(['leaf', 'loose', 'sibling']);
  expect(bundle.requests.some((request) => 'lastResponse' in request)).toBe(false);
  expect(bundle.groups.some((group) => 'type' in group)).toBe(false);
});

test('exporting a folder includes only its subtree; exporting a request includes only it', async () => {
  const { directory } = await fixture();
  const store = new CollectionStore(directory);

  const folder = await store.exportBundle('inner');
  expect(folder.roots).toEqual(['inner']);
  expect(folder.groups.map(({ id }) => id)).toEqual(['inner']);
  expect(folder.requests.map(({ id }) => id)).toEqual(['leaf']);

  const single = await store.exportBundle('loose');
  expect(single).toMatchObject({ roots: ['loose'], groups: [] });
  expect(single.requests.map(({ id }) => id)).toEqual(['loose']);

  await expect(store.exportBundle('missing')).rejects.toThrow('Item missing not found');
});

test('import round-trips through JSON into a fresh collection with new IDs and identical content', async () => {
  const { directory } = await fixture();
  const bundle = JSON.parse(JSON.stringify(await new CollectionStore(directory).exportBundle()));
  const { store } = await freshStore();

  expect(await store.importBundle(bundle)).toEqual({ requests: 3, groups: 2, environments: 0, warnings: [] });
  expect(await treeOf(store)).toEqual([{ group: 'Outer', children: [{ group: 'Inner', children: ['Leaf'] }, 'Sibling'] }, 'Loose']);

  const items = await store.listAll();
  expect(items.map((item) => item.id)).not.toContain('leaf');
  const leaf = items.find((item) => item.name === 'Leaf') as Request;
  const inner = items.find((item) => item.name === 'Inner') as RequestGroupNode;
  const outer = items.find((item) => item.name === 'Outer') as RequestGroupNode;
  expect(leaf.parentId).toBe(inner.id);
  expect(inner.parentId).toBe(outer.id);
  expect(outer.parentId).toBeUndefined();
  expect(outer.auth).toEqual({ type: 'bearer', bearer: { token: 't', prefix: '' } });
  expect(leaf).toMatchObject({
    method: 'POST', url: 'https://api.test/{{path}}', headers: [{ key: 'X-Trace', value: '1', enabled: false }],
    body: { type: 'raw', raw: { language: 'json', content: '{"a":1}' } }, auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
  });
  expect(leaf.lastResponse).toBeUndefined();
});

test('importing the same file twice appends a second copy after the existing root order', async () => {
  const { directory, collections } = await fixture();
  const store = new CollectionStore(directory);
  const bundle = await store.exportBundle('inner');

  await store.importBundle(bundle);
  const order = JSON.parse(await fs.readFile(path.join(collections, '.root-order.json'), 'utf8')) as string[];
  expect(order.slice(0, 2)).toEqual(['outer', 'loose']);
  expect(order).toHaveLength(3);
  expect(await treeOf(store)).toEqual([
    { group: 'Outer', children: [{ group: 'Inner', children: ['Leaf'] }, 'Sibling'] },
    'Loose',
    { group: 'Inner', children: ['Leaf'] },
  ]);
});

function bundleWith(overrides: Partial<CollectionExportBundle> & Record<string, unknown>): unknown {
  return { format: 'restiprocity.collection', version: 1, exportedAt: '', roots: [], groups: [], requests: [], ...overrides };
}

test('malformed or foreign files are rejected with a specific message and write nothing', async () => {
  const { directory, store } = await freshStore();
  const cases: [unknown, string][] = [
    [{ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }, 'looks like a Postman export'],
    [{ _type: 'export', resources: [] }, 'Re-export it from a current version of Insomnia'],
    [{ hello: 'world' }, 'not a Restiprocity or Insomnia collection export'],
    [bundleWith({ version: 2 }), 'format version 2'],
    [bundleWith({ roots: ['ghost'] }), 'refers to an item it does not contain'],
    [bundleWith({ roots: ['a', 'a'], requests: [{ ...requestDefaults, id: 'a', name: 'A' } as never] }), 'same item in more than one place'],
    [bundleWith({ roots: ['g'], groups: [{ id: 'g', name: 'Loop', children: ['g'] } as never] }), 'same item in more than one place'],
    [bundleWith({ requests: [{ ...requestDefaults, id: 'a', name: 'A', method: 'TRACE' } as never] }), 'unsupported method'],
    [bundleWith({ requests: [{ ...requestDefaults, id: 'a', name: 'A' } as never, { ...requestDefaults, id: 'a', name: 'B' } as never] }), 'duplicate item IDs'],
  ];
  for (const [data, message] of cases) {
    const failure = await store.importBundle(data).catch((error: unknown) => error);
    expect(failure, message).toBeInstanceOf(CollectionImportError);
    expect((failure as Error).message).toContain(message);
  }
  expect(await fs.readdir(path.join(directory, 'collections'))).toEqual([]);
});

test('a failed write rolls the import back completely', async () => {
  const { directory: source } = await fixture();
  const bundle = await new CollectionStore(source).exportBundle();
  let writes = 0;
  const files: CollectionFileOperations = {
    readFile: fs.readFile,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      writes += 1;
      if (writes === 4) throw new Error('disk full');
      return fs.writeFile(...args);
    },
    rename: fs.rename,
    unlink: fs.unlink,
  };
  const { directory, store } = await freshStore(files);

  await expect(store.importBundle(bundle)).rejects.toThrow();
  expect(await fs.readdir(path.join(directory, 'collections'))).toEqual([]);
});

test('importing into a collection without a stored order places the import after the existing items', async () => {
  const { directory, store } = await freshStore();
  await store.createRequest({ ...requestDefaults, name: 'Existing' });
  await store.importBundle(bundleWith({ roots: ['a'], requests: [{ ...requestDefaults, id: 'a', name: 'Imported' } as never] }));
  expect(await treeOf(store)).toEqual(['Existing', 'Imported']);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'collections', '.root-order.json'), 'utf8'))).toHaveLength(2);
});
