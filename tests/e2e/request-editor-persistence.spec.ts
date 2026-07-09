import { test, expect } from '@playwright/test';
import { composeRequestUrl, extractQueryParamsFromUrl, removeQueryFromUrl, removeQueryParamFromUrl } from '../../src/shared/urlVariables';

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
        sendRequest: async (payload: unknown) => {
          (window as any).__lastSendRequest = payload;
          return null;
        },
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

  test('shows query params in the URL preview and sends them with the request payload', async ({ page }) => {
    await page.getByRole('button', { name: 'Params' }).click();
    await page.getByRole('button', { name: '+ Add' }).click();

    const paramKey = page.getByPlaceholder('Key').first();
    const paramValue = page.getByPlaceholder('Value').first();
    await paramKey.fill('search');
    await paramValue.fill('alpha');

    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.some((param: { key: string; value: string }) => param.key === 'search' && param.value === 'alpha');
    });

    await expect(page.getByTestId('request-url-preview')).toContainText('https://example.com?search=alpha');

    await page.getByRole('button', { name: 'Send' }).click();
    const payload = await page.evaluate(() => (window as any).__lastSendRequest);

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
      let onCollectionChanged: (() => void) | null = null;

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
        type: 'request',
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

      (window as any).api = {
        collectionList: async () => ({ nodes: [{ ...group }, { ...request }] }),
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
          return null;
        },
        collectionExport: async (id: string) => {
          if (id === group.id) return { ...group };
          if (id === request.id) return { ...request };
          return null;
        },
        collectionDuplicate: async () => null,
        collectionReorder: async () => null,
        envSwitch: async () => {},
        sendRequest: async () => null,
        requestCancel: async () => {},
        onCollectionChanged: (callback: () => void) => {
          onCollectionChanged = callback;
        },
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.locator('[data-testid="sidebar"]').getByText('Query Param Test').click();
  });

  test('highlights query params in URL overlay with extraction buttons', async ({ page }) => {
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://httpbin.org/get?name=william&tool=insomnia');

    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await expect(paramButtons).toHaveCount(2);

    await expect(paramButtons.nth(0)).toHaveAttribute('aria-label', 'Move name to Params tab');
    await expect(paramButtons.nth(1)).toHaveAttribute('aria-label', 'Move tool to Params tab');
  });

  test('clicking plus button moves first query param to Params tab', async ({ page }) => {
    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await expect(paramButtons).toHaveCount(2);

    await paramButtons.nth(0).click();

    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://httpbin.org/get?tool=insomnia');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('name');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('william');

    await expect(paramButtons).toHaveCount(1);
    await expect(paramButtons.first()).toHaveAttribute('aria-label', 'Move tool to Params tab');
  });

  test('clicking plus button moves second query param, leaving first in URL', async ({ page }) => {
    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await expect(paramButtons).toHaveCount(2);

    await paramButtons.nth(1).click();

    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://httpbin.org/get?name=william');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await expect(page.getByPlaceholder('Key').first()).toHaveValue('tool');
    await expect(page.getByPlaceholder('Value').first()).toHaveValue('insomnia');
  });

  test('moving all query params removes query string from URL', async ({ page }) => {
    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });

    await paramButtons.nth(0).click();
    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length === 1;
    });

    await paramButtons.nth(0).click();
    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
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

    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await expect(paramButtons).toHaveCount(0);
  });

  test('extracted params are enabled by default and appear in URL preview', async ({ page }) => {
    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await paramButtons.nth(0).click();

    await page.waitForFunction(() => {
      const request = (window as any).__requestStore?.getState?.().currentRequest;
      return request?.parameters?.length > 0;
    });

    await expect(page.getByTestId('request-url-preview')).toContainText('name=william');

    await page.getByRole('button', { name: 'Params', exact: true }).click();
    const checkbox = page.locator('input[type="checkbox"]').first();
    await expect(checkbox).toBeChecked();
  });

  test('extracted params are persisted via collectionUpdate', async ({ page }) => {
    const paramButtons = page.getByRole('button', { name: /Move .* to Params tab/ });
    await paramButtons.nth(0).click();

    await page.waitForFunction(() => {
      const update = (window as any).__lastCollectionUpdate;
      return update?.payload?.parameters?.length > 0;
    });

    const savedUpdate = await page.evaluate(() => (window as any).__lastCollectionUpdate);
    expect(savedUpdate.payload.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'name', value: 'william', enabled: true }),
      ]),
    );
    expect(savedUpdate.payload.url).toBe('https://httpbin.org/get?tool=insomnia');
  });
});
