import { test, expect } from '@playwright/test';
import { createResponseResult, createTextResponse } from './fixtures/mockApi';

const httpbinGetUrl = 'https://httpbin.org/get';
const httpbinGetWithParamsUrl = 'https://httpbin.org/get?name=william&tool=insomnia';
const httpbinPostUrl = 'https://httpbin.org/post';

const mockGetBody = JSON.stringify({
  args: {},
  headers: { Host: 'httpbin.org', 'User-Agent': 'Restiprocity' },
  method: 'GET',
  origin: '1.2.3.4',
  url: 'https://httpbin.org/get',
});

const mockGetWithParamsBody = JSON.stringify({
  args: { name: 'william', tool: 'insomnia' },
  headers: { Host: 'httpbin.org', 'User-Agent': 'Restiprocity' },
  method: 'GET',
  origin: '1.2.3.4',
  url: 'https://httpbin.org/get?name=william&tool=insomnia',
});

const mockPostBody = JSON.stringify({
  args: {},
  data: '{"message":"hello from insomnia","model":"qwen"}',
  files: {},
  form: {},
  headers: {
    Host: 'httpbin.org',
    'Content-Type': 'application/json',
    'User-Agent': 'Restiprocity',
  },
  json: {
    message: 'hello from insomnia',
    model: 'qwen',
  },
  method: 'POST',
  origin: '1.2.3.4',
  url: 'https://httpbin.org/post',
});

const mockGetReq = {
  id: 'req-get',
  type: 'request',
  name: 'GET /get',
  method: 'GET',
  url: httpbinGetUrl,
  headers: [],
  parameters: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
  scripts: {},
  children: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockPostReq = {
  id: 'req-post',
  type: 'request',
  name: 'POST /post',
  method: 'POST',
  url: httpbinPostUrl,
  headers: [],
  parameters: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
  scripts: {},
  children: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const mockGetResponse = createResponseResult(createTextResponse({
  id: 'resp-mock-get',
  requestId: 'req-get',
  text: mockGetBody,
  format: 'json',
  headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
}));

const mockGetWithParamsResponse = createResponseResult(createTextResponse({
  id: 'resp-mock-get-params',
  requestId: 'req-get',
  text: mockGetWithParamsBody,
  format: 'json',
  headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
}));

const mockPostResponse = createResponseResult(createTextResponse({
  id: 'resp-mock-post',
  requestId: 'req-post',
  text: mockPostBody,
  format: 'json',
  headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
}));

test.describe('HTTP Request Tests — httpbin.org', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ mockGetReqData, mockPostReqData, mockGetResp, mockGetParamsResp, mockPostResp }) => {
        (window as any).api = {
          collectionList: async () => ({
            nodes: [
              {
                id: 'group-1',
                type: 'group',
                name: 'httpbin Tests',
                children: ['req-get', 'req-post'],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              mockGetReqData,
              mockPostReqData,
            ],
          }),
          envList: async () => [
            { id: 'env-base', name: 'Base Environment', variables: {} },
          ],
          collectionCreate: async () => null,
          collectionDelete: async () => {},
          collectionUpdate: async () => null,
          collectionExport: async (id: string) => {
            if (id === 'group-1') {
              return {
                id: 'group-1',
                type: 'group',
                name: 'httpbin Tests',
                children: ['req-get', 'req-post'],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
            }
            if (id === mockGetReqData.id) return mockGetReqData;
            if (id === mockPostReqData.id) return mockPostReqData;
            return null;
          },
          collectionDuplicate: async () => null,
          envSwitch: async () => {},
          sendRequest: async ({ request }) => {
            const url = request.url || '';
            const method = request.method || 'GET';

            if (method === 'GET' && url.includes('/get')) {
              return { ...mockGetParamsResp, operationId: 'op-get-params' };
            }
            if (method === 'POST' && url.includes('/post')) {
              return { ...mockPostResp, operationId: 'op-post' };
            }
            return { ...mockGetResp, operationId: 'op-get' };
          },
          requestCancel: async () => {},
          onConsoleLog: () => {},
        };
      },
      {
        mockGetReqData: mockGetReq,
        mockPostReqData: mockPostReq,
        mockGetResp: mockGetResponse,
        mockGetParamsResp: mockGetWithParamsResponse,
        mockPostResp: mockPostResponse,
      },
    );

    await page.goto('/');
    await page.getByText('GET /get').first().click();
  });

  test('GET https://httpbin.org/get returns 200 OK', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toBeVisible();

    await urlInput.fill(httpbinGetUrl);
    await page.selectOption('select', 'GET');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('"method":')).toBeVisible();
    await expect(page.getByText('"url":')).toBeVisible();
  });

  test('GET https://httpbin.org/get?name=william&tool=insomnia returns query params in response', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinGetWithParamsUrl);
    await page.selectOption('select', 'GET');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });
    const responseJson = page.getByTestId('response-json-viewer');
    await expect(responseJson.getByText('"name":', { exact: true })).toBeVisible();
    await expect(responseJson.getByText('"william"', { exact: true })).toBeVisible();
    await expect(responseJson.getByText('"tool":', { exact: true })).toBeVisible();
    await expect(responseJson.getByText('"insomnia"', { exact: true })).toBeVisible();
  });

  test('POST https://httpbin.org/post with JSON body returns echoed data', async ({ page }) => {
    await page.selectOption('select', 'POST');
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinPostUrl);

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const jsonEditor = page.getByTestId('request-json-editor').locator('.cm-content');
    await jsonEditor.fill(JSON.stringify({
      message: 'hello from insomnia',
      model: 'qwen',
    }, null, 2));

    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });
    const responseJson = page.getByTestId('response-json-viewer');
    await expect(responseJson.getByText('"method":', { exact: true })).toBeVisible();
    await expect(responseJson.getByText('"hello from insomnia"', { exact: true })).toBeVisible();
    await expect(responseJson.getByText('"qwen"', { exact: true })).toBeVisible();
  });

  test('response viewer shows correct status color for 200', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinGetUrl);
    await page.selectOption('select', 'GET');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });

    const statusEl = page.getByText('200 OK');
    await expect(statusEl).toBeVisible({ timeout: 10000 });
    const statusColor = await statusEl.evaluate(el => getComputedStyle(el).color);
    expect(statusColor).not.toContain('255');
  });

  test('response viewer tabs switch between Body, Headers, Timings, Cookies', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinGetUrl);
    await page.selectOption('select', 'GET');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });

    const responseTabs = page.locator('button').filter({ hasText: 'Body' }).nth(1);
    await responseTabs.click();
    await expect(page.getByTestId('response-json-viewer').getByText('"method":', { exact: true })).toBeVisible();

    await page.locator('button').filter({ hasText: 'Headers' }).nth(1).click();
    await expect(page.getByText('content-type')).toBeVisible();

    await page.getByRole('button', { name: 'Timings' }).click();
    await expect(page.getByText('DNS')).toBeVisible();
    await expect(page.getByText('TCP')).toBeVisible();
    await expect(page.getByText('TLS')).toBeVisible();

    await page.getByRole('button', { name: 'Cookies' }).click();
    await expect(page.getByText('Name')).toBeVisible();
    await expect(page.getByText('Value')).toBeVisible();
    await expect(page.getByText('SameSite')).toBeVisible();
  });

  test('response json hierarchy can be collapsed and expanded', async ({ page }) => {
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinPostUrl);
    await page.selectOption('select', 'POST');

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const jsonEditor = page.getByTestId('request-json-editor').locator('.cm-content');
    await jsonEditor.fill(JSON.stringify({
      message: 'hello from insomnia',
      model: 'qwen',
    }, null, 2));

    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });

    const responseJson = page.getByTestId('response-json-viewer');
    const jsonToggle = responseJson.getByTestId('json-toggle-root.json');
    await expect(jsonToggle).toBeVisible();
    await expect(responseJson.getByText('"hello from insomnia"', { exact: true })).toBeVisible();

    await jsonToggle.click();
    await expect(responseJson.getByText('"hello from insomnia"', { exact: true })).toBeHidden();
    await expect(jsonToggle).toContainText('…');
    await expect(jsonToggle).toContainText('2');

    await jsonToggle.click();
    await expect(responseJson.getByText('"hello from insomnia"', { exact: true })).toBeVisible();
  });
});
