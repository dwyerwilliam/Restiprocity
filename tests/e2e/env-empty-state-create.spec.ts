import { test, expect } from '@playwright/test';

test.describe('Environment Empty State Create', () => {
  test.beforeEach(async ({ page }) => {
    // Mock window.api with empty environment list
    await page.addInitScript(() => {
      let envList = [];
      let activeEnvId: string | null = null;

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
        envCreate: async (data: { name: string; variables: unknown[] }) => {
          const newEnv = {
            id: 'env-new',
            name: data.name,
            variables: data.variables,
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

      // Expose state for test assertions
      (window as any).__envState = {
        get list() { return envList; },
        get activeId() { return activeEnvId; },
      };
    });

    await page.goto('/');
  });

  test('shows create CTA when no environments exist', async ({ page }) => {
    await expect(page.getByText('Create first environment')).toBeVisible();
  });

  test('creates a new environment from the empty state inline form', async ({ page }) => {
    await page.getByText('Create first environment').click();

    const nameInput = page.getByPlaceholder('Environment name');
    await expect(nameInput).toBeVisible();

    await nameInput.fill('Production');
    await nameInput.press('Enter');

    await expect(page.getByRole('button', { name: 'Production' })).toBeVisible({ timeout: 5000 });

    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.activeId).toBe('env-new');
    expect(state.list).toHaveLength(1);
    expect(state.list[0].name).toBe('Production');
  });

  test('cancels creation with Escape key', async ({ page }) => {
    await page.getByText('Create first environment').click();

    const nameInput = page.getByPlaceholder('Environment name');
    await expect(nameInput).toBeVisible();

    await nameInput.fill('Test');
    await nameInput.press('Escape');

    await expect(page.getByText('Create first environment')).toBeVisible();
    await expect(nameInput).not.toBeVisible();
  });

  test('does not create environment with empty name', async ({ page }) => {
    await page.getByText('Create first environment').click();

    const nameInput = page.getByPlaceholder('Environment name');
    await nameInput.press('Enter');

    await expect(page.getByText('Create first environment')).toBeVisible();

    const state = await page.evaluate(() => (window as any).__envState);
    expect(state.list).toHaveLength(0);
  });
});
