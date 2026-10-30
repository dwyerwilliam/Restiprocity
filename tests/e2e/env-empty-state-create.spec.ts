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
      let activeEnvId: string | null = sessionStorage.getItem('task10-active-id') ?? 'core';
      const envTest = {
        holdSettings: sessionStorage.getItem('task10-hold-settings') === '1',
        rejectSettings: sessionStorage.getItem('task10-reject-settings') === '1',
        holdSwitch: false,
        rejectSwitch: false,
        holdCreate: false,
        releaseSettings: undefined as (() => void) | undefined,
        releaseSwitch: undefined as (() => void) | undefined,
        releaseCreate: undefined as (() => void) | undefined,
        switchCalls: [] as string[],
        lastSendEnvironmentId: undefined as string | undefined,
      };

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
          if (envTest.holdCreate) {
            await new Promise<void>(resolve => { envTest.releaseCreate = resolve; });
          }
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
          envTest.switchCalls.push(id);
          if (envTest.holdSwitch) {
            await new Promise<void>(resolve => { envTest.releaseSwitch = resolve; });
          }
          if (envTest.rejectSwitch) {
            envTest.rejectSwitch = false;
            throw new Error('Switch failed at C:\\private\\settings.json');
          }
          activeEnvId = id;
          return activeEnvId;
        },
        envDelete: async (id: string) => {
          if (id === 'core') return activeEnvId ?? 'core';
          envList = envList.filter(env => env.id !== id);
          if (activeEnvId === id) {
            activeEnvId = 'core';
          }
          return activeEnvId;
        },
        settingsGet: async () => ({
          ...(envTest.holdSettings
            ? await new Promise<Record<string, never>>(resolve => {
              envTest.releaseSettings = () => resolve({});
            })
            : {}),
          ...(envTest.rejectSettings
            ? (() => {
              envTest.rejectSettings = false;
              sessionStorage.removeItem('task10-reject-settings');
              throw new Error('Load failed at C:\\private\\settings.json');
            })()
            : {}),
          activeEnvironmentId: activeEnvId,
          theme: 'dark',
          fontSize: 14,
          fontFamily: 'JetBrains Mono, Fira Code, monospace',
          defaultTimeout: 30000,
          defaultFollowRedirect: true,
          autoSaveHistory: true,
          maxHistorySize: 1000,
        }),
        onEnvChanged: () => {},
        sendRequest: async (payload: { operationId: string; environmentId?: string }) => {
          envTest.lastSendEnvironmentId = payload.environmentId;
          return {
            version: 2,
            operationId: payload.operationId,
            kind: 'response',
            response: {
              version: 2,
              id: 'resp-1',
              requestId: 'req-1',
              status: 200,
              statusText: 'OK',
              headers: [],
              preview: {
                kind: 'text',
                format: 'json',
                text: '{}',
                parseState: 'valid',
                charset: 'utf-8',
                decodeError: false,
                capturedBytes: 2,
                totalBytes: 2,
                truncated: false,
                completeness: 'complete',
              },
              size: 2,
              timestamp: Date.now(),
              timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
              cookies: [],
            },
          };
        },
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };

      (window as any).__envState = {
        get list() { return envList; },
        get activeId() { return activeEnvId; },
      };
      (window as any).__envTest = envTest;
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

    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Local');

    await editor.getByTestId('environment-editor-tree-item-core').click();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Core');

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

  test('deletes an environment inline without closing the editor', async ({ page }) => {
    await page.getByRole('button', { name: 'Env: Core' }).click();

    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Local');

    await editor.getByRole('button', { name: 'Delete environment' }).click();

    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Core');
    await expect(editor.getByTestId('environment-editor-tree-item-env-local')).toBeHidden();
    await expect(editor.getByRole('button', { name: 'Delete environment' })).toBeHidden();

    const switchCalls = await page.evaluate(() => (window as any).__envTest.switchCalls);
    expect(switchCalls).toEqual([]);
  });

  test('deletes a non-active environment without changing the active selection', async ({ page }) => {
    await page.getByRole('button', { name: 'Env: Core' }).click();

    const coreEditor = page.getByTestId('environment-editor');
    await coreEditor.getByRole('button', { name: 'Create child environment' }).click();
    await coreEditor.getByTestId('environment-editor-name').fill('Other');
    await coreEditor.getByRole('button', { name: 'Create Environment' }).click();
    await expect(page.getByText('Env: Other')).toBeVisible();
    await coreEditor.getByTestId('environment-editor-close').click();

    await page.getByTestId('environment-selector-env-local').click();
    await page.getByRole('button', { name: 'Env: Local' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-tree-item-env-other').click();
    await editor.getByRole('button', { name: 'Delete environment' }).click();

    await expect(page.getByText('Env: Local')).toBeVisible();
    await expect(editor.getByTestId('environment-editor-tree-item-env-other')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('env-local');
  });

  test('sends the canonical active environment ID', async ({ page }) => {
    await page.getByTestId('environment-selector-env-local').click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    expect(await page.evaluate(() => (window as any).__envTest.lastSendEnvironmentId)).toBe('env-local');
  });

  test('restores the persisted child selection after reload', async ({ page }) => {
    await page.evaluate(() => sessionStorage.setItem('task10-active-id', 'env-local'));
    await page.reload();

    await expect(page.getByText('Env: Local')).toBeVisible();
    await expect(page.getByTestId('environment-selector-env-local')).toHaveAttribute('aria-current', 'true');
    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.activeId).toBe('env-local');
  });

  test('failed switch retains selection and can be retried', async ({ page }) => {
    await page.evaluate(() => { (window as any).__envTest.rejectSwitch = true; });
    await page.getByTestId('environment-selector-env-local').click();

    await expect(page.getByRole('alert')).toContainText('Unable to switch environment');
    await expect(page.getByText('Env: Core')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('core');
    expect(await page.getByRole('alert').innerText()).not.toContain('C:\\private');

    await page.getByTestId('environment-selector-env-local').click();
    await expect(page.getByText('Env: Local')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('env-local');
  });

  test('startup pending blocks Send until settings acknowledgement', async ({ page }) => {
    await page.evaluate(() => sessionStorage.setItem('task10-hold-settings', '1'));
    await page.reload();

    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      (window as any).__envTest.releaseSettings?.();
    });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  });

  test('startup failure shows retryable error and recovers', async ({ page }) => {
    await page.evaluate(() => sessionStorage.setItem('task10-reject-settings', '1'));
    await page.reload();

    await expect(page.getByRole('alert')).toContainText('Unable to load environments');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Retry environments' }).click();
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  });

  test('selects duplicate environment names by ID', async ({ page }) => {
    await page.addInitScript(() => {
      const duplicate: MockEnvironment = {
        id: 'env-local-copy',
        name: 'Local',
        parentId: 'core',
        variables: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const originalEnvList = window.api.envList;
      window.api.envList = async () => [...await originalEnvList(), duplicate];
    });
    await page.reload();

    await expect(page.getByTestId('environment-selector-env-local-copy')).toBeVisible();
    await page.getByTestId('environment-selector-env-local-copy').click();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('env-local-copy');
    await page.getByTestId('environment-selector-env-local').click();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('env-local');
  });

  test('creates and selects an environment only after the create acknowledgement', async ({ page }) => {
    await page.evaluate(() => { (window as any).__envTest.holdCreate = true; });
    await page.getByRole('button', { name: 'Env: Core' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByRole('button', { name: 'Create child environment' }).click();
    await editor.getByTestId('environment-editor-name').fill('Delayed Environment');
    await editor.getByRole('button', { name: 'Create Environment' }).click();

    await expect(page.getByText('Env: Core')).toBeVisible();
    await page.evaluate(() => { (window as any).__envTest.releaseCreate?.(); });
    await expect(page.getByText('Env: Delayed Environment')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('env-delayed-environment');
  });
});
