import { test, expect } from '@playwright/test';
import { createResponseResult, createTextResponse } from './fixtures/mockApi';

test.describe('Request send error handling', () => {
  test.beforeEach(async ({ page }) => {
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

    const certificateFailure = {
      version: 2,
      operationId: 'fixture-operation',
      kind: 'failed',
      error: {
        kind: 'certificate',
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
        message: 'TLS certificate verification failed',
        retryable: false,
      },
    } as const;

    const transportFailure = {
      version: 2,
      operationId: 'fixture-operation',
      kind: 'failed',
      error: {
        kind: 'transport',
        code: 'ECONNREFUSED',
        message: 'Network request failed before an HTTP response was received',
        retryable: true,
      },
    } as const;

    const certificateBypass = createResponseResult(createTextResponse({
      id: 'resp-cert-bypass',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      text: '{"ok":true}',
      format: 'json',
      headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
    }));

    const http500 = createResponseResult(createTextResponse({
      id: 'resp-500',
      requestId: 'req-1',
      status: 500,
      statusText: 'Internal Server Error',
      text: '{"error":"server failed"}',
      format: 'json',
      headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
    }));

    await page.addInitScript(
      ({ requestData, certificateFailureData, certificateBypassData, transportFailureData, http500Data }) => {
        type SendAttemptRequest = { url?: string; settings?: { allowInsecureCertificates?: boolean } };
        type BrowserWindow = Window & typeof globalThis & {
          __sendAttempts?: number;
          __lastSendRequest?: SendAttemptRequest;
          api: {
            collectionList: () => Promise<{ nodes: unknown[] }>;
            collectionExport: () => Promise<typeof requestData>;
            envList: () => Promise<unknown[]>;
            collectionCreate: () => Promise<null>;
            collectionDelete: () => Promise<void>;
            collectionUpdate: () => Promise<null>;
            collectionDuplicate: () => Promise<null>;
            collectionReorder: () => Promise<null>;
            envSwitch: () => Promise<void>;
            sendRequest: (payload: { request: SendAttemptRequest }) => Promise<unknown>;
            requestCancel: () => Promise<void>;
            onCollectionChanged: () => void;
            onConsoleLog: () => void;
          };
        };

        const browserWindow = window as BrowserWindow;
        browserWindow.api = {
          collectionList: async () => ({ nodes: [{ ...requestData }] }),
          collectionExport: async () => ({ ...requestData }),
          envList: async () => [],
          collectionCreate: async () => null,
          collectionDelete: async () => {},
          collectionUpdate: async () => null,
          collectionDuplicate: async () => null,
          collectionReorder: async () => null,
          envSwitch: async () => {},
          sendRequest: async ({ request }) => {
            browserWindow.__sendAttempts = (browserWindow.__sendAttempts ?? 0) + 1;
            browserWindow.__lastSendRequest = request;

            if (request.url?.includes('certificate-error') && !request.settings?.allowInsecureCertificates) {
              return certificateFailureData;
            }

            if (request.url?.includes('certificate-error') && request.settings?.allowInsecureCertificates) {
              return certificateBypassData;
            }

            if (request.url?.includes('transport-error')) {
              return transportFailureData;
            }

            return http500Data;
          },
          requestCancel: async () => {},
          onCollectionChanged: () => {},
          onConsoleLog: () => {},
        };
      },
      {
        requestData: request,
        certificateFailureData: certificateFailure,
        certificateBypassData: certificateBypass,
        transportFailureData: transportFailure,
        http500Data: http500,
      },
    );

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Failing Request').click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.com/fail');
  });

  test('shows certificate failure details in the response panel', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://certificate-error.example.test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Request failed', { exact: true })).toBeVisible();
    await expect(page.getByText('Certificate error')).toBeVisible();
    await expect(page.locator('div').filter({ hasText: /^TLS certificate verification failed$/ }).first()).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'TLS certificate verification failed' }).first()).toBeVisible();
    await expect(page.getByText('Send anyway (unsafe)')).toBeVisible();
  });

  test('send anyway retries certificate failures with insecure certificates enabled', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://certificate-error.example.test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.locator('div').filter({ hasText: /^TLS certificate verification failed$/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Send anyway (unsafe)' }).click();

    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Request failed', { exact: true })).toBeHidden();

    const retryState = await page.evaluate(() => ({
      attempts: (window as Window & typeof globalThis & { __sendAttempts?: number }).__sendAttempts,
      lastRequest: (window as Window & typeof globalThis & { __lastSendRequest?: { settings?: { allowInsecureCertificates?: boolean } } }).__lastSendRequest,
    }));
    expect(retryState.attempts).toBe(2);
    expect(retryState.lastRequest.settings.allowInsecureCertificates).toBe(true);
  });

  test('shows generic transport failure details in the response panel', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://transport-error.example.test');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Request failed', { exact: true })).toBeVisible();
    await expect(page.getByText('Transport error')).toBeVisible();
    await expect(page.locator('div').filter({ hasText: /^Network request failed before an HTTP response was received$/ }).first()).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'Network request failed before an HTTP response was received' }).first()).toBeVisible();
    await expect(page.getByText('Send anyway (unsafe)')).toBeHidden();
  });

  test('keeps HTTP 500 as a normal response', async ({ page }) => {
    await page.getByPlaceholder('Enter request URL').fill('https://example.com/http-500');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('500 Internal Server Error')).toBeVisible();
    await expect(page.getByText('Request failed', { exact: true })).toBeHidden();
  });
});
