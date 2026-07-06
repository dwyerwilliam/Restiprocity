import { test, expect } from '@playwright/test';

test.describe('Request editor persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      let onCollectionChanged: (() => void) | null = null;

      const group = {
        id: 'group-1',
        type: 'group',
        name: 'API',
        children: ['req-1', 'req-2'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const request = {
        id: 'req-1',
        type: 'request',
        name: 'Persisted Request',
        method: 'GET',
        url: 'https://example.com',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const otherRequest = {
        id: 'req-2',
        type: 'request',
        name: 'Other Request',
        method: 'GET',
        url: 'https://example.com/other',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (window as any).api = {
        collectionList: async () => ({ nodes: [{ ...group }, { ...request }, { ...otherRequest }] }),
        envList: async () => [],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id: string, payload: any) => {
          if (_id === request.id) {
            (window as any).__lastCollectionUpdate = { id: _id, payload };
            Object.assign(request, payload, { updatedAt: Date.now() });
            onCollectionChanged?.();
            return { ...request };
          }
          if (_id === otherRequest.id) {
            (window as any).__lastCollectionUpdate = { id: _id, payload };
            Object.assign(otherRequest, payload, { updatedAt: Date.now() });
            onCollectionChanged?.();
            return { ...otherRequest };
          }
          return null;
        },
        collectionExport: async (id: string) => {
          if (id === group.id) return { ...group };
          if (id === request.id) return { ...request };
          if (id === otherRequest.id) return { ...otherRequest };
          return null;
        },
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
        envSwitch: async () => {},
        requestSend: async () => null,
        requestCancel: async () => {},
        onCollectionChanged: (callback: () => void) => {
          onCollectionChanged = callback;
        },
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Persisted Request').click();
  });

  test('keeps values when switching between tabs', async ({ page }) => {
    await page.getByRole('button', { name: 'Headers' }).click();
    await page.getByRole('button', { name: '+ Add' }).click();
    const headerKey = page.getByPlaceholder('Key').first();
    const headerValue = page.getByPlaceholder('Value').first();
    await headerKey.fill('X-Test');
    await headerValue.fill('123');

    await page.getByRole('button', { name: 'Params' }).click();
    await page.getByRole('button', { name: '+ Add' }).click();
    const paramKey = page.getByPlaceholder('Key').first();
    const paramValue = page.getByPlaceholder('Value').first();
    await paramKey.fill('search');
    await paramValue.fill('alpha');

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const bodyTextarea = page.locator('textarea');
    await bodyTextarea.fill('{"hello":"world"}');

    await page.getByRole('button', { name: 'Auth' }).click();
    await page.locator('select').nth(1).selectOption('bearer');
    await page.getByPlaceholder('Token').fill('secret-token-123');
    await page.getByPlaceholder('Prefix').fill('Bearer');

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Follow Redirects').click();
    const timeoutInput = page.locator('input[type="number"]');
    await timeoutInput.fill('12345');

    await page.getByRole('button', { name: 'Headers' }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('X-Test');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('123');

    await page.getByRole('button', { name: 'Params' }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('search');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('alpha');

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    await expect(page.locator('textarea')).toHaveValue('{"hello":"world"}');

    await page.getByRole('button', { name: 'Auth' }).click();
    await page.locator('select').nth(1).selectOption('bearer');
    await expect(page.getByPlaceholder('Token')).toHaveValue('secret-token-123');
    await expect(page.getByPlaceholder('Prefix')).toHaveValue('Bearer');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Follow Redirects')).not.toBeChecked();
    await expect(timeoutInput).toHaveValue('12345');
  });

  test('keeps bearer auth when switching to another request and back', async ({ page }) => {
    await page.getByRole('button', { name: 'Auth' }).click();
    await page.locator('select').nth(1).selectOption('bearer');
    await page.getByPlaceholder('Token').fill('secret-token-abc');
    await page.getByPlaceholder('Prefix').fill('Bearer');
    await page.waitForFunction(() => (window as any).__lastCollectionUpdate?.payload?.auth?.bearer?.token === 'secret-token-abc');

    const savedRequest = await page.evaluate(async () => (window as any).api.collectionExport('req-1'));
    expect(savedRequest.auth.type).toBe('bearer');
    expect(savedRequest.auth.bearer.token).toBe('secret-token-abc');

    await page.locator('[data-testid="sidebar"]').getByText('Other Request').click();
    await page.locator('[data-testid="sidebar"]').getByText('Persisted Request').click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.com');

    const savedRequestAfterReturn = await page.evaluate(async () => (window as any).api.collectionExport('req-1'));
    expect(savedRequestAfterReturn.auth.type).toBe('bearer');
    expect(savedRequestAfterReturn.auth.bearer.token).toBe('secret-token-abc');

    await page.getByRole('button', { name: 'Auth' }).click();
    await expect(page.locator('select').nth(1)).toHaveValue('bearer');
    await expect(page.getByPlaceholder('Token')).toHaveValue('secret-token-abc');
    await expect(page.getByPlaceholder('Prefix')).toHaveValue('Bearer');
  });
});
