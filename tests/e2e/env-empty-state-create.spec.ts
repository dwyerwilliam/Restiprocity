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
        rejectSave: false,
        rejectCreate: false,
        createCalls: 0,
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
          envTest.createCalls += 1;
          if (envTest.rejectCreate) { envTest.rejectCreate = false; throw new Error('private create error'); }
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
        envUpdate: async (id: string, data: Partial<MockEnvironment>) => {
          if (envTest.rejectSave) { envTest.rejectSave = false; throw new Error('private save error'); }
          const updated = { ...envList.find(env => env.id === id)!, ...data, id };
          envList = envList.map(env => env.id === id ? updated : env);
          return updated;
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
    await editor.getByRole('button', { name: 'Confirm delete' }).click();

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
    await editor.getByRole('button', { name: 'Confirm delete' }).click();

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

  test('renames, edits standard and secret variables, and removes a variable', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Shared');
    await editor.getByLabel('Variable key 1', { exact: true }).fill('baseUrl');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('https://example.test');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 2', { exact: true }).fill('token');
    await editor.getByLabel('Variable type 2').selectOption('secret');
    await editor.getByLabel('Variable value 2', { exact: true }).fill('test-secret');
    await expect(editor.getByLabel('Variable value 2', { exact: true })).toHaveAttribute('type', 'password');
    await editor.getByRole('button', { name: 'Show secret 2' }).click();
    await expect(editor.getByLabel('Variable value 2', { exact: true })).toHaveAttribute('type', 'text');
    await editor.getByRole('button', { name: 'Hide secret 2' }).click();
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor.getByRole('status')).toHaveText('Changes saved.');
    await expect(page.getByRole('button', { name: 'Env: Shared' })).toBeVisible();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    await expect(editor.getByLabel('Variable value 2', { exact: true })).toHaveAttribute('type', 'password');
    await editor.getByRole('button', { name: 'Remove variable 1' }).click();
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    expect(await page.evaluate(() => (window as any).__envState.list.find((env: any) => env.id === 'core')))
      .toMatchObject({ name: 'Shared', variables: [{ key: 'token', value: 'test-secret', type: 'secret' }] });
  });

  test('editor selection does not activate; switching preserves unsaved edits', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    expect(await page.evaluate(() => (window as any).__envState.activeId)).toBe('core');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('draft value');
    await page.evaluate(() => { (window as any).__envTest.rejectSwitch = true; });
    await editor.getByRole('button', { name: 'Switch to environment' }).click();
    await expect(editor.getByRole('alert')).toContainText('Unable to switch environment');
    await expect(editor.getByLabel('Variable value 1', { exact: true })).toHaveValue('draft value');
    await editor.getByRole('button', { name: 'Switch to environment' }).click();
    await expect(page.getByRole('button', { name: 'Env: Local' })).toBeVisible();
    await expect(editor.getByLabel('Variable value 1', { exact: true })).toHaveValue('draft value');
    await expect(editor.getByRole('button', { name: 'Active environment' })).toBeDisabled();
  });

  test('failed saves retain edits and can be retried without exposing raw errors', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Renamed');
    await page.evaluate(() => { (window as any).__envTest.rejectSave = true; });
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor.getByRole('alert')).toContainText('Unable to save environment');
    await expect(editor.getByRole('alert')).not.toContainText('private save error');
    await editor.getByRole('button', { name: 'Refresh environments' }).click();
    await expect(editor.getByRole('alert')).toBeHidden();
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Renamed');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: 'Env: Renamed' })).toBeVisible();
  });

  test('creates subsequent nested environments from the sidebar', async ({ page }) => {
    await page.getByTestId('environment-selector-env-local').click();
    await page.getByRole('button', { name: 'Create child environment', exact: true }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Nested');
    await expect(editor.getByTestId('environment-editor-inherited')).toContainText('baseUrl');
    await page.evaluate(() => { (window as any).__envTest.rejectCreate = true; });
    await editor.getByRole('button', { name: 'Create Environment', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Unable to save environment');
    await editor.getByRole('button', { name: 'Create Environment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Env: Nested' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__envState.list.find((env: any) => env.name === 'Nested')))
      .toMatchObject({ parentId: 'env-local' });
    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    await expect(editor.getByRole('button', { name: 'Delete environment', exact: true })).toBeDisabled();
    await expect(editor.getByText('Delete child environments first to preserve their inheritance.')).toBeVisible();
  });

  test('create commits once when subsequent activation fails', async ({ page }) => {
    await page.getByRole('button', { name: 'Create child environment', exact: true }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Saved Child');
    await page.evaluate(() => { (window as any).__envTest.rejectSwitch = true; });
    await editor.getByRole('button', { name: 'Create Environment', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Unable to switch environment');
    await expect(editor.getByRole('button', { name: 'Save Changes' })).toBeVisible();
    await editor.getByRole('button', { name: 'Switch to environment' }).click();
    await expect(page.getByRole('button', { name: 'Env: Saved Child' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__envTest.createCalls)).toBe(1);
  });

  test('rejects duplicate and missing variable keys without losing values', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('value');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor.getByRole('alert')).toContainText('Enter a key');
    await editor.getByLabel('Variable key 1', { exact: true }).fill('token');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 2', { exact: true }).fill(' token ');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor.getByRole('alert')).toContainText('Variable keys must be unique');
    await expect(editor.getByLabel('Variable value 1', { exact: true })).toHaveValue('value');
    expect(await page.evaluate(() => (window as any).__envState.list.find((env: any) => env.id === 'core').variables)).toEqual([]);
  });

  test('guards unsaved edits on navigation, child creation, and Escape', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Unsaved');
    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    await expect(editor.getByRole('alert')).toContainText('unsaved changes');
    await editor.getByRole('button', { name: 'Keep editing' }).click();
    await editor.getByRole('button', { name: 'Create child environment' }).click();
    await expect(editor.getByRole('alert')).toContainText('unsaved changes');
    await page.keyboard.press('Escape');
    await expect(editor.getByRole('alert')).toBeHidden();
    await page.keyboard.press('Escape');
    await editor.getByRole('button', { name: 'Discard changes' }).click();
    await expect(editor).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit selected environment' })).toBeFocused();
  });

  test('inherited cards support overriding without revealing secrets', async ({ page }) => {
    await page.getByTestId('environment-selector-env-local').click();
    await page.getByRole('button', { name: 'Create child environment', exact: true }).click();
    const editor = page.getByTestId('environment-editor');
    await expect(editor.getByTestId('environment-editor-tree-item-env-local')).toContainText('active');
    const inherited = editor.getByTestId('environment-editor-inherited');
    await expect(inherited).toContainText('from Local');
    await inherited.getByRole('button', { name: 'Override baseUrl' }).click();
    await expect(editor.getByLabel('Variable key 1')).toHaveValue('baseUrl');
    await expect(editor.getByLabel('Variable value 1')).toHaveValue('http://localhost:3000');
    await expect(inherited).toContainText('Overridden locally');
    await inherited.getByRole('button', { name: /Inherited variables/ }).click();
    await expect(inherited.getByText('Overridden locally')).toBeHidden();
  });

  test('sidebar actions create a child under a non-active environment', async ({ page }) => {
    const row = page.getByTestId('environment-selector-env-local');
    await row.focus();
    await page.getByTestId('environment-add-child-env-local').click();
    const editor = page.getByTestId('environment-editor');
    await expect(editor.getByTestId('environment-editor-name')).toHaveValue('Child of Local');
    await expect(page.getByRole('button', { name: 'Env: Core' })).toBeVisible();
  });
  test('delete can be cancelled without removing the environment', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-tree-item-env-local').click();
    await editor.getByRole('button', { name: 'Delete environment', exact: true }).click();
    await editor.getByRole('button', { name: 'Keep environment' }).click();
    await expect(editor.getByRole('alert')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__envState.list.some((env: any) => env.id === 'env-local'))).toBe(true);
  });

  test('editor remains usable at mobile width and contains keyboard focus', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Env: Core' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Environment' });
    await expect(editor).toBeVisible();
    await editor.getByTestId('environment-editor-name').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator(':focus')).toHaveCount(1);
    await editor.getByRole('button', { name: 'Save Changes' }).focus();
    await page.keyboard.press('Tab');
    await expect(editor.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('environment-editor-390.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('environment-editor-1440.png') });
  });
  test('interpolation editor resolves nested draft values, masks secrets, and preserves multiline text', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByLabel('Variable key 1', { exact: true }).fill('token');
    await editor.getByLabel('Variable type 1').selectOption('secret');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('fixture-secret');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 2', { exact: true }).fill('auth');
    await editor.getByLabel('Variable value 2', { exact: true }).fill('Bearer {{token}}');
    await editor.getByRole('button', { name: 'Edit interpolation 2' }).click();
    const interpolation = page.getByRole('region', { name: 'Interpolation editor' });
    await expect(interpolation).toContainText('contains a secret');
    await expect(interpolation).not.toContainText('fixture-secret');
    await interpolation.getByLabel('Stored value').fill('Bearer {{token}}\nsecond line');
    await interpolation.getByRole('button', { name: 'Apply to draft' }).click();
    await expect(editor.getByRole('button', { name: 'Variable value 2: multiline' })).toBeVisible();
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    const list = await page.evaluate(() => (window as any).__envState.list);
    expect(list.find((item: any) => item.id === 'core').variables[1].value).toBe('Bearer {{token}}\nsecond line');
  });
  test('request preview masks a transitive secret and shows interpolation errors', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByLabel('Variable key 1', { exact: true }).fill('token');
    await editor.getByLabel('Variable type 1').selectOption('secret');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('fixture-secret');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 2', { exact: true }).fill('derived');
    await editor.getByLabel('Variable value 2', { exact: true }).fill('https://example.test/{{token}}');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 3', { exact: true }).fill('loop');
    await editor.getByLabel('Variable value 3', { exact: true }).fill('{{loop}}');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const url = page.getByPlaceholder('Enter request URL');
    await url.fill('{{derived}}');
    await expect(page.getByTestId('request-url-preview')).toContainText('contains a secret');
    await expect(page.getByTestId('request-url-preview')).not.toContainText('fixture-secret');
    await url.fill('{{loop}}');
    await expect(page.getByTestId('request-url-preview')).toContainText('Interpolation error');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  });
  test('interpolation picker filters references and protects an unsaved nested draft', async ({ page }) => {
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByLabel('Variable key 1', { exact: true }).fill('path');
    await editor.getByLabel('Variable value 1', { exact: true }).fill('prefix/');
    await editor.getByRole('button', { name: 'Edit interpolation 1' }).click();
    const pane = page.getByRole('region', { name: 'Interpolation editor' });
    await pane.getByLabel('Stored value').focus();
    await page.keyboard.press('End');
    await pane.getByLabel('Filter variables').fill('uuid');
    await expect(pane.getByRole('button', { name: /timestamp/ })).toHaveCount(0);
    await pane.getByRole('button', { name: /uuid.*Built-in/ }).click();
    await expect(pane.getByLabel('Stored value')).toHaveValue('prefix/{{uuid}}');
    await expect(pane.getByLabel('Stored value')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(pane.getByLabel('Stored value')).toHaveValue('prefix/');
    await pane.getByRole('button', { name: /uuid.*Built-in/ }).click();
    await expect(pane.getByLabel('Stored value')).toHaveValue('prefix/{{uuid}}');
    await page.keyboard.press('Escape');
    await expect(pane.getByRole('alert')).toContainText('Discard changes');
    await pane.getByRole('button', { name: 'Keep editing' }).click();
    await expect(pane.getByLabel('Stored value')).toHaveValue('prefix/{{uuid}}');
    await pane.getByRole('button', { name: 'Apply to draft' }).click();
    await expect(editor.getByLabel('Variable value 1', { exact: true })).toHaveValue('prefix/{{uuid}}');
  });
});
