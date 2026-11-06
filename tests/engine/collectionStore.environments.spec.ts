import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CORE_ENVIRONMENT_ID, Environment } from '../../src/shared/types';

type SettingsFileOperations = Pick<typeof fs, 'writeFile' | 'rename' | 'unlink'>;

async function withStore(
  run: (store: CollectionStore, userDataPath: string) => Promise<void>,
  settingsFiles?: SettingsFileOperations,
) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-env-'));

  try {
    const store = new CollectionStore(userDataPath, undefined, settingsFiles);
    await run(store, userDataPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

test.describe('CollectionStore environments', () => {
  test('seeds a persisted core environment and defaults active environment to core on init', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      const envs = await store.listEnvironments();
      const core = envs.find((env) => env.id === CORE_ENVIRONMENT_ID);
      const corePath = path.join(userDataPath, 'environments', `${CORE_ENVIRONMENT_ID}.json`);

      expect(core).toMatchObject({
        id: CORE_ENVIRONMENT_ID,
        name: 'Core',
        variables: [],
      });
      expect(core?.parentId).toBeUndefined();
      expect(store.getActiveEnvironmentId()).toBe(CORE_ENVIRONMENT_ID);
      await expect(fs.stat(corePath)).resolves.toMatchObject({});
    });
  });

  test('creates child environments under the active environment or core by default', async () => {
    await withStore(async (store) => {
      await store.init();

      const child = await store.createEnvironment({ name: 'Local', variables: [] });
      expect(child.parentId).toBe(CORE_ENVIRONMENT_ID);

      await store.switchEnvironment(child.id);
      const grandchild = await store.createEnvironment({ name: 'Local Overrides', variables: [] });
      expect(grandchild.parentId).toBe(child.id);

      await store.switchEnvironment(null);
      const fallbackChild = await store.createEnvironment({ name: 'Fallback', variables: [] });
      expect(fallbackChild.parentId).toBe(CORE_ENVIRONMENT_ID);
    });
  });

  test('keeps existing environment files compatible when adding core', async () => {
    await withStore(async (store, userDataPath) => {
      const legacyEnv: Environment = {
        id: 'legacy-env',
        name: 'Legacy',
        variables: [{ key: 'baseUrl', value: 'https://example.test', type: 'standard' }],
        createdAt: 1,
        updatedAt: 1,
      };
      const envDir = path.join(userDataPath, 'environments');
      await fs.mkdir(envDir, { recursive: true });
      await fs.writeFile(path.join(envDir, `${legacyEnv.id}.json`), JSON.stringify(legacyEnv, null, 2), 'utf-8');

      await store.init();

      const envs = await store.listEnvironments();
      expect(envs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: CORE_ENVIRONMENT_ID }),
        expect.objectContaining(legacyEnv),
      ]));
    });
  });

  test('restores canonical active environment and unrelated settings after restart', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const child = await store.createEnvironment({ name: 'Local', variables: [] });
      await store.saveSettings({ theme: 'light', fontSize: 18, activeEnvironmentId: child.id });

      const restarted = new CollectionStore(userDataPath);
      await restarted.init();

      expect(restarted.getActiveEnvironmentId()).toBe(child.id);
      await expect(restarted.getSettings()).resolves.toMatchObject({
        activeEnvironmentId: child.id,
        theme: 'light',
        fontSize: 18,
      });
    });
  });

  test('normalizes legacy, malformed, and deleted selections to core without dropping settings', async () => {
    await withStore(async (store, userDataPath) => {
      const settingsPath = path.join(userDataPath, 'settings.json');
      await fs.writeFile(settingsPath, JSON.stringify({ theme: 'light', fontSize: 19, activeEnvironmentId: 42 }), 'utf-8');
      await store.init();

      expect(store.getActiveEnvironmentId()).toBe(CORE_ENVIRONMENT_ID);
      await expect(store.getSettings()).resolves.toMatchObject({ theme: 'light', fontSize: 19, activeEnvironmentId: CORE_ENVIRONMENT_ID });

      await fs.writeFile(settingsPath, JSON.stringify({ theme: 'light', fontSize: 19, activeEnvironmentId: 'deleted' }), 'utf-8');
      const restarted = new CollectionStore(userDataPath);
      await restarted.init();
      expect(restarted.getActiveEnvironmentId()).toBe(CORE_ENVIRONMENT_ID);
      await expect(restarted.getSettings()).resolves.toMatchObject({ theme: 'light', fontSize: 19, activeEnvironmentId: CORE_ENVIRONMENT_ID });
    });
  });

  test('invalid or failed environment changes reject invalid switches without changing the canonical selection', async () => {
    await withStore(async (store) => {
      await store.init();
      const child = await store.createEnvironment({ name: 'Local', variables: [] });
      await store.switchEnvironment(child.id);

      await expect(store.switchEnvironment('missing')).rejects.toThrow('Environment no longer exists');
      expect(store.getActiveEnvironmentId()).toBe(child.id);
      await expect(store.getSettings()).resolves.toMatchObject({ activeEnvironmentId: child.id });
    });
  });

  test('returns to the existing parent when deleting the active environment', async () => {
    await withStore(async (store) => {
      await store.init();
      const parent = await store.createEnvironment({ name: 'Parent', variables: [] });
      await store.switchEnvironment(parent.id);
      const child = await store.createEnvironment({ name: 'Child', variables: [] });
      await store.switchEnvironment(child.id);

      await expect(store.deleteEnvironment(child.id)).resolves.toBe(parent.id);
      expect(store.getActiveEnvironmentId()).toBe(parent.id);
      await expect(store.getSettings()).resolves.toMatchObject({ activeEnvironmentId: parent.id });

      const other = await store.createEnvironment({ name: 'Other', variables: [] });
      await expect(store.deleteEnvironment(other.id)).resolves.toBe(parent.id);
      expect(store.getActiveEnvironmentId()).toBe(parent.id);
    });
  });

  test('invalid or failed environment changes keep a valid in-memory selection when settings persistence fails', async () => {
    let failWrites = false;
    const settingsFiles: SettingsFileOperations = {
      writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
        if (failWrites) throw new Error('injected settings write failure');
        await fs.writeFile(...args);
      },
      rename: fs.rename,
      unlink: fs.unlink,
    };

    await withStore(async (store) => {
      await store.init();
      const child = await store.createEnvironment({ name: 'Local', variables: [] });
      failWrites = true;

      await expect(store.switchEnvironment(child.id)).rejects.toThrow('Unable to persist environment settings');
      expect(store.getActiveEnvironmentId()).toBe(CORE_ENVIRONMENT_ID);
      await expect(store.getSettings()).resolves.toMatchObject({ activeEnvironmentId: CORE_ENVIRONMENT_ID });
    }, settingsFiles);
  });

  test('failed active deletion preserves the environment file and persisted selection', async () => {
    let failWrites = false;
    const settingsFiles: SettingsFileOperations = {
      writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
        if (failWrites) throw new Error('injected settings write failure');
        await fs.writeFile(...args);
      },
      rename: fs.rename,
      unlink: fs.unlink,
    };

    await withStore(async (store, userDataPath) => {
      await store.init();
      const child = await store.createEnvironment({ name: 'Local', variables: [] });
      await store.switchEnvironment(child.id);
      const settingsPath = path.join(userDataPath, 'settings.json');
      const environmentPath = path.join(userDataPath, 'environments', `${child.id}.json`);
      const originalSettings = await fs.readFile(settingsPath, 'utf-8');
      const originalEnvironment = await fs.readFile(environmentPath, 'utf-8');
      failWrites = true;

      await expect(store.deleteEnvironment(child.id)).rejects.toThrow('Unable to persist environment settings');

      await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe(originalSettings);
      await expect(fs.readFile(environmentPath, 'utf-8')).resolves.toBe(originalEnvironment);
      expect(store.getActiveEnvironmentId()).toBe(child.id);
      await expect(store.getSettings()).resolves.toMatchObject({ activeEnvironmentId: child.id });
    }, settingsFiles);
  });

  test('serializes queued switch, save, and delete operations without losing canonical validity', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const first = await store.createEnvironment({ name: 'First', variables: [] });
      const second = await store.createEnvironment({ name: 'Second', variables: [] });

      await Promise.all([
        store.switchEnvironment(first.id),
        store.saveSettings({ theme: 'light' }),
        store.deleteEnvironment(second.id),
      ]);

      const restarted = new CollectionStore(userDataPath);
      await restarted.init();
      expect(restarted.getActiveEnvironmentId()).toBe(first.id);
      await expect(restarted.getSettings()).resolves.toMatchObject({ activeEnvironmentId: first.id, theme: 'light' });
    });
  });

  test('persists renamed environments and standard/secret overrides without changing selection', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const parent = await store.createEnvironment({
        name: 'Parent', variables: [{ key: 'url', value: 'https://example.test', type: 'standard' }],
      });
      const child = await store.createEnvironment({ name: 'Child', parentId: parent.id, variables: [] });
      await store.switchEnvironment(child.id);
      await store.updateEnvironment(child.id, { name: 'Renamed', variables: [
        { key: 'url', value: 'https://override.test', type: 'standard' },
        { key: 'token', value: 'fixture-secret', type: 'secret' },
      ] });
      const restarted = new CollectionStore(userDataPath);
      await restarted.init();
      expect(restarted.getActiveEnvironmentId()).toBe(child.id);
      await expect(restarted.getEnvironment(child.id)).resolves.toMatchObject({
        name: 'Renamed', parentId: parent.id, variables: [
          { key: 'url', value: 'https://override.test', type: 'standard' },
          { key: 'token', value: 'fixture-secret', type: 'secret' },
        ],
      });
    });
  });

  test('rejects deleting parents and invalid edits without mutating persisted files', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const parent = await store.createEnvironment({ name: 'Parent', variables: [] });
      const child = await store.createEnvironment({ name: 'Child', parentId: parent.id, variables: [] });
      await store.switchEnvironment(child.id);
      const snapshot = async () => {
        const directory = path.join(userDataPath, 'environments');
        return Promise.all((await fs.readdir(directory)).sort().map(async name => [name, await fs.readFile(path.join(directory, name), 'utf8')]));
      };
      const before = await snapshot();
      await expect(store.deleteEnvironment(parent.id)).rejects.toThrow('Delete child environments first');
      await expect(store.updateEnvironment(parent.id, { parentId: child.id })).rejects.toThrow('cycle');
      await expect(store.updateEnvironment(child.id, { parentId: 'missing' })).rejects.toThrow('Parent environment');
      await expect(store.createEnvironment({ id: parent.id, name: 'Overwrite', variables: [] })).rejects.toThrow('already exists');
      await expect(store.createEnvironment({ name: 'Missing parent', parentId: 'missing', variables: [] })).rejects.toThrow('Parent environment');
      await expect(store.updateEnvironment(child.id, { name: ' ' })).rejects.toThrow('name is required');
      await expect(store.updateEnvironment(child.id, { variables: [
        { key: 'token', value: 'a', type: 'standard' },
        { key: ' token ', value: 'b', type: 'secret' },
      ] })).rejects.toThrow('unique');
      expect(await snapshot()).toEqual(before);
      expect(store.getActiveEnvironmentId()).toBe(child.id);
      await store.deleteEnvironment(child.id);
      await expect(store.deleteEnvironment(parent.id)).resolves.toBe('core');
    });
  });
});
