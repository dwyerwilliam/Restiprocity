import { test, expect } from '@playwright/test';

test.describe('Collection & Sidebar Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const group = {
        id: 'group-1',
        type: 'group',
        name: 'My API',
        children: ['req-1'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const requests = [
        {
          id: 'req-1',
          type: 'request',
          name: 'GET /users',
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/users',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      (window as any).api = {
        collectionList: async () => ({
          nodes: [{ ...group }, ...requests.map(r => ({ ...r }))],
        }),
        envList: async () => [
          { id: 'env-base', name: 'Base Environment', variables: {} },
        ],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async () => null,
        collectionExport: async (id: string) => {
          if (id === group.id) return { ...group };
          return requests.find(r => r.id === id) ?? null;
        },
        collectionDuplicate: async (id: string) => {
          const original = requests.find(r => r.id === id);
          if (original) {
            const copy = {
              ...original,
              id: `req-copy-${Date.now()}`,
              name: `${original.name} (copy)`,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            requests.push(copy);
            return copy;
          }
          return null;
        },
        collectionReorder: async () => null,
        envSwitch: async () => {},
        requestSend: async () => null,
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
  });

  test('duplicate request creates a new entry with (copy) suffix', async ({ page }) => {
    // Verify original request exists
    await expect(page.getByText('GET /users')).toBeVisible();

    // Right-click on the request to open context menu
    await page.getByText('GET /users').first().click({ button: 'right' });

    // Click Duplicate in the context menu
    await page.getByText('Duplicate').click();

    // After duplication, the collection reloads — both original and copy should appear
    await expect(page.getByText('GET /users').first()).toBeVisible();
    await expect(page.getByText('GET /users (copy)')).toBeVisible({ timeout: 5000 });
  });

  test('sidebar can be collapsed and restored', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');

    // Sidebar is initially expanded
    await expect(sidebar).toHaveCSS('width', /^256px$/);

    // Collapse the sidebar
    await page.getByTitle('Collapse sidebar').click();
    await expect(sidebar).toHaveCSS('width', /^0px$|^1px$/, { timeout: 3000 });

    // Expand button should appear when sidebar is collapsed
    await expect(page.getByTitle('Expand sidebar')).toBeVisible({ timeout: 3000 });

    // Click the expand button to restore sidebar
    await page.getByTitle('Expand sidebar').click();

    // Sidebar should be expanded again
    await expect(sidebar).toHaveCSS('width', /^256px$/, { timeout: 3000 });

    // Collections header should be visible again
    await expect(page.getByText('Collections')).toBeVisible();
  });
});
