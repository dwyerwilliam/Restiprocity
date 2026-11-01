import { expect, test, type Page } from '@playwright/test';
import {
  createDownloadResponse,
  createImageResponse,
  createMockRequest,
  createTextResponse,
  installMockApi,
} from './fixtures/mockApi';
import { toPersistedResponseV2 } from '../../src/shared/responseContracts';
import type { HistoryEntry, ResponseV2 } from '../../src/shared/types';

type HistoryStoreWindow = Window & {
  __requestStore?: {
    getState: () => {
      reopenHistory: (entry: HistoryEntry) => Promise<boolean>;
      cancelRequestOperation: (operationId: string | null) => boolean;
      historyReopenError?: string | null;
      activeOperationId?: string | null;
    };
    setState: (state: { historyReopenError?: string | null; isSending?: boolean; activeOperationId?: string | null }) => void;
  };
};

function createHistoryEntry(
  overrides: Partial<HistoryEntry> & Pick<HistoryEntry, 'id' | 'requestId' | 'requestName'>,
): HistoryEntry {
  return {
    method: 'GET',
    url: `https://example.test/${overrides.id}`,
    status: 200,
    timestamp: 1,
    duration: 2,
    size: 2,
    ...overrides,
  };
}

function createHistoryDetail(entry: HistoryEntry, response: ResponseV2): Record<string, unknown> {
  return {
    ...entry,
    ...toPersistedResponseV2(response),
    id: entry.id,
    requestId: entry.requestId,
    status: entry.status,
    timestamp: entry.timestamp,
    size: entry.size,
  };
}

function createEmptyResponse(requestId: string): ResponseV2 {
  const response = createTextResponse({ id: 'empty-response', requestId, status: 204, statusText: 'No Content', text: '' });
  return {
    ...response,
    size: 0,
    preview: { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'complete' },
  };
}

function createBinaryResponse(requestId: string): ResponseV2 {
  const downloadResponse = createDownloadResponse({
    id: 'binary-response',
    requestId,
    mediaType: 'application/octet-stream',
    state: 'failed',
    reason: 'binary',
    receivedBytes: 16,
    failure: { code: 'history-preview-unavailable', message: 'Binary bytes are not retained.' },
  });
  const download = downloadResponse.download;
  if (!download) throw new Error('Binary fixture requires download metadata');
  return {
    ...downloadResponse,
    preview: {
      kind: 'binary',
      mediaType: 'application/octet-stream',
      capturedBytes: 0,
      totalBytes: 16,
      truncated: true,
      download,
    },
  };
}

async function openHistory(page: Page, requestName: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('sidebar').getByText(requestName, { exact: true }).click();
  await page.getByRole('button', { name: 'Show History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
}

async function expandEntry(page: Page, entryId: string) {
  const row = page.getByTestId(`history-row-${entryId}`);
  const entryButton = row.locator('[role="button"]').first();
  await entryButton.focus();
  await page.keyboard.press('Enter');
  const reopen = row.getByRole('button', { name: 'Reopen', exact: true });
  await expect(reopen).toBeVisible();
  return { row, reopen };
}

test.describe('history reopen UI', () => {
  test('reopens from the keyboard, retains expansion, and shows restored cookie redaction', async ({ page }) => {
    const request = createMockRequest({ id: 'history-ui-request', name: 'History UI request', url: 'https://example.test/current' });
    const entry = createHistoryEntry({ id: 'history-ui-entry', requestId: request.id, requestName: request.name, url: request.url });
    const response = createTextResponse({
      requestId: request.id,
      text: 'historical-body',
      headers: [
        { key: 'content-type', value: 'text/plain', enabled: true },
        { key: 'Set-Cookie', value: 'session=history-secret', enabled: true },
      ],
      cookies: [{ name: 'session', value: 'history-secret', domain: 'example.test', path: '/', httpOnly: true, secure: true, sameSite: 'lax' }],
    });
    await installMockApi(page, {
      nodes: [request],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });

    await openHistory(page, request.name);
    const { row, reopen } = await expandEntry(page, entry.id);
    await reopen.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('historical-response-notice')).toContainText('reopening did not send a request');
    await expect(page.getByText('historical-body', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expect(page.getByTestId('response-cookies-redacted')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('history-secret');
    await expect.poll(() => page.evaluate(() => ({
      sends: window.__mockApi.sendAttempts,
      updates: window.__mockApi.collectionUpdateAttempts,
      historyGets: window.__mockApi.historyGetAttempts,
    }))).toEqual({ sends: 0, updates: 0, historyGets: 1 });
  });

  test('keeps the reopened response readable at phone width', async ({ page }) => {
    const request = createMockRequest({ id: 'history-narrow-request', name: 'History narrow request' });
    const entry = createHistoryEntry({ id: 'history-narrow-entry', requestId: request.id, requestName: request.name });
    const response = createTextResponse({ requestId: request.id, text: 'narrow-history-body' });
    await installMockApi(page, {
      nodes: [request],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Show History', exact: true }).click();

    const { row, reopen } = await expandEntry(page, entry.id);
    await reopen.click();

    await expect(page.getByTestId('historical-response-notice')).toBeVisible();
    await expect(page.getByText('narrow-history-body', { exact: true })).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCSS('width', '56px');
    await expect(page.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    await expect(row.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('disables duplicate reopen calls while the detail is pending', async ({ page }) => {
    const request = createMockRequest({ id: 'history-pending-request', name: 'History pending request' });
    const entry = createHistoryEntry({ id: 'history-pending-entry', requestId: request.id, requestName: request.name });
    const response = createTextResponse({ requestId: request.id, text: 'pending-body' });
    await installMockApi(page, {
      nodes: [request],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await openHistory(page, request.name);
    const { row, reopen } = await expandEntry(page, entry.id);
    await page.evaluate(() => {
      const originalHistoryGet = window.api.historyGet;
      const browserWindow = window as Window & { __resolveHistoryDetail?: () => Promise<void> };
      window.api.historyGet = async () => new Promise((resolve) => {
        browserWindow.__resolveHistoryDetail = async () => {
          resolve(await originalHistoryGet('history-pending-entry'));
        };
      });
    });

    await reopen.click();
    const pendingReopen = row.getByTestId(`history-reopen-${entry.id}`);
    await expect(pendingReopen).toBeDisabled();
    await expect(pendingReopen).toHaveText('Reopening…');
    await expect(page.getByTestId(`history-reopen-pending-${entry.id}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__mockApi.sendAttempts)).toBe(0);

    await page.evaluate(async () => {
      const browserWindow = window as Window & { __resolveHistoryDetail?: () => Promise<void> };
      await browserWindow.__resolveHistoryDetail?.();
    });
    await expect(page.getByTestId('historical-response-notice')).toBeVisible();
  });

  test('reopens deleted history as a labeled temporary request without persistence or sending', async ({ page }) => {
    const currentRequest = createMockRequest({ id: 'history-deleted-current', name: 'Current request' });
    const entry = createHistoryEntry({
      id: 'history-deleted-entry',
      requestId: 'missing-collection-request',
      requestName: 'Deleted history request',
      method: 'POST',
      url: 'https://user:password@example.test/private?token=secret-token&visible=yes',
    });
    const response = createTextResponse({ requestId: entry.requestId, text: 'deleted-history-body' });
    await installMockApi(page, {
      nodes: [currentRequest],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await openHistory(page, currentRequest.name);
    const { row, reopen } = await expandEntry(page, entry.id);
    await expect(row).toContainText('https://example.test/private?token=%5BREDACTED%5D&visible=yes');
    await expect(row).not.toContainText('user:password');
    await expect(row).not.toContainText('secret-token');
    await reopen.click();

    await expect(page.getByTestId('temporary-request-banner')).toBeVisible();
    await expect(page.getByTestId('historical-response-notice')).toContainText('cannot be sent');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByText('deleted-history-body', { exact: true })).toBeVisible();
    await expect(page.getByTestId('sidebar').getByText(entry.requestName, { exact: true })).toHaveCount(0);
    const state = await page.evaluate(() => {
      const current = window.__requestStore?.getState();
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}') as Record<string, unknown>;
      return { request: current?.currentRequest, origin: current?.currentOrigin, drafts };
    });
    expect(state.request?.url).toContain('visible=yes');
    expect(state.request?.url).not.toContain('password');
    expect(state.request?.url).not.toContain('secret-token');
    expect(state.origin).toMatchObject({ kind: 'deleted-history', historyId: entry.id });
    expect(state.drafts[state.request?.id ?? '']).toBeUndefined();
    await expect.poll(() => page.evaluate(() => ({
      sends: window.__mockApi.sendAttempts,
      updates: window.__mockApi.collectionUpdateAttempts,
    }))).toEqual({ sends: 0, updates: 0 });
  });

  test('disables Reopen and Retry while an active request operation exists', async ({ page }) => {
    const request = createMockRequest({ id: 'history-action-busy-request', name: 'History action busy request' });
    const entry = createHistoryEntry({ id: 'history-action-busy-entry', requestId: request.id, requestName: request.name });
    const response = createTextResponse({ requestId: request.id, text: 'busy-history-body' });
    await installMockApi(page, {
      nodes: [request],
      sendMode: 'pending',
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.goto('/');
    await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => window.__mockApi.pendingOperations.size === 1);
    await page.getByRole('button', { name: 'Show History', exact: true }).click();

    const { row, reopen } = await expandEntry(page, entry.id);
    await expect(reopen).toBeDisabled();

    await page.evaluate((historyEntry) => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      const operationId = store.getState().activeOperationId;
      store.getState().cancelRequestOperation(operationId ?? null);
    });
    await expect.poll(() => page.evaluate(() => window.__mockApi.pendingOperations.size)).toBe(0);

    await page.evaluate(() => {
      let failed = false;
      const originalHistoryGet = window.api.historyGet;
      window.api.historyGet = async (id) => {
        if (!failed) {
          failed = true;
          throw new Error('History service unavailable');
        }
        return originalHistoryGet(id);
      };
    });
    await reopen.click();
    await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();

    await page.evaluate(() => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      store.setState({ historyReopenError: 'Retryable history error', isSending: true, activeOperationId: 'active-operation' });
    });
    await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeDisabled();
    await expect(reopen).toBeDisabled();

    await page.evaluate(() => {
      const store = window.__requestStore;
      if (!store) throw new Error('Missing request store');
      store.setState({ historyReopenError: null, isSending: false, activeOperationId: null });
    });
    await page.evaluate(() => {
      const store = window.__requestStore;
      const operationId = store?.getState().activeOperationId;
      store?.getState().cancelRequestOperation(operationId ?? null);
    });
  });

  test('reports a recoverable failure and retries the same history entry', async ({ page }) => {
    const request = createMockRequest({ id: 'history-retry-request', name: 'History retry request' });
    const entry = createHistoryEntry({ id: 'history-retry-entry', requestId: request.id, requestName: request.name });
    const response = createTextResponse({ requestId: request.id, text: 'retried-history-body' });
    await installMockApi(page, {
      nodes: [request],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await openHistory(page, request.name);
    const { row, reopen } = await expandEntry(page, entry.id);
    await page.evaluate(() => {
      let failed = false;
      const originalHistoryGet = window.api.historyGet;
      window.api.historyGet = async (id) => {
        if (!failed) {
          failed = true;
          throw new Error('History service unavailable');
        }
        return originalHistoryGet(id);
      };
    });

    await reopen.click();
    await expect(row.getByRole('alert')).toContainText('History service unavailable');
    await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('retried-history-body', { exact: true })).toBeVisible();
    await expect(page.getByTestId('historical-response-notice')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__mockApi.sendAttempts)).toBe(0);
  });

  test('renders empty, truncated text, unavailable image, binary, and download history states', async ({ page }) => {
    const request = createMockRequest({ id: 'history-variants-request', name: 'History variants request' });
    const entries = [
      createHistoryEntry({ id: 'history-empty', requestId: request.id, requestName: request.name, status: 204 }),
      createHistoryEntry({ id: 'history-truncated', requestId: request.id, requestName: request.name }),
      createHistoryEntry({ id: 'history-image', requestId: request.id, requestName: request.name }),
      createHistoryEntry({ id: 'history-binary', requestId: request.id, requestName: request.name }),
      createHistoryEntry({ id: 'history-download', requestId: request.id, requestName: request.name }),
    ];
    const imageResponse = createImageResponse({ requestId: request.id, bytes: new Uint8Array([0, 1, 2, 3]), mediaType: 'image/png' });
    const downloadResponse = createDownloadResponse({ requestId: request.id, mediaType: 'application/pdf', state: 'saved', reason: 'attachment', receivedBytes: 32, suggestedFileName: 'history.pdf' });
    await installMockApi(page, {
      nodes: [request],
      historyEntries: entries,
      historyDetails: {
        'history-empty': createHistoryDetail(entries[0], createEmptyResponse(request.id)),
        'history-truncated': createHistoryDetail(entries[1], createTextResponse({ requestId: request.id, text: 'captured-prefix', truncated: true, completeness: 'truncated', capturedBytes: 15, totalBytes: 99 })),
        'history-image': createHistoryDetail(entries[2], imageResponse),
        'history-binary': createHistoryDetail(entries[3], createBinaryResponse(request.id)),
        'history-download': createHistoryDetail(entries[4], downloadResponse),
      },
    });
    await openHistory(page, request.name);

    const cases = [
      { id: 'history-empty', testId: 'response-empty-body' },
      { id: 'history-truncated', testId: 'response-truncated' },
      { id: 'history-image', testId: 'response-image-unavailable' },
      { id: 'history-binary', testId: 'response-binary-unavailable' },
      { id: 'history-download', testId: 'download-progress' },
    ];
    for (const responseCase of cases) {
      const { reopen } = await expandEntry(page, responseCase.id);
      await reopen.click();
      await expect(page.getByTestId(responseCase.testId)).toBeVisible();
    }
    await expect.poll(() => page.evaluate(() => window.__mockApi.sendAttempts)).toBe(0);
  });
});
