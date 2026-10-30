import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CollectionRollbackIncompleteError } from '../../src/main/stores/collectionMutation';
import type { CollectionFileOperations } from '../../src/main/stores/collectionMutation';
import type { Request } from '../../src/shared/types';

const requestDefaults = {
  method: 'GET', url: '', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
  settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true }, scripts: {},
} satisfies Omit<Request, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

async function snapshot(directory: string) {
  const names = (await fs.readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await fs.readFile(path.join(directory, name))).toString('base64')])));
}

async function fixture(parent: 'root' | 'source', rootOrder = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-move-'));
  const collections = path.join(directory, 'collections');
  await fs.mkdir(collections);
  const records = {
    'child.req.json': { ...requestDefaults, id: 'child', name: 'Child', parentId: parent === 'source' ? 'source' : undefined, createdAt: 1, updatedAt: 1 },
    'other.req.json': { ...requestDefaults, id: 'other', name: 'Other', createdAt: 1, updatedAt: 1 },
    'source.grp.json': { id: 'source', name: 'Source', children: parent === 'source' ? ['child'] : [], createdAt: 1, updatedAt: 1 },
    'target.grp.json': { id: 'target', name: 'Target', children: [], createdAt: 1, updatedAt: 1 },
  };
  for (const [name, record] of Object.entries(records)) await fs.writeFile(path.join(collections, name), JSON.stringify(record) + '\n');
  if (rootOrder) await fs.writeFile(path.join(collections, '.root-order.json'), JSON.stringify(parent === 'root' ? ['child', 'other', 'source', 'target'] : ['other', 'source', 'target']) + '\n');
  return { directory, collections };
}

function faults(failAt = Infinity, recovery?: 'write' | 'rename' | 'unlink') {
  let count = 0;
  const events: string[] = [];
  const files: CollectionFileOperations = {
    readFile: fs.readFile,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const name = String(args[0]);
      if (name.endsWith('.restore')) {
        if (recovery === 'write') throw new Error('injected recovery write');
      } else {
        events.push(`stage:${path.basename(name)}`);
        count++;
        if (count === failAt) {
          await fs.writeFile(...args);
          throw new Error('injected partial stage');
        }
      }
      await fs.writeFile(...args);
    },
    rename: async (from, to) => {
      if (String(from).endsWith('.restore')) {
        if (recovery === 'rename') throw new Error('injected recovery rename');
      } else {
        events.push(`replace:${path.basename(String(to))}`);
        count++;
        if (count === failAt) {
          await fs.rename(from, to);
          throw new Error('injected replace after effect');
        }
      }
      await fs.rename(from, to);
    },
    unlink: async (name) => {
      if (recovery === 'unlink' && String(name).endsWith('.root-order.json')) throw new Error('injected recovery unlink');
      await fs.unlink(name);
    },
  };
  return { files, events };
}

for (const [parent, target] of [['root', 'target'], ['source', 'target'], ['source', undefined]] as const) {
  test(`move success and serialized membership: ${parent} to ${target ?? 'root'} clamps fractional index`, async () => {
    const state = await fixture(parent);
    try {
      const store = new CollectionStore(state.directory);
      const moved = await store.moveRequest({ requestId: 'child', targetParentId: target, targetIndex: -2.9 });
      expect(moved.parentId).toBe(target);
      expect((await store.getGroup('source'))?.children).toEqual([]);
      if (target) expect((await store.getGroup(target))?.children).toEqual(['child']);
      const roots = JSON.parse(await fs.readFile(path.join(state.collections, '.root-order.json'), 'utf8'));
      expect(roots.includes('child')).toBe(target === undefined);
      if (!target) expect(roots[0]).toBe('child');
    } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
  });
}

for (const parent of ['root', 'source'] as const) {
  test(`move success and serialized membership: stale root ordering after CRUD from ${parent}`, async () => {
    const state = await fixture(parent);
    try {
      const store = new CollectionStore(state.directory);
      await store.createRequest({ ...requestDefaults, id: 'deleted', name: 'Deleted' });
      await store.reorder({ children: ['target', 'deleted', 'other', 'source', 'child'] });
      await store.deleteRequest('deleted');
      await store.createRequest({ ...requestDefaults, id: 'new', name: 'New' });
      await store.createRequest({ ...requestDefaults, id: 'omitted', name: 'Omitted' });
      const rootsBefore = (await store.listAll()).filter((item) => item.parentId === undefined).map((item) => item.id);
      expect(rootsBefore).toEqual(parent === 'root' ? ['target', 'other', 'source', 'child', 'new', 'omitted'] : ['target', 'other', 'source', 'new', 'omitted']);

      const moved = await store.moveRequest({ requestId: parent === 'root' ? 'new' : 'child', targetParentId: parent === 'root' ? 'target' : undefined, targetIndex: 1 });

      expect(moved.parentId).toBe(parent === 'root' ? 'target' : undefined);
      const expected = parent === 'root' ? ['target', 'other', 'source', 'child', 'omitted'] : ['target', 'child', 'other', 'source', 'new', 'omitted'];
      expect(JSON.parse(await fs.readFile(path.join(state.collections, '.root-order.json'), 'utf8'))).toEqual(expected);
      expect((await store.listAll()).filter((item) => item.parentId === undefined).map((item) => item.id)).toEqual(expected);
      expect((await store.getGroup('target'))?.children).toEqual(parent === 'root' ? ['new'] : []);
    } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
  });
}

for (const scenario of [
  { name: 'valid partial hint preserves omitted roots', parent: 'root', hint: ['child', 'target'], target: 'target', expected: ['target'] },
  { name: 'omitted moving root reconciles live roots', parent: 'root', hint: ['target'], target: 'target', expected: ['target', 'other', 'source'] },
  { name: 'root insertion indexes all visible roots', parent: 'source', hint: ['target'], target: undefined, expected: ['target', 'other', 'child', 'source'] },
] as const) {
  test(`move success and serialized membership: ${scenario.name}`, async () => {
    const state = await fixture(scenario.parent);
    try {
      const store = new CollectionStore(state.directory);
      await store.reorder({ children: [...scenario.hint] });
      const rootPath = path.join(state.collections, '.root-order.json');
      const hintBytes = await fs.readFile(rootPath);
      await store.updateRequest('other', { name: 'Saved omitted root' });
      expect(await fs.readFile(rootPath)).toEqual(hintBytes);

      await store.moveRequest({ requestId: 'child', targetParentId: scenario.target, targetIndex: 2 });

      expect(JSON.parse(await fs.readFile(rootPath, 'utf8'))).toEqual(scenario.expected);
      const roots = (await store.listAll()).filter((item) => item.parentId === undefined).map((item) => item.id);
      expect(roots).toEqual(scenario.target ? ['target', 'other', 'source'] : scenario.expected);
      expect((await fs.readdir(state.collections)).some((name) => /\.(next|original|restore|recovery\.json)$/.test(name))).toBe(false);
    } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
  });
}

test('move success and serialized membership: concurrent moves and CRUD do not lose links or deadlock', async () => {
  const state = await fixture('root');
  try {
    const store = new CollectionStore(state.directory);
    await Promise.all([
      store.moveRequest({ requestId: 'child', targetParentId: 'target', targetIndex: 0 }),
      store.moveRequest({ requestId: 'other', targetParentId: 'target', targetIndex: 1 }),
      store.createRequest({ ...requestDefaults, id: 'created', name: 'Created', parentId: 'target' }),
      store.updateRequest('child', { name: 'Renamed' }),
      store.duplicate('child'),
      store.import({ type: 'request', id: 'imported', name: 'Imported', parentId: 'target' }),
    ]);
    const children = (await store.getGroup('target'))?.children ?? [];
    expect(children.slice(0, 3)).toEqual(['child', 'other', 'created']);
    expect(children).toHaveLength(5);
    expect(new Set(children).size).toBe(5);
    expect((await store.getRequest('child'))?.name).toBe('Renamed');
    await store.reorder({ parentId: 'target', children: [...children].reverse() });
    expect((await store.getGroup('target'))?.children).toEqual([...children].reverse());
    await store.reorder({ children: ['target', 'source'] });
    expect((await store.listAll())[0].id).toBe('target');
    await Promise.all([store.delete('created'), store.deleteGroup('source'), store.createGroup({ name: 'New', children: [] })]);
  } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
});

const invalidStates = ['missing target', 'missing source', 'missing request', 'corrupt target', 'non-array source', 'missing membership', 'duplicate source', 'duplicate target', 'duplicate root', 'stale parent', 'double membership', 'corrupt request', 'corrupt root', 'mismatched ID', 'missing child', 'legacy response', 'same parent', 'NaN', 'Infinity', 'empty ID'] as const;
for (const invalid of invalidStates) {
  test(`reject or restore failed move: zero writes for ${invalid}`, async () => {
    const state = await fixture('source');
    try {
      const write = (name: string, value: unknown) => fs.writeFile(path.join(state.collections, name), JSON.stringify(value));
      const payload = { requestId: 'child', targetParentId: 'target', targetIndex: 0 };
      switch (invalid) {
        case 'missing target': await fs.unlink(path.join(state.collections, 'target.grp.json')); break;
        case 'missing source': await fs.unlink(path.join(state.collections, 'source.grp.json')); break;
        case 'missing request': await fs.unlink(path.join(state.collections, 'child.req.json')); break;
        case 'corrupt target': await fs.writeFile(path.join(state.collections, 'target.grp.json'), '{'); break;
        case 'non-array source': await write('source.grp.json', { id: 'source', children: {} }); break;
        case 'missing membership': await write('source.grp.json', { id: 'source', children: [] }); break;
        case 'duplicate source': await write('source.grp.json', { id: 'source', children: ['child', 'child'] }); break;
        case 'duplicate target': await write('target.grp.json', { id: 'target', children: ['other', 'other'] }); break;
        case 'duplicate root': await write('.root-order.json', ['other', 'other']); break;
        case 'stale parent': await write('child.req.json', { id: 'child', parentId: 'target' }); break;
        case 'double membership': await write('target.grp.json', { id: 'target', children: ['child'] }); break;
        case 'corrupt request': await fs.writeFile(path.join(state.collections, 'child.req.json'), 'null'); break;
        case 'corrupt root': await fs.writeFile(path.join(state.collections, '.root-order.json'), '{'); break;
        case 'mismatched ID': await write('target.grp.json', { id: 'different', children: [] }); break;
        case 'missing child': await write('target.grp.json', { id: 'target', children: ['missing'] }); break;
        case 'legacy response': await write('child.req.json', { id: 'child', parentId: 'source', lastResponse: { version: 1 } }); payload.targetParentId = 'missing'; break;
        case 'same parent': payload.targetParentId = 'source'; break;
        case 'NaN': payload.targetIndex = NaN; break;
        case 'Infinity': payload.targetIndex = Infinity; break;
        case 'empty ID': payload.requestId = ''; break;
      }
      const before = await snapshot(state.collections);
      const injected = faults();
      const store = new CollectionStore(state.directory, injected.files);
      await expect(store.moveRequest(payload)).rejects.toThrow();
      expect(injected.events).toEqual([]);
      expect(await snapshot(state.collections)).toEqual(before);
    } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
  });
}

for (const [parent, target, hasRoot] of [['root', 'target', true], ['source', 'target', true], ['source', undefined, true], ['root', 'target', false], ['source', undefined, false]] as const) {
  const stepCount = hasRoot || target === 'target' && parent === 'source' ? 10 : 9;
  for (let step = 1; step <= stepCount; step++) {
    test(`reject or restore failed move: ${parent} to ${target ?? 'root'} root=${hasRoot} fault ${step}/${stepCount}`, async () => {
      const state = await fixture(parent, hasRoot);
      try {
        const before = await snapshot(state.collections);
        const injected = faults(step);
        const store = new CollectionStore(state.directory, injected.files);
        const payload = { requestId: 'child', targetParentId: target, targetIndex: 999.8 };
        await expect(store.moveRequest(payload)).rejects.toThrow('original collection files were restored');
        expect(injected.events.length).toBe(step);
        expect(await snapshot(state.collections)).toEqual(before);
        const nodes = await store.listAll();
        expect(nodes.find((node) => node.id === 'child')?.parentId).toBe(parent === 'source' ? 'source' : undefined);
        expect((await store.getGroup('source'))?.children.includes('child')).toBe(parent === 'source');
        await store.moveRequest(payload);
        expect((await store.getRequest('child'))?.parentId).toBe(target);
        expect((await fs.readdir(state.collections)).some((name) => /\.(next|original|restore|recovery\.json)$/.test(name))).toBe(false);
      } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
    });
  }
}

for (const recovery of ['write', 'rename', 'unlink'] as const) {
  test(`reject or restore failed move: recovery ${recovery} failure retains original bytes and distinct error`, async () => {
    const state = await fixture('source', recovery !== 'unlink');
    try {
      const before = await snapshot(state.collections);
      const injected = faults(recovery === 'unlink' ? 8 : 9, recovery);
      const store = new CollectionStore(state.directory, injected.files);
      const result = await store.moveRequest({ requestId: 'child', targetIndex: 0 }).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(CollectionRollbackIncompleteError);
      if (!(result instanceof CollectionRollbackIncompleteError)) throw new Error('Expected incomplete rollback');
      expect(result.message).toContain('COLLECTION_ROLLBACK_INCOMPLETE');
      expect(result.message).not.toContain(state.directory);
      const manifest = JSON.parse(await fs.readFile(result.recoveryManifest, 'utf8'));
      for (const entry of manifest) {
        if (entry.existed) expect((await fs.readFile(entry.backup)).toString('base64')).toBe(before[path.basename(entry.path)]);
        else expect(before[path.basename(entry.path)]).toBeUndefined();
      }
      expect(await fs.readdir(state.collections)).toContain(path.basename(result.recoveryManifest));
    } finally { await fs.rm(state.directory, { recursive: true, force: true }); }
  });
}

test('reject or restore failed move: missing target preserves source bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-move-'));
  try {
    const store = new CollectionStore(directory);
    await store.init();
    const group = await store.createGroup({ name: 'Source', children: [] });
    const request = await store.createRequest({ ...requestDefaults, name: 'Child', parentId: group.id });
    const source = path.join(directory, 'collections', `${group.id}.grp.json`);
    const before = await fs.readFile(source);

    await expect(store.moveRequest({ requestId: request.id, targetParentId: 'missing', targetIndex: 0 })).rejects.toThrow();

    expect(await fs.readFile(source)).toEqual(before);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
