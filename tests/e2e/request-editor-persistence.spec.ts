import { test, expect } from '@playwright/test';
import { composeRequestUrl, extractQueryParamsFromUrl, removeQueryFromUrl, removeQueryParamFromUrl } from '../../src/shared/urlVariables';
import { liveCookieResponse } from '../engine/fixtures/liveCookieResponse';
import type { Request, ResponseOperationResultV2, ResponseV2 } from '../../src/shared/types';
import { installPreviewApi, previewEnvironments, previewRequest, readPreview } from './fixtures/previewApi';
import { createMockGroup, createMockRequest, installMockApi } from './fixtures/mockApi';

test.describe('Request editor persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      type BrowserWindow = Window & typeof globalThis & {
        api: {
          collectionList: () => Promise<{ nodes: unknown[] }>;
          envList: () => Promise<unknown[]>;
          collectionCreate: () => Promise<null>;
          collectionDelete: () => Promise<void>;
          collectionUpdate: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
          collectionExport: (id: string) => Promise<unknown>;
          collectionDuplicate: () => Promise<null>;
          collectionReorder: () => Promise<null>;
           envSwitch: (id: string) => Promise<string>;
           envDelete: () => Promise<string>;
           settingsGet: () => Promise<Record<string, unknown>>;
          sendRequest: (payload: unknown) => Promise<unknown>;
          requestCancel: () => Promise<void>;
          onConsoleLog: () => void;
        };
        __lastCollectionUpdate?: { id: string; payload: Record<string, unknown> };
        __lastSendRequest?: unknown;
        __requestStore?: { getState: () => { currentRequest?: unknown } };
      };

      const bw = window as BrowserWindow;

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

      bw.api = {
        collectionList: async () => ({ nodes: [{ ...group }, { ...request }, { ...otherRequest }] }),
        envList: async () => [],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id, payload) => {
          if (_id === request.id) {
            bw.__lastCollectionUpdate = { id: _id, payload };
            Object.assign(request, payload, { updatedAt: Date.now() });
            return { ...request };
          }
          if (_id === otherRequest.id) {
            bw.__lastCollectionUpdate = { id: _id, payload };
            Object.assign(otherRequest, payload, { updatedAt: Date.now() });
            return { ...otherRequest };
          }
          return null;
        },
        collectionExport: async (id) => {
          if (id === group.id) return { ...group };
          if (id === request.id) return { ...request };
          if (id === otherRequest.id) return { ...otherRequest };
          return null;
        },
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
         envSwitch: async (id: string) => id,
         envDelete: async () => 'core',
         settingsGet: async () => ({
           theme: 'dark',
           fontSize: 14,
           fontFamily: 'JetBrains Mono, Fira Code, monospace',
           defaultTimeout: 30000,
           defaultFollowRedirect: true,
           autoSaveHistory: true,
           maxHistorySize: 1000,
         }),
        sendRequest: async (payload) => {
          bw.__lastSendRequest = payload;
          return null;
        },
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Persisted Request').click();
  });

  test('multipart fields persist and body errors remain editable for retry', async ({ page }) => {
    await page.locator('select').first().selectOption('POST');
    await page.getByRole('button', { name: 'Body', exact: true }).click();
    await page.getByRole('button', { name: 'Multipart', exact: true }).click();
    const editor = page.getByTestId('multipart-editor');
    await expect(editor.getByTestId('multipart-help')).toContainText('32 MiB');
    await editor.getByRole('button', { name: '+ Add', exact: true }).click();
    await editor.getByPlaceholder('Key').fill('upload');
    await editor.getByLabel('Multipart row 1 type').selectOption('file');
    await editor.getByPlaceholder('File path').fill('C:/fixture.bin');
    await editor.getByLabel('Multipart row 1 enabled').uncheck();
    await page.getByRole('button', { name: 'Headers', exact: true }).click();
    await page.getByRole('button', { name: 'Body', exact: true }).click();
    await expect(editor.getByPlaceholder('File path')).toHaveValue('C:/fixture.bin');
    await expect(editor.getByLabel('Multipart row 1 enabled')).not.toBeChecked();
    await editor.getByLabel('Multipart row 1 enabled').check();
    await page.evaluate(() => {
      (window as any).__multipartSends = 0;
      window.api.sendRequest = async payload => {
        (window as any).__multipartSends++;
        return { version: 2, operationId: payload.operationId, kind: 'failed', error: { kind: 'body', code: 'MULTIPART_FILE_NOT_FOUND', message: 'Multipart row 1: file not found. Check its file path.', retryable: false } };
      };
    });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Request body error', { exact: true })).toBeVisible();
    await expect(page.getByText('Multipart row 1: file not found. Check its file path.', { exact: true }).first()).toBeVisible();
    await editor.getByPlaceholder('File path').fill('C:/corrected.bin');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__multipartSends)).toBe(2);
  });

  test('keeps values when switching between tabs', async ({ page }) => {
    await page.getByRole('button', { name: 'Headers' }).click();
    await page.getByRole('button', { name: '+ Add' }).click();
    const headerKey = page.getByPlaceholder('Key').first();
    const headerValue = page.getByPlaceholder('Value').first();
    await headerKey.fill('X-Test');
    await headerValue.fill('123');

    await page.getByRole('button', { name: 'Params' }).click();
    await page.getByRole('button', { name: 'Add query parameter' }).click();
    await page.getByRole('menuitem', { name: 'Add empty row' }).click();
    const paramKey = page.getByPlaceholder('Key').first();
    const paramValue = page.getByPlaceholder('Value').first();
    await paramKey.fill('search');
    await paramValue.fill('alpha');

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const jsonEditor = page.getByTestId('request-json-editor').locator('.cm-content');
    await jsonEditor.fill('{"hello":"world"}');

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
    await expect(page.getByTestId('request-json-editor').locator('.cm-content')).toHaveText('{"hello":"world"}');

    await page.getByRole('button', { name: 'Auth' }).click();
    await page.locator('select').nth(1).selectOption('bearer');
    await expect(page.getByPlaceholder('Token')).toHaveValue('secret-token-123');
    await expect(page.getByPlaceholder('Prefix')).toHaveValue('Bearer');

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Follow Redirects')).not.toBeChecked();
    await expect(timeoutInput).toHaveValue('12345');
  });

  test('cookie values stay live only after sending and rewriting old cached drafts', async ({ page }) => {
    await page.evaluate((response) => {
      window.api.sendRequest = async ({ operationId }): Promise<ResponseOperationResultV2> => ({ kind: 'response', operationId, response });
    }, liveCookieResponse());

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'live-cookie-marker', exact: true })).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}')['req-1'].lastResponse);
    expect(saved.cookies).toEqual([]);
    expect(saved.headers.map((header: { key: string }) => header.key)).toEqual(['Content-Type', 'X-Unrelated']);
    expect(saved.preview.text).toBe('live-cookie-marker');

    await page.evaluate((response) => {
      const store = (window as Window & { __requestStore?: { getState: () => { currentRequest: Request; updateRequest: (updates: Partial<Request>) => void } } }).__requestStore;
      if (!store) throw new Error('Missing request store');
      const request = store.getState().currentRequest;
      const drafts = JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      drafts['req-2'] = { ...request, id: 'req-2', name: 'Other Request', lastResponse: response };
      localStorage.setItem('restiprocity:request-drafts', JSON.stringify(drafts));
    }, liveCookieResponse());
    await page.reload();
    await page.locator('[data-testid="sidebar"]').getByText('Persisted Request').click();
    await page.getByPlaceholder('Enter request URL').fill('https://example.test/rewrite');
    await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}')['req-1'].url)).toBe('https://example.test/rewrite');
    const rewritten = await page.evaluate(() => JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}')['req-2'].lastResponse);
    expect(rewritten.cookies).toEqual([]);
    expect(rewritten.headers.map((header: { key: string }) => header.key)).toEqual(['Content-Type', 'X-Unrelated']);
    expect(rewritten.preview.text).toBe('live-cookie-marker');
    await page.locator('[data-testid="sidebar"]').getByText('Other Request').click();
    await page.evaluate((response) => {
      const store = (window as Window & { __requestStore?: { getState: () => { updateRequest: (updates: Partial<Request>) => void; currentResponse: ResponseV2 } } }).__requestStore;
      if (!store) throw new Error('Missing request store');
      store.getState().updateRequest({ lastResponse: response });
    }, liveCookieResponse());
    const bypass = await page.evaluate(() => JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}')['req-2'].lastResponse);
    expect(bypass.cookies).toEqual([]);
    expect(bypass.headers.map((header: { key: string }) => header.key)).toEqual(['Content-Type', 'X-Unrelated']);
  });

  test('keeps bearer auth when switching to another request and back', async ({ page }) => {
    await page.getByRole('button', { name: 'Auth' }).click();
    await page.locator('select').nth(1).selectOption('bearer');
    await page.getByPlaceholder('Token').fill('secret-token-abc');
    await page.getByPlaceholder('Prefix').fill('Bearer');
    await page.waitForFunction(() => (window as Window & { __lastCollectionUpdate?: { payload?: { auth?: { bearer?: { token?: string } } } } }).__lastCollectionUpdate?.payload?.auth?.bearer?.token === 'secret-token-abc');

    const savedRequest = await page.evaluate(async () => (window as Window & { api: { collectionExport: (id: string) => Promise<unknown> } }).api.collectionExport('req-1'));
    expect(savedRequest.auth.type).toBe('bearer');
    expect(savedRequest.auth.bearer.token).toBe('secret-token-abc');

    await page.locator('[data-testid="sidebar"]').getByText('Other Request').click();
    await page.locator('[data-testid="sidebar"]').getByText('Persisted Request').click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.com');

    const savedRequestAfterReturn = await page.evaluate(async () => (window as Window & { api: { collectionExport: (id: string) => Promise<unknown> } }).api.collectionExport('req-1'));
    expect(savedRequestAfterReturn.auth.type).toBe('bearer');
    expect(savedRequestAfterReturn.auth.bearer.token).toBe('secret-token-abc');

    await page.getByRole('button', { name: 'Auth' }).click();
    await expect(page.locator('select').nth(1)).toHaveValue('bearer');
    await expect(page.getByPlaceholder('Token')).toHaveValue('secret-token-abc');
    await expect(page.getByPlaceholder('Prefix')).toHaveValue('Bearer');
  });

  test('shows query params in the URL preview and sends them with the request payload', async ({ page }) => {
    await page.getByRole('button', { name: 'Params' }).click();
    await page.getByRole('button', { name: 'Add query parameter' }).click();
    await page.getByRole('menuitem', { name: 'Add empty row' }).click();

    const paramKey = page.getByPlaceholder('Key').first();
    const paramValue = page.getByPlaceholder('Value').first();
    await paramKey.fill('search');
    await paramValue.fill('alpha');

    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: Array<{ key: string; value: string }> } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.some((param: { key: string; value: string }) => param.key === 'search' && param.value === 'alpha');
    });

    await expect(page.getByTestId('request-url-preview')).toContainText('https://example.com?search=alpha');

    await page.getByRole('button', { name: 'Send' }).click();
    const payload = await page.evaluate(() => (window as Window & { __lastSendRequest?: unknown }).__lastSendRequest);

    expect(payload.request.parameters).toEqual([
      expect.objectContaining({ key: 'search', value: 'alpha', enabled: true }),
    ]);
    expect(payload.request.parameters[0].enabled).toBe(true);
  });

  test('composeRequestUrl appends enabled query params without dropping existing query strings', async () => {
    expect(composeRequestUrl(
      'https://example.com/users',
      [{ key: 'page', value: '2', enabled: true }],
    )).toBe('https://example.com/users?page=2');

    expect(composeRequestUrl(
      'https://example.com/users?existing=1',
      [{ key: 'page', value: '2', enabled: true }],
    )).toBe('https://example.com/users?existing=1&page=2');

    expect(composeRequestUrl(
      'https://example.com/users',
      [{ key: 'skip', value: 'nope', enabled: false }],
      { type: 'api_key', api_key: { key: 'token', value: 'abc', in: 'query' } },
    )).toBe('https://example.com/users?token=abc');
  });

  test('extractQueryParamsFromUrl parses multiple params correctly', () => {
    const params = extractQueryParamsFromUrl('https://example.com?foo=bar&baz=qux');
    expect(params).toEqual([
      { key: 'foo', value: 'bar' },
      { key: 'baz', value: 'qux' },
    ]);
  });

  test('extractQueryParamsFromUrl URL-decodes param values', () => {
    const params = extractQueryParamsFromUrl('https://example.com?msg=hello%20world&name=caf%C3%A9');
    expect(params).toEqual([
      { key: 'msg', value: 'hello world' },
      { key: 'name', value: 'café' },
    ]);
  });

  test('extractQueryParamsFromUrl decodes + as space', () => {
    const params = extractQueryParamsFromUrl('https://example.com?q=hello+world');
    expect(params).toEqual([{ key: 'q', value: 'hello world' }]);
  });

  test('extractQueryParamsFromUrl returns empty array for URL without query string', () => {
    expect(extractQueryParamsFromUrl('https://example.com/path')).toEqual([]);
    expect(extractQueryParamsFromUrl('https://example.com')).toEqual([]);
  });

  test('extractQueryParamsFromUrl preserves hash fragment without including it', () => {
    const params = extractQueryParamsFromUrl('https://example.com?x=1#section');
    expect(params).toEqual([{ key: 'x', value: '1' }]);
  });

  test('removeQueryFromUrl strips query string but preserves hash', () => {
    expect(removeQueryFromUrl('https://example.com?foo=bar')).toBe('https://example.com');
    expect(removeQueryFromUrl('https://example.com/path?a=1#hash')).toBe('https://example.com/path#hash');
    expect(removeQueryFromUrl('https://example.com/noquery')).toBe('https://example.com/noquery');
  });

  test('removeQueryParamFromUrl removes one param while preserving hash', () => {
    expect(removeQueryParamFromUrl('https://example.com/path?a=1&b=two%20words#hash', 0)).toEqual({
      url: 'https://example.com/path?b=two%20words#hash',
      param: { key: 'a', value: '1' },
    });
    expect(removeQueryParamFromUrl('https://example.com/path?a=1#hash', 0)).toEqual({
      url: 'https://example.com/path#hash',
      param: { key: 'a', value: '1' },
    });
  });
});

test.describe('Query parameter extraction from URL', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      type BrowserWindow = Window & typeof globalThis & {
        api: {
          collectionList: () => Promise<{ nodes: unknown[] }>;
          envList: () => Promise<unknown[]>;
          collectionCreate: () => Promise<null>;
          collectionDelete: () => Promise<void>;
          collectionUpdate: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
          collectionExport: (id: string) => Promise<unknown>;
          collectionDuplicate: () => Promise<null>;
          collectionReorder: () => Promise<null>;
           envSwitch: (id: string) => Promise<string>;
           envDelete: () => Promise<string>;
           settingsGet: () => Promise<Record<string, unknown>>;
          sendRequest: (payload: unknown) => Promise<unknown>;
          requestCancel: () => Promise<void>;
          onConsoleLog: () => void;
        };
        __lastCollectionUpdate?: { id: string; payload: Record<string, unknown> };
        __requestStore?: { getState: () => { currentRequest?: unknown } };
      };

      const bw = window as BrowserWindow;

      const group = {
        id: 'group-1',
        type: 'group',
        name: 'API',
        children: ['req-1'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const request = {
        id: 'req-1',
        name: 'Query Param Test',
        method: 'GET',
        url: 'https://httpbin.org/get?name=william&tool=insomnia',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      bw.api = {
        collectionList: async () => ({ nodes: [{ ...group }, { ...request }] }),
        envList: async () => [],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id, payload) => {
          if (_id === request.id) {
            bw.__lastCollectionUpdate = { id: _id, payload };
            Object.assign(request, payload, { updatedAt: Date.now() });
            return { ...request };
          }
          return null;
        },
        collectionExport: async (id) => {
          if (id === group.id) return { ...group };
          if (id === request.id) return { ...request };
          return null;
        },
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
         envSwitch: async (id: string) => id,
         envDelete: async () => 'core',
         settingsGet: async () => ({
           theme: 'dark',
           fontSize: 14,
           fontFamily: 'JetBrains Mono, Fira Code, monospace',
           defaultTimeout: 30000,
           defaultFollowRedirect: true,
           autoSaveHistory: true,
           maxHistorySize: 1000,
         }),
        sendRequest: async () => null,
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Query Param Test').click();
  });

  test('shows a compact URL parameter action with per-parameter moves', async ({ page }) => {
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://httpbin.org/get?name=william&tool=insomnia');

    const urlParamsButton = page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' });
    await expect(urlParamsButton).toHaveCount(1);
    await urlParamsButton.click();

    await expect(page.getByRole('menuitem', { name: 'Move name to Params tab' })).toHaveCount(1);
    await expect(page.getByRole('menuitem', { name: 'Move tool to Params tab' })).toHaveCount(1);
  });

  test('long encoded URLs stay editable in one growing field', async ({ page }) => {
    const input = page.getByPlaceholder('Enter request URL');
    await expect(input).toHaveCount(1);
    await expect(page.getByRole('button', { name: /Expand URL editor|Collapse URL editor/ })).toHaveCount(0);
    const original = 'https://example.test/' + 'a'.repeat(300) + '?token=hello%20world&empty&plus=a+b#frag';
    await input.fill(original);
    await expect(input).toHaveCSS('color', 'rgb(205, 214, 244)');
    await input.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(25, 25); });
    await page.keyboard.type('EDIT');
    const edited = original.slice(0, 25) + 'EDIT' + original.slice(25);
    await expect(input).toHaveValue(edited);
    const grown = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(grown.height).toBeGreaterThan(32);
    expect(grown.height).toBeLessThanOrEqual(130);

    await input.fill('https://example.test/' + 'x'.repeat(10_000));
    const capped = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(capped.height).toBeLessThanOrEqual(130);
    expect(capped.scrollHeight).toBeGreaterThan(capped.height);
    expect(capped.overflowY).toBe('auto');

    await input.fill(edited + '-tail\r\nfiltered');
    await expect(input).toHaveValue(edited + '-tailfiltered');
    await input.press('End');
    await input.press('Enter');
    await expect(input).toHaveValue(edited + '-tailfiltered');
  });

  test('autocomplete stays available at the end of a wrapped URL', async ({ page }) => {
    const input = page.getByPlaceholder('Enter request URL');
    await input.fill('https://example.test/' + 'x'.repeat(2_000) + '?value=_.ti');
    await expect(page.getByText('timestamp', { exact: true })).toBeVisible();
    await input.press('Enter');
    await expect(input).toHaveValue(/\?value=\{\{timestamp\}\}$/);
  });

  test('moving one URL parameter sends it to the Params tab', async ({ page }) => {
    await page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move name to Params tab' }).click();

    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: unknown[] } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://httpbin.org/get?tool=insomnia');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('name');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('william');

    await page.getByRole('button', { name: 'Move 1 URL parameter to Params tab' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move tool to Params tab' })).toHaveCount(1);
  });

  test('moving a later URL parameter leaves earlier parameters in the URL', async ({ page }) => {
    await page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move tool to Params tab' }).click();

    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: unknown[] } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://httpbin.org/get?name=william');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('tool');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('insomnia');
  });

  test('moving all query params removes query string from URL', async ({ page }) => {
    await page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move name to Params tab' }).click();
    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: unknown[] } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length === 1;
    });

    await page.getByRole('button', { name: 'Move 1 URL parameter to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move tool to Params tab' }).click();
    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: unknown[] } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length === 2;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://httpbin.org/get');

    await page.getByRole('button', { name: 'Params' }).click();
    await expect(page.getByPlaceholder('Key').nth(0)).toHaveValue('name');
    await expect(page.getByPlaceholder('Value').nth(0)).toHaveValue('william');
    await expect(page.getByPlaceholder('Key').nth(1)).toHaveValue('tool');
    await expect(page.getByPlaceholder('Value').nth(1)).toHaveValue('insomnia');
  });

  test('URL with no query params shows no extraction buttons', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill('https://httpbin.org/get');
    await urlInput.blur();

    await page.waitForTimeout(200);

    await expect(page.getByRole('button', { name: /Move .* URL parameter.* to Params tab/ })).toHaveCount(0);
  });

  test('extracted params are enabled by default and appear in URL preview', async ({ page }) => {
    await page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move name to Params tab' }).click();

    await page.waitForFunction(() => {
      const request = (window as Window & { __requestStore?: { getState: () => { currentRequest?: { parameters?: unknown[] } } } }).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    await expect(page.getByTestId('request-url-preview')).toContainText('name=william');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    const checkbox = page.locator('input[type="checkbox"]').first();
    await expect(checkbox).toBeChecked();
  });

  test('extracted params are persisted via collectionUpdate', async ({ page }) => {
    await page.getByRole('button', { name: 'Move 2 URL parameters to Params tab' }).click();
    await page.getByRole('menuitem', { name: 'Move name to Params tab' }).click();

    await page.waitForFunction(() => {
      const update = (window as Window & { __lastCollectionUpdate?: { payload?: { parameters?: unknown[] } } }).__lastCollectionUpdate;
      return update?.payload?.parameters?.length > 0;
    });

    const savedUpdate = await page.evaluate(() => (window as Window & { __lastCollectionUpdate?: { payload?: { parameters?: unknown[]; url?: string } } }).__lastCollectionUpdate);
    expect(savedUpdate.payload.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', value: 'william', enabled: true }),
      ]),
    );
    expect(savedUpdate.payload.url).toBe('https://httpbin.org/get?tool=insomnia');
  });
});

test.describe('Draft response persistence compatibility', () => {
  test('recovers and rewrites malformed legacy response drafts', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.addInitScript(() => {
      type BrowserWindow = Window & typeof globalThis & {
        api: {
          collectionList: () => Promise<{ nodes: unknown[] }>;
          envList: () => Promise<unknown[]>;
          collectionCreate: () => Promise<null>;
          collectionDelete: () => Promise<void>;
          collectionUpdate: (_id: string, payload: Record<string, unknown>) => Promise<unknown>;
          collectionExport: () => Promise<unknown>;
          collectionDuplicate: () => Promise<null>;
          collectionReorder: () => Promise<null>;
           envSwitch: (id: string) => Promise<string>;
           envDelete: () => Promise<string>;
           settingsGet: () => Promise<Record<string, unknown>>;
          sendRequest: () => Promise<null>;
          requestCancel: () => Promise<void>;
          onConsoleLog: () => void;
        };
      };

      const request = {
        id: 'draft-response-request',
        name: 'Draft Response Request',
        method: 'GET',
        url: 'https://example.test/original',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        createdAt: 1,
        updatedAt: 1,
      };

      if (!window.sessionStorage.getItem('task-7-draft-fixture')) {
        window.localStorage.setItem('restiprocity:request-drafts', '{malformed-json');
        window.sessionStorage.setItem('task-7-draft-fixture', 'initialized');
      }

      (window as BrowserWindow).api = {
        collectionList: async () => ({ nodes: [{ ...request }] }),
        envList: async () => [],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id, payload) => ({ ...request, ...payload }),
        collectionExport: async () => ({ ...request }),
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
         envSwitch: async (id: string) => id,
         envDelete: async () => 'core',
         settingsGet: async () => ({
           theme: 'dark',
           fontSize: 14,
           fontFamily: 'JetBrains Mono, Fira Code, monospace',
           defaultTimeout: 30000,
           defaultFollowRedirect: true,
           autoSaveHistory: true,
           maxHistorySize: 1000,
         }),
        sendRequest: async () => null,
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.test/original');
    await page.getByPlaceholder('Enter request URL').fill('https://example.test/recovered');
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem('restiprocity:request-drafts');
      if (!raw) return false;
      try {
        return JSON.parse(raw)['draft-response-request']?.url === 'https://example.test/recovered';
      } catch {
        return false;
      }
    });

    await page.evaluate(() => {
      const legacyBody = 'legacy-'.repeat(300_000);
      const boundedLegacyPreview = legacyBody.slice(0, 1_048_576);
      const boundedLegacyBytes = new TextEncoder().encode(boundedLegacyPreview).byteLength;
      const request = {
        id: 'draft-response-request',
        name: 'Draft Response Request',
        method: 'GET',
        url: 'https://example.test/legacy-draft',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        createdAt: 1,
        updatedAt: 2,
        lastResponse: {
          version: 2,
          id: 'legacy-draft-response',
          requestId: 'draft-response-request',
          status: 206,
          statusText: 'Partial Content',
          headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }],
          preview: {
            kind: 'text',
            format: 'text',
            text: boundedLegacyPreview,
            parseState: 'not-applicable',
            charset: 'utf-8',
            decodeError: false,
            capturedBytes: boundedLegacyBytes,
            totalBytes: boundedLegacyBytes,
            truncated: false,
            completeness: 'complete',
          },
          timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 2, total: 3 },
          timestamp: 2,
          size: legacyBody.length,
          cookies: [],
        },
      };
      window.localStorage.setItem('restiprocity:request-drafts', JSON.stringify({ [request.id]: request }));
    });

    await page.reload();

    const restored = await page.evaluate(() => {
      const response = (window as Window & {
        __requestStore?: { getState: () => { currentResponse?: { preview?: { kind?: string; text?: string } } } };
      }).__requestStore?.getState().currentResponse;
      return {
        kind: response?.preview?.kind ?? '',
        text: response?.preview?.text ?? '',
        bytes: new TextEncoder().encode(response?.preview?.text ?? '').byteLength,
      };
    });
    expect(restored.kind).toBe('text');
    expect(restored.text.startsWith('legacy-')).toBe(true);
    expect(restored.bytes).toBeLessThanOrEqual(1_048_576);

    const restoredPreview = await page.evaluate(() => {
      const response = (window as Window & {
        __requestStore?: { getState: () => { currentResponse?: { preview?: { kind?: string; text?: string } } } };
      }).__requestStore?.getState().currentResponse;
      return response?.preview ?? null;
    });
    expect(restoredPreview).toMatchObject({ kind: 'text' });
    expect(restoredPreview?.text?.startsWith('legacy-')).toBe(true);

    await page.getByPlaceholder('Enter request URL').fill('https://example.test/rewritten');
    await page.waitForFunction(() => {
      const raw = window.localStorage.getItem('restiprocity:request-drafts');
      if (!raw) return false;
      const response = JSON.parse(raw)['draft-response-request']?.lastResponse;
      return response?.version === 2 && response?.preview?.kind === 'text';
    });

    const persisted = await page.evaluate(() => {
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      return drafts['draft-response-request'];
    });
    expect(persisted.url).toBe('https://example.test/rewritten');
    expect(persisted.lastResponse.version).toBe(2);
    expect(persisted.lastResponse.body).toBeUndefined();
    expect(persisted.lastResponse.destinationPath).toBeUndefined();
    expect(persisted.lastResponse.progress).toBeUndefined();
    expect(persisted.lastResponse.bytes).toBeUndefined();
    expect(new TextEncoder().encode(persisted.lastResponse.preview.text).byteLength).toBeLessThanOrEqual(1_048_576);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

for (const hasEnvironment of [true, false]) {
  test(`preview never persists expanded templates ${hasEnvironment ? 'with inherited environment' : 'without an active environment'}`, async ({ page }) => {
    const urlTemplate = previewRequest.url.replace('{{host}}', 'example.test').replace('_.uuid', '{{uuid}}');
    await test.step('Given authored URL, auth, headers, body, and structured parameter templates', async () => {
      await installPreviewApi(page, { environments: hasEnvironment ? previewEnvironments : [] });
      await page.goto('/');
      if (hasEnvironment) await page.getByRole('button', { name: 'Preview Child', exact: true }).click();
    });
    await test.step('When a preview is rendered, sent, and restored after request/environment switches', async () => {
      await page.getByPlaceholder('Enter request URL').fill(urlTemplate);
      await page.getByPlaceholder('Enter request URL').blur();
      const preview = await readPreview(page);
      const previewUuid = preview.pathname.split('/')[2];
      expect(previewUuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(preview.searchParams.get(`auth-${previewUuid}`)).toBe(previewUuid);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByText('200 OK', { exact: true })).toBeVisible();
      await page.getByTestId('sidebar').getByText('Other Preview', { exact: true }).click();
      if (hasEnvironment) await page.getByRole('button', { name: 'Core', exact: true }).click();
      await page.getByTestId('sidebar').getByText('Dynamic Preview', { exact: true }).click();
      await expect(page.getByPlaceholder('Enter request URL')).toHaveValue(urlTemplate);

      const expectedTemplates = {
        url: urlTemplate,
        headers: previewRequest.headers,
        parameters: previewRequest.parameters,
        body: previewRequest.body,
        auth: previewRequest.auth,
      };
      expect((await page.evaluate(() => window.__previewFixture.sent))[0]?.request).toMatchObject(expectedTemplates);
      const updates = await page.evaluate(() => window.__previewFixture.updates);
      expect(updates.length).toBeGreaterThan(0);
      for (const update of updates) expect(update.payload).toMatchObject(expectedTemplates);
      const saved: unknown = await page.evaluate(() => window.api.collectionExport('preview-request'));
      expect(saved).toMatchObject(expectedTemplates);
      const drafts: unknown = await page.evaluate(() => JSON.parse(localStorage.getItem('restiprocity:request-drafts') ?? '{}'));
      expect(drafts).toMatchObject({ 'preview-request': expectedTemplates });
      expect(JSON.stringify({ updates, drafts, saved })).not.toContain(previewUuid);
    });
  });
}

test.describe('Deleted-history temporary workbench isolation', () => {
  test('keeps the temporary request metadata-only and memory-only across normal request transitions', async ({ page }) => {
    const requestA = createMockRequest({ id: 'temporary-normal-a', name: 'Normal A', url: 'https://example.test/a' });
    const requestB = createMockRequest({ id: 'temporary-normal-b', name: 'Normal B', url: 'https://example.test/b' });
    await installMockApi(page, {
      nodes: [
        createMockGroup({ id: 'temporary-group', name: 'Temporary tests', children: [requestA.id, requestB.id] }),
        requestA,
        requestB,
      ],
      persistCollection: true,
    });
    await page.addInitScript(() => {
      window.localStorage.setItem('restiprocity:request-drafts', JSON.stringify({
        'deleted-request-id': {
          id: 'deleted-request-id',
          name: 'Old request draft',
          method: 'POST',
          url: 'https://unsafe.example.test/old',
          headers: [{ key: 'Authorization', value: 'Bearer old-secret', enabled: true }],
          parameters: [],
          body: { type: 'raw', raw: { language: 'json', content: '{"secret":"old"}' } },
          auth: { type: 'bearer', bearer: { token: 'old-secret', prefix: 'Bearer' } },
          settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
          scripts: {},
          createdAt: 1,
          updatedAt: 1,
        },
      }));
    });

    await page.goto('/');
    const sidebar = page.getByTestId('sidebar');
    await sidebar.getByText('Normal A', { exact: true }).click();
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill('https://example.test/edited-a');
    await urlInput.blur();
    await expect.poll(() => page.evaluate(() => window.__mockApi.collectionUpdateAttempts)).toBeGreaterThan(0);

    const beforeTemporary = await page.evaluate(() => ({
      drafts: window.localStorage.getItem('restiprocity:request-drafts'),
      collectionUpdates: window.__mockApi.collectionUpdateAttempts,
    }));

    const temporary = await page.evaluate(() => {
      const store = (window as Window & {
        __requestStore?: {
          getState: () => {
            setDeletedHistoryRequest: (entry: { id: string; requestName: string; method: Request['method']; url: string }) => Request;
            currentRequest?: Request | null;
            currentOrigin?: unknown;
          };
        };
      }).__requestStore;
      if (!store) throw new Error('Missing request store');
      const request = store.getState().setDeletedHistoryRequest({
        id: 'history-deleted-1',
        requestName: 'Deleted safely',
        method: 'POST',
        url: 'https://user:password@example.test/private?token=secret-token&visible=ok',
      });
      return {
        request,
        origin: store.getState().currentOrigin,
      };
    });

    expect(temporary.request.id).not.toBe('deleted-request-id');
    expect(temporary.request.name).toBe('Deleted safely');
    expect(temporary.request.method).toBe('POST');
    expect(temporary.request.url).toContain('https://example.test/private');
    expect(temporary.request.url).toContain('visible=ok');
    expect(temporary.request.url).not.toContain('password');
    expect(temporary.request.url).not.toContain('secret-token');
    expect(temporary.request.headers).toEqual([]);
    expect(temporary.request.parameters).toEqual([]);
    expect(temporary.request.body).toEqual({ type: 'none' });
    expect(temporary.request.auth).toEqual({ type: 'none' });
    expect(temporary.origin).toEqual({
      kind: 'deleted-history',
      historyId: 'history-deleted-1',
      requestId: temporary.request.id,
    });
    await expect(page.getByTestId('temporary-request-banner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-describedby', 'temporary-request-send-help');
    await expect(sidebar.getByText('Deleted safely', { exact: true })).toHaveCount(0);

    await page.getByPlaceholder('Enter request URL').fill('https://example.test/temporary-edit');
    await page.evaluate(() => {
      const store = (window as Window & {
        __requestStore?: { getState: () => { updateRequest: (updates: Partial<Request>) => void } };
      }).__requestStore;
      if (!store) throw new Error('Missing request store');
      store.getState().updateRequest({
        body: { type: 'raw', raw: { language: 'json', content: '{"temporary":true}' } },
      });
    });

    await expect.poll(() => page.evaluate(() => ({
      drafts: window.localStorage.getItem('restiprocity:request-drafts'),
      collectionUpdates: window.__mockApi.collectionUpdateAttempts,
      sends: window.__mockApi.sendAttempts,
      currentRequest: window.__requestStore?.getState().currentRequest,
      requestDrafts: window.__requestStore?.getState().requestDrafts,
    }))).toEqual(expect.objectContaining({
      drafts: beforeTemporary.drafts,
      collectionUpdates: beforeTemporary.collectionUpdates,
      sends: 0,
    }));

    const temporaryState = await page.evaluate((temporaryId) => ({
      currentRequest: window.__requestStore?.getState().currentRequest,
      requestDraft: window.__requestStore?.getState().requestDrafts[temporaryId],
      drafts: JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}'),
    }), temporary.request.id);
    expect(temporaryState.currentRequest?.url).toBe('https://example.test/temporary-edit');
    expect(temporaryState.currentRequest?.body).toEqual({ type: 'raw', raw: { language: 'json', content: '{"temporary":true}' } });
    expect(temporaryState.requestDraft).toBeUndefined();
    expect(temporaryState.drafts[temporary.request.id]).toBeUndefined();
    expect(temporaryState.drafts['deleted-request-id'].auth.bearer.token).toBe('old-secret');

    await sidebar.getByText('Normal A', { exact: true }).click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.test/edited-a');
    await expect.poll(() => page.evaluate(() => window.__requestStore?.getState().currentOrigin)).toEqual({
      kind: 'collection',
      requestId: requestA.id,
    });

    const temporaryAfterReload = await page.evaluate((temporaryId) => {
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      return { temporaryId, drafts };
    }, temporary.request.id);
    await page.evaluate((temporaryId) => {
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      if (drafts[temporaryId]) throw new Error('Temporary request leaked into localStorage');
    }, temporaryAfterReload.temporaryId);

    await page.evaluate(() => window.__requestStore?.getState().setDeletedHistoryRequest({
      id: 'history-deleted-1',
      requestName: 'Deleted safely',
      method: 'POST',
      url: 'https://example.test/private',
    }));
    const secondTemporaryId = await page.evaluate(() => window.__requestStore?.getState().currentRequest?.id);
    expect(secondTemporaryId).toBeTruthy();
    expect(secondTemporaryId).not.toBe(temporary.request.id);

    await page.reload();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.test/edited-a');
    await expect.poll(() => page.evaluate(() => window.__requestStore?.getState().currentOrigin)).toEqual({
      kind: 'collection',
      requestId: requestA.id,
    });
    const persistedAfterReload = await page.evaluate(({ firstId, secondId }) => {
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      return { first: drafts[firstId], second: drafts[secondId] };
    }, { firstId: temporary.request.id, secondId: secondTemporaryId });
    expect(persistedAfterReload.first).toBeUndefined();
    expect(persistedAfterReload.second).toBeUndefined();
  });
});
