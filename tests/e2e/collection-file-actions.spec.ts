import { expect, test, type Page } from '@playwright/test';
import {
  createMockGroup,
  createMockRequest,
  createResponseResult,
  createTextResponse,
  installMockApi,
  type MockWindow,
} from './fixtures/mockApi';
import type { ResponseTiming } from '../../src/shared/types';

const request = createMockRequest({ id: 'orders', name: 'List orders', url: 'https://api.test/orders' });
const folder = createMockGroup({ id: 'shop', name: 'Shop', children: [] });

function harness(page: Page) {
  return page.evaluate(() => {
    const { curlExportRequests, exportFileRequests, importFileAttempts } = (window as unknown as MockWindow).__mockApi;
    return { curlExportRequests, exportFileRequests, importFileAttempts };
  });
}

async function openContextMenu(page: Page, testId: string) {
  await page.getByTestId(testId).click({ button: 'right' });
}

test('Copy as cURL sends the open request with the active environment and reports warnings', async ({ page }) => {
  await installMockApi(page, {
    nodes: [request],
    environments: [{ id: 'core', name: 'Core', variables: [], createdAt: 1, updatedAt: 1 }],
    curlExportResult: { copied: true, command: "curl 'https://api.test/orders'", warnings: ['No cached OAuth 2.0 token: send the request once, then copy again to include its Authorization header.'] },
  });
  await page.goto('/');
  await openContextMenu(page, 'sidebar-request-row-orders');
  await page.getByRole('button', { name: 'Copy as cURL' }).click();

  await expect(page.getByTestId('collection-notice')).toContainText('Copied as cURL for bash/zsh. No cached OAuth 2.0 token');
  const { curlExportRequests } = await harness(page);
  expect(curlExportRequests).toHaveLength(1);
  expect(curlExportRequests[0]).toMatchObject({ request: { id: 'orders', url: 'https://api.test/orders' }, environmentId: 'core' });

  await page.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(page.getByTestId('collection-notice')).toHaveCount(0);
});

test('Copy as cURL failures are shown as errors', async ({ page }) => {
  await installMockApi(page, { nodes: [request], curlExportResult: { copied: false, message: 'Variable context unavailable.' } });
  await page.goto('/');
  await openContextMenu(page, 'sidebar-request-row-orders');
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  await expect(page.getByRole('alert')).toContainText('Copy as cURL failed: Variable context unavailable.');
});

test('folders offer Export but not Copy as cURL; exporting passes the folder ID', async ({ page }) => {
  await installMockApi(page, { nodes: [folder, request], exportFileResult: { saved: true, path: 'C:\\out\\shop.restiprocity.json', requests: 3, groups: 2 } });
  await page.goto('/');
  await openContextMenu(page, 'sidebar-group-row-shop');
  await expect(page.getByRole('button', { name: 'Copy as cURL' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Export…' }).click();

  await expect(page.getByTestId('collection-notice')).toContainText('Exported 3 requests and 2 folders. The file includes authentication credentials.');
  expect((await harness(page)).exportFileRequests).toEqual(['shop']);
});

test('Export entire collection passes no ID; a cancelled dialog shows nothing and a failure is an error', async ({ page }) => {
  await installMockApi(page, { nodes: [request], exportFileResult: { saved: false, reason: 'cancelled' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Export entire collection' }).click();
  await expect.poll(async () => (await harness(page)).exportFileRequests.length).toBe(1);
  expect((await harness(page)).exportFileRequests[0] ?? null).toBeNull();
  await expect(page.getByTestId('collection-notice')).toHaveCount(0);

  await page.evaluate(() => {
    const api = (window as unknown as MockWindow).api;
    api.exportCollectionFile = async () => ({ saved: false, reason: 'failed', message: 'EACCES: permission denied' });
  });
  await page.getByRole('button', { name: 'Export entire collection' }).click();
  await expect(page.getByRole('alert')).toContainText('Export failed: EACCES: permission denied');
});

test('Import adds the imported items to the tree and reports counts', async ({ page }) => {
  const imported = createMockRequest({ id: 'imported', name: 'Imported request' });
  await installMockApi(page, { nodes: [request], importFileResult: { imported: true, requests: 1, groups: 0, environments: 0, warnings: [] }, importFileNodes: [imported] });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-request-row-imported')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import collection from file' }).click();

  await expect(page.getByTestId('collection-notice')).toContainText('Imported 1 request.');
  await expect(page.getByTestId('sidebar-request-row-imported')).toBeVisible();
  expect((await harness(page)).importFileAttempts).toBe(1);
});

test('Import rejection messages are shown verbatim', async ({ page }) => {
  await installMockApi(page, {
    nodes: [request],
    importFileResult: { imported: false, reason: 'failed', message: 'Only Postman collection v2.1 exports are supported.' },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import collection from file' }).click();
  await expect(page.getByRole('alert')).toHaveText(/^Only Postman collection v2\.1/);
});

test('An Insomnia import lists environments and what could not be carried over, and refreshes environments', async ({ page }) => {
  const folderNode = createMockGroup({ id: 'insomnia-root', name: 'Insomnia Airlines', children: ['flights'] });
  const flights = createMockRequest({ id: 'flights', name: 'List flights', parentId: 'insomnia-root' });
  const now = Date.now();
  await installMockApi(page, {
    nodes: [request],
    environments: [{ id: 'core', name: 'Core', variables: [], createdAt: now, updatedAt: now }],
    importFileResult: {
      imported: true,
      requests: 1,
      groups: 1,
      environments: 1,
      warnings: ['Digest authentication isn\'t supported; it was not imported for "List flights".'],
    },
    importFileNodes: [folderNode, flights],
    importFileEnvironments: [{ id: 'airlines', name: 'Insomnia Airlines', parentId: 'core', variables: [], createdAt: now, updatedAt: now }],
  });
  await page.goto('/');
  await expect(page.getByTestId('environment-selector-airlines')).toHaveCount(0);
  await page.getByRole('button', { name: 'Import collection from file' }).click();

  const notice = page.getByTestId('collection-notice');
  await expect(notice).toContainText('Imported 1 request, 1 folder and 1 environment. Some things could not be carried over:');
  await expect(page.getByTestId('collection-notice-details').getByRole('listitem')).toHaveText(['Digest authentication isn\'t supported; it was not imported for "List flights".']);
  await expect(page.getByTestId('environment-selector-airlines')).toHaveCount(1);
  await expect(page.getByTestId('sidebar-group-row-insomnia-root')).toBeVisible();
});

async function showTimings(page: Page, timings: ResponseTiming) {
  await installMockApi(page, { nodes: [request], defaultResponse: createResponseResult(createTextResponse({ requestId: 'orders', text: 'ok', timings })) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Timings' }).click();
}

test('Timings tab shows measured DNS/TCP/TLS for a new connection', async ({ page }) => {
  await showTimings(page, { dns: 12, tcp: 20, tls: 31, ttfb: 90, download: 10, total: 100, connection: 'new-tcp' });
  await expect(page.getByTestId('timing-connection')).toHaveText('New TCP connection');
  await expect(page.getByTestId('timing-dns')).toContainText('12');
  await expect(page.getByTestId('timing-tcp')).toContainText('20');
  await expect(page.getByTestId('timing-tls')).toContainText('31');
});

test('Timings tab labels reused, QUIC and unmeasured connections instead of showing 0ms', async ({ page }) => {
  await showTimings(page, { dns: 0, tcp: 0, tls: 0, ttfb: 5, download: 1, total: 6, connection: 'reused' });
  await expect(page.getByTestId('timing-connection')).toContainText('Reused an existing connection');
  await expect(page.getByTestId('timing-tcp')).toContainText('Reused connection');
  await expect(page.getByTestId('timing-tls')).toContainText('Reused connection');
});

test('Timings tab reports QUIC handshakes and legacy unmeasured snapshots honestly', async ({ page }) => {
  await showTimings(page, { dns: 4, tcp: 0, tls: 25, ttfb: 40, download: 2, total: 42, connection: 'new-quic' });
  await expect(page.getByTestId('timing-tcp')).toContainText('Not used (QUIC)');
  await expect(page.getByTestId('timing-tls')).toContainText('25');

  await showTimings(page, { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 });
  await expect(page.getByTestId('timing-connection')).toContainText('weren’t measured');
  for (const phase of ['dns', 'tcp', 'tls']) await expect(page.getByTestId(`timing-${phase}`)).toContainText('Not measured');
});
