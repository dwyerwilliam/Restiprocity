import { test, expect } from '@playwright/test';

test.describe('Request send error handling', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const request = {
        id: 'req-1',
        type: 'request',
        name: 'Failing Request',
        method: 'GET',
        url: 'https://example.com/fail',
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
        collectionList: async () => ({ nodes: [{ ...request }] }),
        collectionExport: async () => ({ ...request }),
        envList: async () => [],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async () => null,
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
        envSwitch: async () => {},
        sendRequest: async ({ request }: { request: { url?: string } }) => {
          if (request.url?.includes('certificate-error')) {
            return {
              success: false,
              error: {
                kind: 'certificate',
                message: 'TLS certificate verification failed',
                rawMessage: 'fetch failed | caused by: self-signed certificate',
                code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
                url: request.url,
                retryable: false,
              },
            };
          }

          if (request.url?.includes('transport-error')) {
            return {
              success: false,
              error: {
                kind: 'transport',
                message: 'Network request failed before an HTTP response was received',
                rawMessage: 'fetch failed | caused by: connect ECONNREFUSED 127.0.0.1:9',
                code: 'ECONNREFUSED',
                url: request.url,
                retryable: true,
              },
            };
          }

          return {
            success: true,
            response: {
              id: 'resp-500',
              requestId: 'req-1',
              status: 500,
              statusText: 'Internal Server Error',
              headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
              body: '{"error":"server failed"}',
              timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
              timestamp: Date.now(),
              size: 25,
              cookies: [],
            },
          };
        },
        requestCancel: async () => {},
        onCollectionChanged: () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Failing Request').click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.com/fail');
  });

  test('shows certificate failure details in the response panel', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://certificate-error.example.test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Request failed', { exact: true })).toBeVisible();
    await expect(page.getByText('Certificate error')).toBeVisible();
    await expect(page.getByText('TLS certificate verification failed')).toBeVisible();
    await expect(page.getByText('DEPTH_ZERO_SELF_SIGNED_CERT', { exact: true })).toBeVisible();
    await expect(page.getByText('fetch failed | caused by: self-signed certificate')).toBeVisible();
    await expect(page.getByText('Send anyway (unsafe)')).toBeVisible();
  });

  test('shows generic transport failure details in the response panel', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://transport-error.example.test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Request failed', { exact: true })).toBeVisible();
    await expect(page.getByText('Transport error')).toBeVisible();
    await expect(page.getByText('Network request failed before an HTTP response was received')).toBeVisible();
    await expect(page.getByText('ECONNREFUSED', { exact: true })).toBeVisible();
    await expect(page.getByText('connect ECONNREFUSED 127.0.0.1:9')).toBeVisible();
    await expect(page.getByText('Send anyway (unsafe)')).toBeHidden();
  });

  test('keeps HTTP 500 as a normal response', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://example.com/http-500');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('500 Internal Server Error')).toBeVisible();
    await expect(page.getByText('Request failed', { exact: true })).toBeHidden();
  });
});
