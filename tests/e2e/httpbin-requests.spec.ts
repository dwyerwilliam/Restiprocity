import { test, expect } from '@playwright/test';

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

const mockHeaders = [
  { key: 'content-type', value: 'application/json', enabled: true },
  { key: 'server', value: 'nginx', enabled: true },
  { key: 'date', value: 'Fri, 26 Jun 2026 18:00:00 GMT', enabled: true },
];

const mockTimings = {
  dns: 15,
  tcp: 25,
  tls: 40,
  ttfb: 120,
  download: 30,
  total: 230,
};

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

function makeResponse(body: string) {
  return {
    success: true,
    response: {
      id: 'resp-mock',
      requestId: 'req-mock',
      status: 200,
      statusText: 'OK',
      headers: mockHeaders,
      body,
      size: body.length,
      timestamp: Date.now(),
      timings: mockTimings,
      cookies: [],
    },
  };
}

const mockGetResponse = makeResponse(mockGetBody);
const mockGetWithParamsResponse = makeResponse(mockGetWithParamsBody);
const mockPostResponse = makeResponse(mockPostBody);

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
              return mockGetParamsResp;
            }
            if (method === 'POST' && url.includes('/post')) {
              return mockPostResp;
            }
            return mockGetResp;
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
    await expect(page.getByText('"name": "william"')).toBeVisible();
    await expect(page.getByText('"tool": "insomnia"')).toBeVisible();
  });

  test('POST https://httpbin.org/post with JSON body returns echoed data', async ({ page }) => {
    await page.selectOption('select', 'POST');
    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill(httpbinPostUrl);

    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const bodyTextarea = page.locator('textarea');
    await bodyTextarea.fill(JSON.stringify({
      message: 'hello from insomnia',
      model: 'qwen',
    }, null, 2));

    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10000 });
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('pre').getByText('"method":')).toBeVisible();
    await expect(page.locator('pre').getByText('hello from insomnia')).toBeVisible();
    await expect(page.locator('pre').getByText('qwen')).toBeVisible();
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
    await expect(page.locator('pre').getByText('"method":')).toBeVisible();

    await page.locator('button').filter({ hasText: 'Headers' }).nth(1).click();
    await expect(page.getByText('content-type')).toBeVisible();

    await page.getByRole('button', { name: 'Timings' }).click();
    await expect(page.getByText('DNS')).toBeVisible();
    await expect(page.getByText('TCP')).toBeVisible();
    await expect(page.getByText('TLS')).toBeVisible();

    await page.getByRole('button', { name: 'Cookies' }).click();
    await expect(page.getByText('No cookies in response.')).toBeVisible();
  });
});
