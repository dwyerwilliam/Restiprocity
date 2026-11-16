import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore, isStorableId } from '../../src/main/stores/collectionStore';
import { CollectionMoveError } from '../../src/main/stores/collectionMutation';

/** Every file under a folder, as paths relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

const requestData = {
  nodeType: 'request', name: 'Escape', method: 'GET', url: 'https://example.com', headers: [], parameters: [],
  body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {},
};

// IDs that would name a file outside the item's folder, or are not a plain name at all.
const unsafeIds = ['../escaped', '..\\escaped', '../../outside/escaped', 'C:escaped', '/escaped', 'nested/escaped',
  '.hidden', '', ' ', 'a'.repeat(129), 'has space', `nul${String.fromCharCode(0)}byte`];

test('IDs the app generates are storable, and IDs that are not plain file names are not', () => {
  for (const id of ['core', '1763164800000-k3j2h1a', '0f8fad5b-d9cb-469f-a165-70867728950e', 'req_1', 'a.b-c_d', 'a'.repeat(128)]) {
    expect(isStorableId(id), id).toBe(true);
  }
  for (const id of [...unsafeIds, undefined, null, 7, {}]) expect(isStorableId(id), String(id)).toBe(false);
});

test('an ID that is not a plain file name is never read, written or deleted', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-ids-'));
  const userDataPath = path.join(sandbox, 'profile');
  try {
    const store = new CollectionStore(userDataPath);
    await fs.mkdir(path.join(sandbox, 'outside'), { recursive: true });
    await fs.mkdir(userDataPath, { recursive: true });
    await store.init();
    // Files an escaping ID would reach if it were used to build a path: one level and two levels above the item folders.
    const bait = JSON.stringify({ id: '../escaped', name: 'Bait', variables: [{ key: 'token', value: 'outside-secret', type: 'standard' }], children: [] });
    for (const folder of [userDataPath, path.join(sandbox, 'outside')]) {
      for (const name of ['escaped.json', 'escaped.req.json', 'escaped.grp.json']) await fs.writeFile(path.join(folder, name), bait);
    }
    const kept = await store.createRequest({ ...requestData, name: 'Kept' } as never);
    const before = await filesUnder(sandbox);
    const contentBefore = await Promise.all(before.map(file => fs.readFile(path.join(sandbox, file), 'utf-8')));

    for (const id of unsafeIds) {
      // Lookups report the item as missing.
      expect(await store.getRequest(id), id).toBeNull();
      expect(await store.getGroup(id), id).toBeNull();
      expect(await store.getEnvironment(id), id).toBeNull();
      expect(await store.export(id), id).toBeNull();
      await expect(store.revealSecret(id, 'token'), id).rejects.toThrow(/not found/);
      // Writes and deletes refuse.
      await expect(store.update(id, requestData), id).rejects.toThrow('Invalid item ID.');
      await expect(store.update(id, { nodeType: 'group', name: 'Escape' }), id).rejects.toThrow();
      await expect(store.delete(id), id).rejects.toThrow('Invalid item ID.');
      await expect(store.createRequest({ ...requestData, id } as never), id).rejects.toThrow('Invalid item ID.');
      await expect(store.updateEnvironment(id, { name: 'Escape' }), id).rejects.toThrow(/not found/);
      await expect(store.deleteEnvironment(id), id).rejects.toThrow();
      await expect(store.migrateSecrets(id), id).rejects.toThrow(/not found/);
      await expect(store.moveRequest({ requestId: id, targetParentId: undefined, targetIndex: 0 }), id).rejects.toBeInstanceOf(CollectionMoveError);
      // An empty ID means "use a generated one" or "use Core" for these three, so it is not an unsafe ID there.
      if (id) {
        await expect(store.createEnvironment({ id, name: 'Escape', variables: [] }), id).rejects.toThrow('Invalid item ID.');
        await expect(store.switchEnvironment(id), id).rejects.toThrow();
        await expect(store.moveRequest({ requestId: kept.id, targetParentId: id, targetIndex: 0 }), id).rejects.toBeInstanceOf(CollectionMoveError);
      }
    }

    const after = await filesUnder(sandbox);
    expect(after).toEqual(before);
    expect(await Promise.all(after.map(file => fs.readFile(path.join(sandbox, file), 'utf-8')))).toEqual(contentBefore);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('a stored active environment ID that is not a plain file name falls back to Core at startup', async () => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-ids-'));
  try {
    await fs.writeFile(path.join(userDataPath, 'settings.json'), JSON.stringify({ activeEnvironmentId: '../escaped' }));
    const store = new CollectionStore(userDataPath);
    await store.init();
    expect((await store.getSettings()).activeEnvironmentId).toBe('core');
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
});
