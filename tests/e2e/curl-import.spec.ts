import { test, expect } from '@playwright/test';

test.describe('cURL clipboard import', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      type BrowserWindow = Window & typeof globalThis & {
        api: {
          collectionList: () => Promise<{ nodes: unknown[] }>;
          envList: () => Promise<unknown[]>;
          collectionCreate: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
          collectionDelete: () => Promise<void>;
          collectionUpdate: () => Promise<null>;
          collectionExport: (id: string) => Promise<Record<string, unknown> | null>;
          collectionDuplicate: () => Promise<null>;
          collectionReorder: () => Promise<null>;
          envSwitch: () => Promise<void>;
          sendRequest: () => Promise<null>;
          cancelRequest: () => Promise<void>;
          clipboardReadText: () => Promise<string>;
          onCollectionChanged: () => void;
          onConsoleLog: () => void;
        };
        __createdRequests?: Record<string, unknown>[];
      };

      const browserWindow = window as BrowserWindow;
      const requests: Record<string, unknown>[] = [];

      browserWindow.__createdRequests = requests;
      browserWindow.api = {
        collectionList: async () => ({ nodes: requests.map(request => ({ ...request, type: 'request' })) }),
        envList: async () => [{ id: 'core', name: 'Core', variables: [], createdAt: Date.now(), updatedAt: Date.now() }],
        collectionCreate: async (payload) => {
          const request = { ...payload, type: 'request' };
          requests.push(request);
          return request;
        },
        collectionDelete: async () => {},
        collectionUpdate: async () => null,
        collectionExport: async (id) => requests.find(request => request.id === id) ?? null,
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
        envSwitch: async () => {},
        sendRequest: async () => null,
        cancelRequest: async () => {},
        clipboardReadText: async () => `curl -X POST 'https://api.example.com/users?active=true&page=2' -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' --data '{"name":"Ada"}'`,
        importCurlFromClipboard: async () => {
          const now = Date.now();
          return {
            id: `req-${now}`,
            name: 'api.example.com/users',
            method: 'POST',
            url: 'https://api.example.com/users',
            headers: [
              { key: 'Content-Type', value: 'application/json', enabled: true },
              { key: 'Authorization', value: 'Bearer abc', enabled: true },
            ],
            parameters: [
              { key: 'active', value: 'true', enabled: true },
              { key: 'page', value: '2', enabled: true },
            ],
            body: { type: 'raw', raw: { language: 'json', content: '{"name":"Ada"}' } },
            auth: { type: 'none' },
            settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true, allowInsecureCertificates: false },
            scripts: {},
            createdAt: now,
            updatedAt: now,
          };
        },
        onCollectionChanged: () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
  });

  test('creates a selected request from clipboard cURL', async ({ page }) => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Request from Clipboard' }).click();

    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://api.example.com/users');
    await expect(page.getByTestId('request-url-preview')).toContainText('https://api.example.com/users?active=true&page=2');

    await page.getByRole('button', { name: 'Params' }).click();
    await expect(page.getByPlaceholder('Key').nth(0)).toHaveValue('active');
    await expect(page.getByPlaceholder('Value').nth(0)).toHaveValue('true');
    await expect(page.getByPlaceholder('Key').nth(1)).toHaveValue('page');
    await expect(page.getByPlaceholder('Value').nth(1)).toHaveValue('2');

    await page.getByRole('button', { name: 'Body' }).click();
    await expect(page.getByTestId('request-json-editor').locator('.cm-content')).toHaveText('{"name":"Ada"}');

    const createdRequest = await page.evaluate(() => {
      const browserWindow = window as Window & typeof globalThis & { __createdRequests?: Record<string, unknown>[] };
      return browserWindow.__createdRequests?.[0];
    });

    expect(createdRequest).toMatchObject({
      name: 'api.example.com/users',
      method: 'POST',
      url: 'https://api.example.com/users',
      parameters: [
        { key: 'active', value: 'true', enabled: true },
        { key: 'page', value: '2', enabled: true },
      ],
      headers: [
        { key: 'Content-Type', value: 'application/json', enabled: true },
        { key: 'Authorization', value: 'Bearer abc', enabled: true },
      ],
      body: {
        type: 'raw',
        raw: { language: 'json', content: '{"name":"Ada"}' },
      },
    });
  });
});
