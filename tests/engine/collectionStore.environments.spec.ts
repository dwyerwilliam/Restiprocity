import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CORE_ENVIRONMENT_ID, Environment } from '../../src/shared/types';

async function withStore(run: (store: CollectionStore, userDataPath: string) => Promise<void>) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-env-'));

  try {
    const store = new CollectionStore(userDataPath);
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

      store.switchEnvironment(child.id);
      const grandchild = await store.createEnvironment({ name: 'Local Overrides', variables: [] });
      expect(grandchild.parentId).toBe(child.id);

      store.switchEnvironment(null);
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
});
