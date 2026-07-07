import { test, expect } from '@playwright/test';

test.describe('Core-first Environment Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      type MockEnvironment = {
        id: string;
        name: string;
        parentId?: string;
        variables: Array<{ key: string; value: string; type: 'standard' | 'secret' }>;
        createdAt: number;
        updatedAt: number;
      };

      const now = Date.now();
      const coreEnv: MockEnvironment = {
        id: 'core',
        name: 'Core',
        variables: [],
        createdAt: now,
        updatedAt: now,
      };
      const localEnv: MockEnvironment = {
        id: 'env-local',
        name: 'Local',
        parentId: 'core',
        variables: [{ key: 'baseUrl', value: 'http://localhost:3000', type: 'standard' }],
        createdAt: now,
        updatedAt: now,
      };

      let envList: MockEnvironment[] = [coreEnv, localEnv];
      let activeEnvId: string | null = 'core';

      (window as any).api = {
        collectionList: async () => ({
          nodes: [
            {
              id: 'group-1',
              type: 'group',
              name: 'My API',
              children: ['req-1'],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            {
              id: 'req-1',
              type: 'request',
              name: 'GET /users',
              method: 'GET',
              url: 'https://jsonplaceholder.typicode.com/users',
              headers: [],
              parameters: [],
              body: { type: 'none' },
              auth: { type: 'none' },
              settings: { followRedirect: true, timeout: 30000, allowInsecureCertificates: false },
              scripts: {},
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        }),
        collectionCreate: async () => ({}),
        collectionDelete: async () => {},
        collectionUpdate: async () => {},
        collectionExport: async () => ({}),
        collectionDuplicate: async () => ({}),
        collectionReorder: async () => {},
        onCollectionChanged: () => {},
        envList: async () => envList,
        envCreate: async (data: { name: string; parentId?: string; variables: MockEnvironment['variables'] }) => {
          const newEnv = {
            id: `env-${data.name.toLowerCase().replace(/\s+/g, '-')}`,
            name: data.name,
            parentId: data.parentId ?? activeEnvId ?? 'core',
            variables: data.variables ?? [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          envList = [...envList, newEnv];
          return newEnv;
        },
        envSwitch: async (id: string) => {
          activeEnvId = id;
        },
        envDelete: async () => {},
        onEnvChanged: () => {},
        sendRequest: async () => ({
          success: true,
          response: {
            id: 'resp-1',
            requestId: 'req-1',
            status: 200,
            statusText: 'OK',
            headers: [],
            body: '{}',
            size: 2,
            timestamp: Date.now(),
            timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
            cookies: [],
          },
        }),
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };

      (window as any).__envState = {
        get list() { return envList; },
        get activeId() { return activeEnvId; },
      };
    });

    await page.goto('/');
  });

  test('starts with Core as the active environment', async ({ page }) => {
    await expect(page.getByTestId('sidebar').getByRole('button', { name: 'Core' })).toBeVisible();
    await expect(page.getByText('Create first environment')).toBeHidden();
    await expect(page.getByText('Env: Core')).toBeVisible();

    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.activeId).toBe('core');
    expect(state.list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'core', name: 'Core' }),
    ]));
  });

  test('selects a child environment under Core', async ({ page }) => {
    await page.getByRole('button', { name: 'Local' }).click();

    await expect(page.getByText('Env: Local')).toBeVisible();

    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.activeId).toBe('env-local');
    expect(state.list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'env-local', name: 'Local', parentId: 'core' }),
    ]));
  });

  test('creates a child environment from the editor', async ({ page }) => {
    await page.getByRole('button', { name: 'Env: Core' }).click();

    const editor = page.getByTestId('environment-editor');
    await expect(editor).toBeVisible();

    await editor.getByRole('button', { name: 'Create child environment' }).click();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Child of Core');

    await editor.getByTestId('environment-editor-name').fill('Local Overrides');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByPlaceholder('Key').last().fill('baseUrl');
    await editor.getByPlaceholder('Value').last().fill('http://localhost:4000');
    await editor.getByRole('button', { name: 'Create Environment' }).click();

    await expect(page.getByText('Env: Local Overrides')).toBeVisible();
    await expect(page.getByTestId('sidebar').getByRole('button', { name: 'Local Overrides' })).toBeVisible();

    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.activeId).toBe('env-local-overrides');
  });
});
