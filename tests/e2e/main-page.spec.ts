import { test, expect } from '@playwright/test';

test.describe('Main Page Smoke Test', () => {
  test.beforeEach(async ({ page }) => {
    // Mock window.api (normally provided by Electron preload script)
    await page.addInitScript(() => {
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
              children: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        }),
        envList: async () => [
          { id: 'env-base', name: 'Base Environment', variables: {} },
          { id: 'env-dev', name: 'Development', variables: { baseUrl: 'http://localhost:3000' } },
        ],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async () => null,
        collectionDuplicate: async () => null,
        envSwitch: async () => {},
        requestSend: async () => null,
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
  });

  test('renders all main UI sections', async ({ page }) => {
    // Sidebar should be visible
    await expect(page.getByText('Collections')).toBeVisible();

    // Environment selector label should show (exact match to avoid strict mode violation)
    await expect(page.getByText('Environment', { exact: true })).toBeVisible();

    // At least one environment button should render
    await expect(page.getByRole('button', { name: 'Base Environment' })).toBeVisible();

    // Request Editor should be visible (method selector + URL bar + Send button)
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();

    // Status bar should be present at the bottom
    await expect(page.getByText('v0.1.6')).toBeVisible();

    // Collection tree nodes should render
    await expect(page.getByText('My API')).toBeVisible();
    await expect(page.getByText('GET /users').first()).toBeVisible();
  });

  test('sidebar can be collapsed', async ({ page }) => {
    await expect(page.getByText('Collections')).toBeVisible();

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toHaveCSS('width', /^256px$/);

    await page.getByTitle('Collapse sidebar').click();

    // Sidebar collapses to w-0 — content still in DOM but visually hidden (1px from border)
    await expect(sidebar).toHaveCSS('width', /^0px$|^1px$/, { timeout: 3000 });
  });

  test('can select a request from the tree', async ({ page }) => {
    // Click on the request node (use .first() to avoid strict mode violation)
    await page.getByText('GET /users').first().click();

    // The node should have a selected/highlighted state
    const selectedNode = page.getByText('GET /users').first();
    await expect(selectedNode).toBeVisible();
    await expect(selectedNode.locator('..')).toHaveClass(/surface-active/);
  });

  test('can create a new request', async ({ page }) => {
    // Click "New Request" button
    await page.getByRole('button', { name: 'New Request' }).click();

    // After creation, the collection reloads — we should still see the tree
    await expect(page.getByText('My API')).toBeVisible();
  });

  test('environment search filters environments', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search environments...');
    await searchInput.fill('dev');

    // Should show Development but not Base Environment
    await expect(page.getByRole('button', { name: 'Development' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Base Environment' })).toBeHidden();
  });

  test('body editor supports form and multipart rows', async ({ page }) => {
    await page.getByRole('button', { name: 'Body' }).click();

    await page.getByRole('button', { name: 'Form URL' }).click();
    await expect(page.getByText('No form fields defined.')).toBeVisible();
    await page.getByRole('button', { name: '+ Add' }).click();
    const formKeyInput = page.getByPlaceholder('Key');
    const formValueInput = page.getByPlaceholder('Value');
    await formKeyInput.fill('username');
    await formValueInput.fill('sisyphus');
    await expect(formKeyInput).toHaveValue('username');
    await expect(formValueInput).toHaveValue('sisyphus');

    await page.getByRole('button', { name: 'Multipart' }).click();
    await expect(page.getByText('No multipart fields defined.')).toBeVisible();
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByRole('combobox').last().selectOption('file');
    const multipartKeyInput = page.getByPlaceholder('Key');
    const filePathInput = page.getByPlaceholder('File path');
    await multipartKeyInput.fill('avatar');
    await filePathInput.fill('C:\\tmp\\avatar.png');
    await expect(multipartKeyInput).toHaveValue('avatar');
    await expect(filePathInput).toHaveValue('C:\\tmp\\avatar.png');
  });
});
