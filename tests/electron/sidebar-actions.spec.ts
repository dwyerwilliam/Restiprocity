import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from '@playwright/test';

/**
 * The sidebar against the real store, real IPC and the real renderer. The E2E suite mocks window.api, and
 * a mock that adds a field the store never returns hides bugs: requests from collection:list carry no
 * `type`, only groups do, so any renderer code that tests `type === 'request'` passes there and fails here.
 */

type Launched = { app: ElectronApplication; page: Page };

const repoRoot = path.resolve(__dirname, '..', '..');
const settings = { followRedirect: true, timeout: 5000, cookiesEnabled: true };

async function launch(userData: string): Promise<Launched> {
  const app = await _electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.api?.collectionCreate === 'function', undefined, { timeout: 60_000 });
  await page.getByTestId('sidebar').waitFor();
  return { app, page };
}

async function withApp(run: (launched: Launched) => Promise<void>): Promise<void> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-sidebar-'));
  let launched: Launched | undefined;
  try {
    launched = await launch(userData);
    await run(launched);
  } finally {
    if (launched) await launched.app.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true });
  }
}

const requestBody = (name: string, url: string, parentId?: string) => ({
  name, method: 'GET', url, headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' }, settings, scripts: {},
  nodeType: 'request', ...(parentId ? { parentId } : {}),
});

const curl = (url: string) => `curl '${url}' \\\n  -A 'Restiprocity' \\\n  -L \\\n  -m 5`;

/** Right-clicks a row and returns the context menu's button labels. The menu stays open. */
async function openMenu(page: Page, testId: string): Promise<string[]> {
  await page.getByTestId(testId).click({ button: 'right' });
  const duplicate = page.getByRole('button', { name: 'Duplicate' });
  await duplicate.waitFor();
  return (await duplicate.locator('xpath=..').locator('button').allTextContents()).map(label => label.trim());
}

/** Any click closes the menu; use a blank part of the sidebar. */
async function dismissMenu(page: Page): Promise<void> {
  await page.getByTestId('sidebar').click({ position: { x: 150, y: 600 } });
  await expect(page.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);
}

test('request rows offer Copy as cURL, folders do not, and the copy reaches the clipboard once per click', async () => withApp(async ({ app, page }) => {
  test.fail(true, "R1 (RELEASE_READINESS_PLAN.md): the context menu tests node.type === 'request', which requests from the real store lack. Remove this line with the fix.");
  // Observe the OS boundary in the real main process without owning the shared system clipboard.
  await app.evaluate(({ clipboard }) => {
    (globalThis as any).__curlClipboardWrites = [];
    clipboard.writeText = (value: string) => { (globalThis as any).__curlClipboardWrites.push(value); };
  });
  const folder = await page.evaluate(() => window.api.collectionCreate({ name: 'Orders', children: [], nodeType: 'group' }));
  const root = await page.evaluate(body => window.api.collectionCreate(body), requestBody('Root request', 'https://example.test/root'));
  const nested = await page.evaluate(body => window.api.collectionCreate(body), requestBody('Nested request', 'https://example.test/nested', folder.id));

  // The shape the renderer really receives: only groups carry a type.
  const listed = await page.evaluate(() => window.api.collectionList());
  expect(listed.find((node: { id: string }) => node.id === root.id).type).toBeUndefined();
  expect(listed.find((node: { id: string }) => node.id === nested.id).type).toBeUndefined();
  expect(listed.find((node: { id: string }) => node.id === folder.id).type).toBe('group');

  await page.reload();
  const rootRow = `sidebar-request-row-${root.id}`;
  const nestedRow = `sidebar-request-row-${nested.id}`;
  const folderRow = `sidebar-group-row-${folder.id}`;
  await expect(page.getByTestId(rootRow)).toBeVisible();
  await expect(page.getByTestId(nestedRow)).toBeVisible();

  expect(await openMenu(page, rootRow)).toEqual(['Rename', 'Duplicate', 'Copy as cURL', 'Export…', 'Delete']);
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  await expect(page.getByTestId('collection-notice')).toContainText('Copied as cURL for bash/zsh.');

  expect(await openMenu(page, nestedRow)).toEqual(['Rename', 'Duplicate', 'Copy as cURL', 'Export…', 'Delete']);
  await page.getByRole('button', { name: 'Copy as cURL' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__curlClipboardWrites.length)).toBe(2);
  expect(await app.evaluate(() => (globalThis as any).__curlClipboardWrites)).toEqual([curl('https://example.test/root'), curl('https://example.test/nested')]);

  expect(await openMenu(page, folderRow)).toEqual(['Rename', 'Duplicate', 'Export…', 'Delete']);
  await dismissMenu(page);
  expect(await app.evaluate(() => (globalThis as any).__curlClipboardWrites.length)).toBe(2);
}));

test('folders and requests made with the sidebar controls appear, rename, duplicate and delete without a reload', async () => withApp(async ({ page }) => {
  const groupRows = page.locator('[data-testid^="sidebar-group-row-"]');
  const requestRows = page.locator('[data-testid^="sidebar-request-row-"]');
  await expect(groupRows).toHaveCount(0);
  await expect(requestRows).toHaveCount(0);

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Folder' }).click();
  await expect(groupRows).toHaveCount(1);
  await expect(groupRows.first()).toContainText('New Folder');

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Request', exact: true }).click();
  await expect(requestRows).toHaveCount(1);
  const renameInput = requestRows.first().locator('input[type="text"]');
  await expect(renameInput).toBeFocused();
  await renameInput.fill('Created request');
  await renameInput.press('Enter');
  await expect(requestRows.first()).toContainText('Created request');
  await expect(renameInput).toHaveCount(0);

  const requestTestId = (await requestRows.first().getAttribute('data-testid'))!;
  await openMenu(page, requestTestId);
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(requestRows).toHaveCount(2);

  await openMenu(page, requestTestId);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(requestRows).toHaveCount(1);
  await expect(groupRows).toHaveCount(1);

  // The store agrees with what the sidebar shows.
  const stored = await page.evaluate(() => window.api.collectionList());
  expect(stored.map((node: { name: string; type?: string }) => [node.name, node.type ?? 'request']).sort()).toEqual([
    ['Created request (copy)', 'request'],
    ['New Folder', 'group'],
  ]);
}));
