import { test, expect } from '@playwright/test';
import { createResponseResult, createTextResponse } from './fixtures/mockApi';
import { installPreviewApi, previewRequest, readPreview } from './fixtures/previewApi';

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
             { id: 'env-base', name: 'Base Environment', variables: [], createdAt: Date.now(), updatedAt: Date.now() },
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
           envSwitch: async (id: string) => id,
           envDelete: async () => 'env-base',
           settingsGet: async () => ({
             activeEnvironmentId: 'env-base',
             theme: 'dark',
             fontSize: 14,
             fontFamily: 'JetBrains Mono, Fira Code, monospace',
             defaultTimeout: 30000,
             defaultFollowRedirect: true,
             autoSaveHistory: true,
             maxHistorySize: 1000,
           }),
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
    await expect(page.getByText('No cookies received')).toBeVisible();
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

  test('json body editor applies syntax highlighting to tokens', async ({ page }) => {
    await page.getByRole('button', { name: 'Body' }).click();
    await page.getByRole('button', { name: 'Raw' }).click();
    const jsonEditor = page.getByTestId('request-json-editor').locator('.cm-content');
    await jsonEditor.fill(JSON.stringify({
      temperature: 0.2,
      model: 'qwen',
      flag: true,
      nothing: null,
    }, null, 2));

    await expect
      .poll(async () => jsonEditor.locator('span').count(), { timeout: 10000 })
      .toBeGreaterThan(0);
  });
});

function expectDynamicPreview(url: URL) {
  const [, , uuid, repeatedUuid, timestamp, repeatedTimestamp, randomInt, repeatedRandomInt] = url.pathname.split('/');
  expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(repeatedUuid).toBe(uuid);
  expect(timestamp).toMatch(/^\d{13}$/);
  expect(repeatedTimestamp).toBe(timestamp);
  expect(randomInt).toMatch(/^\d{1,6}$/);
  expect(Number(randomInt)).toBeLessThan(1_000_000);
  expect(repeatedRandomInt).toBe(randomInt);
  expect(url.searchParams.get(`param-${uuid}`)).toBe(`${uuid}/${timestamp}/${randomInt}`);
  expect(url.searchParams.get(`auth-${uuid}`)).toBe(uuid);
  expect(url.searchParams.get('short')).toBe(uuid);
  expect(url.searchParams.get('unknown')).toBe('{{ missing }}');
  expect(url.searchParams.get('literal')).toBe('{{uuid}}');
  return uuid;
}

test('dynamic preview uses one context', async ({ page }) => {
  await test.step('Given an inherited environment with reserved collisions and repeated templates', async () => {
    await installPreviewApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Preview Child', exact: true }).click();
  });
  await test.step('When the structured parameters are shown', async () => {
    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await page.getByPlaceholder('Enter request URL').focus();
    await page.getByPlaceholder('Enter request URL').blur();
  });
  await test.step('Then every displayed dynamic occurrence agrees without altering the send payload', async () => {
    const url = await readPreview(page);
    expect(url.hostname).toBe('child.example.test');
    expectDynamicPreview(url);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('200 OK', { exact: true })).toBeVisible();
    expect((await readPreview(page)).href).toBe(url.href);
    expect((await page.evaluate(() => window.__previewFixture.sent))[0]?.request).toMatchObject({
      ...previewRequest,
      url: previewRequest.url.replace('_.uuid', '{{uuid}}'),
      updatedAt: expect.any(Number),
    });
  });
});

test('dynamic preview uses one context across progress and refreshes on relevant edits', async ({ page }) => {
  await installPreviewApi(page, { sendMode: 'pending' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Preview Child', exact: true }).click();
  await page.getByPlaceholder('Enter request URL').focus();
  await page.getByPlaceholder('Enter request URL').blur();
  const original = await readPreview(page);
  const originalUuid = expectDynamicPreview(original);

  await test.step('When response progress and unrelated editor changes rerender the request', async () => {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.evaluate(() => {
      const [payload] = window.__previewFixture.sent;
      if (!payload) throw new Error('No captured send');
      for (const receivedBytes of [1, 512, 8192]) {
        window.__previewFixture.emitProgress({ version: 2, operationId: payload.operationId, phase: 'receiving', receivedBytes });
      }
    });
    await expect(page.getByText('Receiving response preview…', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Follow Redirects', { exact: true }).uncheck();
  });
  await test.step('Then the illustrative context stays stable, including after interruption', async () => {
    expect((await readPreview(page)).href).toBe(original.href);
    await page.getByTestId('stop-request').click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    expect((await readPreview(page)).href).toBe(original.href);
  });
  await test.step('When the URL, parameters, and selected environment change, the preview refreshes', async () => {
    await page.getByPlaceholder('Enter request URL').fill(`${previewRequest.url}&edit=1`);
    const edited = await readPreview(page);
    expect(expectDynamicPreview(edited)).not.toBe(originalUuid);
    expect(edited.searchParams.get('edit')).toBe('1');
    await page.getByRole('button', { name: 'Params', exact: true }).click();
    await page.getByPlaceholder('Value', { exact: true }).fill('{{uuid}}');
    const paramEdited = await readPreview(page);
    const paramUuid = paramEdited.pathname.split('/')[2];
    expect(paramEdited.searchParams.get(`param-${paramUuid}`)).toBe(paramUuid);
    expect(paramUuid).not.toBe(edited.pathname.split('/')[2]);
    await page.getByRole('button', { name: 'Core', exact: true }).click();
    await expect(page.getByTestId('request-url-preview')).toContainText('https://parent.example.test/');
    expect((await readPreview(page)).pathname).not.toBe(paramEdited.pathname);
  });
});

test('dynamic preview uses one context after environment variable edits', async ({ page }) => {
  await test.step('Given the selected child environment preview', async () => {
    await installPreviewApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Preview Child', exact: true }).click();
  });
  const original = await readPreview(page);
  await test.step('When an active environment variable is saved', async () => {
    await page.getByRole('button', { name: 'Edit selected environment', exact: true }).click();
    await page.getByRole('textbox', { name: 'Variable value 1', exact: true }).fill('edited.example.test');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
  });
  await test.step('Then the changed variable and a fresh internally consistent sample are displayed', async () => {
    await expect(page.getByTestId('request-url-preview')).toContainText('https://edited.example.test/');
    const edited = await readPreview(page);
    expect(expectDynamicPreview(edited)).not.toBe(original.pathname.split('/')[2]);
  });
});

test('dynamic preview uses one context while an inactive environment changes', async ({ page }) => {
  await test.step('Given a preview using Core, not its child', async () => {
    await installPreviewApi(page);
    await page.goto('/');
    await expect(page.getByTestId('request-url-preview')).toContainText('https://parent.example.test/');
  });
  const original = await readPreview(page);
  await test.step('When a different environment variable is saved without switching selection', async () => {
    await page.getByRole('button', { name: 'Edit selected environment', exact: true }).click();
    await page.getByTestId('environment-editor-tree').getByRole('button', { name: /Preview Child/ }).click();
    await page.getByRole('textbox', { name: 'Variable value 1', exact: true }).fill('inactive.example.test');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Env: Core', exact: true })).toBeVisible();
  });
  await test.step('Then the selected preview sample stays unchanged', async () => {
    expect((await readPreview(page)).href).toBe(original.href);
  });
});
