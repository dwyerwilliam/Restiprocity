import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import type { CollectionFileOperations } from '../../src/main/stores/collectionMutation';
import { defaultRequestOutputs } from '../../src/shared/requestOutputs';
import { COLLECTION_EXPORT_FORMAT, COLLECTION_EXPORT_VERSION, type Request, type RequestOutputs } from '../../src/shared/types';

const requestDefaults = {
  method: 'POST', url: 'https://auth.test/token', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
  settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true }, scripts: {},
} satisfies Omit<Request, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

const tokenResponse = {
  version: 2, id: 'resp', requestId: 'login', status: 200, statusText: 'OK',
  headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: 'X-Session', value: 'session-secret', enabled: true }],
  preview: { kind: 'text', format: 'json', text: '{"access_token":"tok-secret-1"}', parseState: 'valid', charset: 'utf-8', decodeError: false, capturedBytes: 31, totalBytes: 31, truncated: false, completeness: 'complete' },
  timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 }, timestamp: 1, size: 31, cookies: [],
} as const;

function outputs(patch: Partial<RequestOutputs> = {}): RequestOutputs {
  return { ...defaultRequestOutputs(), ...patch };
}

async function freshStore(files?: CollectionFileOperations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-outputs-'));
  await fs.mkdir(path.join(directory, 'collections'));
  return { directory, store: new CollectionStore(directory, files) };
}

async function readRequestFile(directory: string, id: string) {
  return JSON.parse(await fs.readFile(path.join(directory, 'collections', `${id}.req.json`), 'utf8'));
}

test('outputs survive create, update, update-as-create and reload', async () => {
  const { directory, store } = await freshStore();
  const created = await store.createRequest({ ...requestDefaults, name: 'Login', outputs: outputs() });
  expect((await readRequestFile(directory, created.id)).outputs).toEqual(outputs());

  await store.updateRequest(created.id, { outputs: outputs({ refreshAfterSeconds: 60 }) });
  expect((await new CollectionStore(directory).getRequest(created.id))?.outputs?.refreshAfterSeconds).toBe(60);

  await store.updateRequest(created.id, { name: 'Renamed' });
  expect((await store.getRequest(created.id))?.outputs?.refreshAfterSeconds).toBe(60);

  await store.updateRequest('fresh-id', { ...requestDefaults, name: 'Made by update', outputs: outputs({ values: [{ name: 'other', source: { kind: 'body' } }] }) });
  expect((await store.getRequest('fresh-id'))?.outputs?.values[0].name).toBe('other');
});

test('an invalid definition is refused and nothing is written', async () => {
  const { directory, store } = await freshStore();
  await expect(store.createRequest({ ...requestDefaults, name: 'Bad', outputs: outputs({ refreshAfterSeconds: 0 }) }))
    .rejects.toThrow(/whole number of seconds/);
  expect(await fs.readdir(path.join(directory, 'collections'))).toEqual([]);
  const created = await store.createRequest({ ...requestDefaults, name: 'Login', outputs: outputs() });
  await expect(store.updateRequest(created.id, { outputs: { ...outputs(), values: [{ name: 'uuid', source: { kind: 'body' } }] } }))
    .rejects.toThrow(/built-in variable/);
  expect((await readRequestFile(directory, created.id)).outputs).toEqual(outputs());
});

test('an enabled name can be provided by one request only', async () => {
  const { store } = await freshStore();
  const first = await store.createRequest({ ...requestDefaults, name: 'Login A', outputs: outputs() });
  await expect(store.createRequest({ ...requestDefaults, name: 'Login B', outputs: outputs() }))
    .rejects.toThrow('"api_token" is already an output of "Login A". Choose another name.');

  // A disabled definition may share the name, and turning the first one off frees it.
  const second = await store.createRequest({ ...requestDefaults, name: 'Login B', outputs: outputs({ enabled: false }) });
  await expect(store.updateRequest(second.id, { outputs: outputs() })).rejects.toThrow(/already an output of "Login A"/);
  await store.updateRequest(first.id, { outputs: outputs({ enabled: false }) });
  await store.updateRequest(second.id, { outputs: outputs() });

  // Turning outputs off keeps the rows.
  expect((await store.getRequest(first.id))?.outputs).toEqual(outputs({ enabled: false }));
});

test('the index lists enabled names first and disabled names only when nothing enabled has them', async () => {
  const { store } = await freshStore();
  const on = await store.createRequest({ ...requestDefaults, id: 'b-on', name: 'On', outputs: outputs() });
  await store.createRequest({ ...requestDefaults, id: 'a-off', name: 'Off', outputs: outputs({ enabled: false, values: [
    { name: 'api_token', source: { kind: 'body' } }, { name: 'only_off', source: { kind: 'body' } },
  ] }) });
  const index = await store.getOutputIndex();
  expect(index.get('api_token')).toEqual({ requestId: on.id, enabled: true });
  expect(index.get('only_off')).toEqual({ requestId: 'a-off', enabled: false });

  // A fresh store reads the same index from disk.
  const reread = await new CollectionStore((store as unknown as { collectionsDir: string }).collectionsDir.replace(/[\\/]collections$/, '')).getOutputIndex();
  expect([...reread]).toEqual([...index]);
});

test('a duplicate starts with its outputs off and a delete fires the removal listener', async () => {
  const { store } = await freshStore();
  const original = await store.createRequest({ ...requestDefaults, name: 'Login', outputs: outputs() });
  const copy = await store.duplicate(original.id);
  expect(copy.outputs).toEqual(outputs({ enabled: false }));

  const removed: string[] = [];
  const unsubscribe = store.onRequestRemoved(id => removed.push(id));
  await store.delete(original.id);
  await store.delete('never-existed');
  expect(removed).toEqual([original.id]);
  expect((await store.getOutputIndex()).get('api_token')).toEqual({ requestId: copy.id, enabled: false });

  unsubscribe();
  await store.delete(copy.id);
  expect(removed).toEqual([original.id]);
  expect((await store.getOutputIndex()).size).toBe(0);
});

test('a request that provides outputs never stores its response body', async () => {
  const { directory, store } = await freshStore();
  const created = await store.createRequest({ ...requestDefaults, name: 'Login', outputs: outputs({
    values: [...defaultRequestOutputs().values, { name: 'session', source: { kind: 'header', name: 'x-session' } }],
  }), lastResponse: tokenResponse as never });
  const stored = await readRequestFile(directory, created.id);
  expect(stored.lastResponse.bodyWithheld).toBe('outputs');
  expect(stored.lastResponse.preview.kind).toBe('empty');
  const raw = await fs.readFile(path.join(directory, 'collections', `${created.id}.req.json`), 'utf8');
  expect(raw).not.toContain('tok-secret-1');
  expect(raw).not.toContain('session-secret');

  // Without enabled outputs the body is kept as before.
  const plain = await store.createRequest({ ...requestDefaults, name: 'Plain', lastResponse: tokenResponse as never });
  expect((await readRequestFile(directory, plain.id)).lastResponse.preview.text).toContain('tok-secret-1');
});

function bundle(requests: Array<Partial<Request> & { id: string; name: string }>) {
  return {
    format: COLLECTION_EXPORT_FORMAT, version: COLLECTION_EXPORT_VERSION, exportedAt: new Date(0).toISOString(),
    roots: requests.map(request => request.id), groups: [], requests: requests.map(request => ({ ...requestDefaults, ...request, createdAt: 0, updatedAt: 0 })),
  };
}

test('export includes outputs and import turns off clashes with a warning', async () => {
  const { store: source } = await freshStore();
  await source.createRequest({ ...requestDefaults, name: 'Login', outputs: outputs() });
  const exported = await source.exportBundle();
  expect(exported.requests[0].outputs).toEqual(outputs());

  const { store: target } = await freshStore();
  await target.createRequest({ ...requestDefaults, name: 'Existing login', outputs: outputs() });
  const summary = await target.importBundle(exported);
  expect(summary.warnings).toContain('Outputs on "Login" were turned off because {{api_token}} is already provided by "Existing login".');
  const imported = (await target.listAll()).find(item => item.name === 'Login') as Request;
  expect(imported.outputs).toEqual(outputs({ enabled: false }));
  expect((await target.getOutputIndex()).get('api_token')?.enabled).toBe(true);
});

test('two imported requests with the same name: the first keeps it', async () => {
  const { store } = await freshStore();
  const summary = await store.importBundle(bundle([
    { id: 'x', name: 'First', outputs: outputs() },
    { id: 'y', name: 'Second', outputs: outputs() },
  ]));
  expect(summary.warnings).toEqual(['Outputs on "Second" were turned off because {{api_token}} is already provided by "First".']);
  const byName = new Map((await store.listAll()).map(item => [item.name, item as Request]));
  expect(byName.get('First')?.outputs?.enabled).toBe(true);
  expect(byName.get('Second')?.outputs?.enabled).toBe(false);
});

test('an invalid imported definition is dropped with a warning', async () => {
  const { store } = await freshStore();
  const summary = await store.importBundle(bundle([{ id: 'x', name: 'Broken', outputs: { enabled: true, values: 'nope' } as never }]));
  expect(summary.warnings[0]).toMatch(/^Outputs on "Broken" were not imported: /);
  const [imported] = await store.listAll();
  expect((imported as Request).outputs).toBeUndefined();
});

test('a failed import leaves the files and the index as they were', async () => {
  let writes = 0;
  let failWrites = false;
  const files: CollectionFileOperations = {
    readFile: fs.readFile,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      writes += 1;
      if (failWrites && writes > 1) throw new Error('disk full');
      return fs.writeFile(...args);
    },
    rename: fs.rename,
    unlink: fs.unlink,
  };
  const { directory, store } = await freshStore(files);
  const existing = await store.createRequest({ ...requestDefaults, name: 'Existing', outputs: outputs() });
  const before = await fs.readFile(path.join(directory, 'collections', `${existing.id}.req.json`));
  const listingBefore = (await fs.readdir(path.join(directory, 'collections'))).sort();
  failWrites = true;
  writes = 0;
  await expect(store.importBundle(bundle([
    { id: 'x', name: 'A', outputs: outputs({ values: [{ name: 'other', source: { kind: 'body' } }] }) },
    { id: 'y', name: 'B' },
  ]))).rejects.toThrow();
  expect((await fs.readdir(path.join(directory, 'collections'))).sort()).toEqual(listingBefore);
  expect(await fs.readFile(path.join(directory, 'collections', `${existing.id}.req.json`))).toEqual(before);
  expect([...(await store.getOutputIndex()).keys()]).toEqual(['api_token']);
});
