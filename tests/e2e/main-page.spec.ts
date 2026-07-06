import { test, expect } from '@playwright/test';

test.describe('Main Page Smoke Test', () => {
  test.beforeEach(async ({ page }) => {
    // Mock window.api (normally provided by Electron preload script)
    await page.addInitScript(() => {
      const group = {
        id: 'group-1',
        type: 'group',
        name: 'My API',
        children: ['req-1', 'req-2'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

        const requests = [
          {
            id: 'req-1',
            type: 'request',
            name: 'GET /users',
            method: 'GET',
            url: 'https://jsonplaceholder.typicode.com/users',
            headers: [],
            parameters: [],
            body: { type: 'none' },
            auth: { type: 'none' },
            settings: { followRedirect: true, timeout: 30000, allowInsecureCertificates: false },
            scripts: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          {
            id: 'req-2',
            type: 'request',
            name: 'POST /users',
            method: 'POST',
            url: 'https://jsonplaceholder.typicode.com/users',
            headers: [],
            parameters: [],
            body: { type: 'none' },
            auth: { type: 'none' },
            settings: { followRedirect: true, timeout: 30000, allowInsecureCertificates: false },
            scripts: {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ];

      (window as any).api = {
        collectionList: async () => ({
          nodes: [{ ...group }, ...requests.map(request => ({ ...request }))],
        }),
        envList: async () => [
          { id: 'env-base', name: 'Base Environment', variables: {} },
          { id: 'env-dev', name: 'Development', variables: { baseUrl: 'http://localhost:3000' } },
        ],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id: string, payload: unknown) => {
          (window as any).__lastCollectionUpdate = { id: _id, payload };
          return null;
        },
        collectionExport: async (id: string) => {
          if (id === group.id) return { ...group };
          return requests.find(request => request.id === id) ?? null;
        },
        collectionDuplicate: async () => null,
        collectionReorder: async ({ parentId, children }: { parentId?: string; children: string[] }) => {
          if (parentId === group.id) {
            group.children = [...children];
          } else if (!parentId) {
            group.children = group.children.filter(id => !children.includes(id));
            requests.sort((a, b) => children.indexOf(a.id) - children.indexOf(b.id));
          }
          return null;
        },
        envSwitch: async () => {},
        sendRequest: async ({ request }: { request: { url?: string; settings?: { allowInsecureCertificates?: boolean } } }) => {
          if (request.url?.includes('self-signed.example.com') && !request.settings?.allowInsecureCertificates) {
            return {
              success: false,
              error: {
                kind: 'certificate',
                message: 'TLS certificate verification failed',
                rawMessage: 'certificate is not trusted',
                code: 'ERR_CERT_AUTHORITY_INVALID',
                url: request.url,
                retryable: false,
              },
            };
          }

          return {
            success: true,
            response: {
              id: 'resp-1',
              requestId: 'req-1',
              status: 200,
              statusText: 'OK',
              headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
              body: '{"ok":true}',
              size: 11,
              timestamp: Date.now(),
              timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
              cookies: [],
            },
          };
        },
        onCollectionChanged: () => {},
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
  });

  test('renders all main UI sections', async ({ page }) => {
    // Sidebar should be visible
    await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();

    // Environment selector label should show (exact match to avoid strict mode violation)
    await expect(page.getByText('Environment', { exact: true })).toBeVisible();

    // At least one environment button should render
    await expect(page.getByRole('button', { name: 'Base Environment' })).toBeVisible();

    // Request Editor should be visible (method selector + URL bar + Send button)
    await expect(page.getByRole('button', { name: /Send/i })).toBeVisible();

    // Status bar should be present at the bottom
    await expect(page.getByText('v0.1.7')).toBeVisible();

    // Collection tree nodes should render
    await expect(page.getByText('My API')).toBeVisible();
    await expect(page.getByText('GET /users').first()).toBeVisible();
    await expect(page.getByText('POST /users').first()).toBeVisible();
  });

  test('sidebar can be collapsed', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toHaveCSS('width', /^256px$/);

    await page.getByTitle('Collapse sidebar').click();

    // Sidebar collapses to w-0 — content still in DOM but visually hidden (1px from border)
    await expect(sidebar).toHaveCSS('width', /^0px$|^1px$/, { timeout: 3000 });
  });

  test('can select a request from the tree', async ({ page }) => {
    // Click on the request node (use .first() to avoid strict mode violation)
    await page.getByText('GET /users').first().click();

    // The node should have a selected/highlighted state
    const selectedNode = page.getByText('GET /users').first();
    await expect(selectedNode).toBeVisible();
    await expect(selectedNode.locator('..')).toHaveClass(/surface-active/);
  });

  test('can reorder requests by dragging the move handle', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');
    const getUsers = sidebar.getByText('GET /users');
    const postUsers = sidebar.getByText('POST /users');

    await expect(getUsers).toBeVisible();
    await expect(postUsers).toBeVisible();

    const getUsersBefore = await getUsers.boundingBox();
    const postUsersBefore = await postUsers.boundingBox();
    expect(getUsersBefore?.y).toBeLessThan(postUsersBefore?.y ?? 0);

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    const handle = page.getByRole('button', { name: 'Drag GET /users to reorder' });
    const tree = page.getByTestId('collection-tree');

    await handle.dispatchEvent('dragstart', { dataTransfer });
    await tree.dispatchEvent('dragover', { dataTransfer });
    await tree.dispatchEvent('drop', { dataTransfer });
    await handle.dispatchEvent('dragend', { dataTransfer });

    const getUsersAfter = await getUsers.boundingBox();
    const postUsersAfter = await postUsers.boundingBox();

    expect(postUsersAfter?.y).toBeLessThan(getUsersAfter?.y ?? 0);
  });

  test('can create a new request', async ({ page }) => {
    // Click "New Request" button
    await page.getByRole('button', { name: 'New Request' }).click();

    // After creation, the collection reloads — we should still see the tree
    await expect(page.getByText('My API')).toBeVisible();
  });

  test('can retry a certificate failure with unsafe override', async ({ page }) => {
    await page.getByText('GET /users').first().click();

    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill('https://self-signed.example.com/secure');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText('Request failed', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Send anyway (unsafe)')).toBeVisible();

    await page.getByRole('button', { name: 'Send anyway (unsafe)' }).click();

    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 10000 });

    const lastUpdate = await page.evaluate(() => (window as any).__lastCollectionUpdate?.payload?.settings);
    expect(lastUpdate.allowInsecureCertificates).toBe(true);
  });

  test('environment search filters environments', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search environments...');
    await searchInput.fill('dev');

    // Should show Development but not Base Environment
    await expect(page.getByRole('button', { name: 'Development' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Base Environment' })).toBeHidden();
  });

  test('body editor supports form and multipart rows', async ({ page }) => {
    await page.getByRole('button', { name: 'Body' }).click();

    await page.getByRole('button', { name: 'Form URL' }).click();
    await expect(page.getByText('No form fields defined.')).toBeVisible();
    await page.getByRole('button', { name: '+ Add' }).click();
    const formKeyInput = page.getByPlaceholder('Key');
    const formValueInput = page.getByPlaceholder('Value');
    await formKeyInput.fill('username');
    await formValueInput.fill('sisyphus');
    await expect(formKeyInput).toHaveValue('username');
    await expect(formValueInput).toHaveValue('sisyphus');

    await page.getByRole('button', { name: 'Multipart' }).click();
    await expect(page.getByText('No multipart fields defined.')).toBeVisible();
    await page.getByRole('button', { name: '+ Add' }).click();
    await page.getByRole('combobox').last().selectOption('file');
    const multipartKeyInput = page.getByPlaceholder('Key');
    const filePathInput = page.getByPlaceholder('File path');
    await multipartKeyInput.fill('avatar');
    await filePathInput.fill('C:\\tmp\\avatar.png');
    await expect(multipartKeyInput).toHaveValue('avatar');
    await expect(filePathInput).toHaveValue('C:\\tmp\\avatar.png');
  });

  test('auth editor supports OAuth2 and NTLM configs', async ({ page }) => {
    await page.getByRole('button', { name: 'Auth' }).click();

    await page.locator('select').nth(1).selectOption('oauth2');
    await page.getByPlaceholder('Token URL').fill('https://auth.example.com/token');
    await page.getByPlaceholder('Client ID').fill('client-id');
    await page.getByPlaceholder('Client Secret').fill('client-secret');
    await page.getByPlaceholder('Scope').fill('api.read');

    const oauthUpdate = await page.evaluate(() => (window as any).__lastCollectionUpdate?.payload?.auth);
    expect(oauthUpdate.type).toBe('oauth2');
    expect(oauthUpdate.oauth2.tokenUrl).toBe('https://auth.example.com/token');
    expect(oauthUpdate.oauth2.clientId).toBe('client-id');

    await page.locator('select').nth(1).selectOption('ntlm');
    // Uncheck "Use current Windows auth context" to reveal manual credential fields
    await page.getByLabel('Use current Windows auth context').click();
    await page.getByPlaceholder('Username').fill('svc-account');
    await page.getByPlaceholder('Domain (optional)').fill('CORP');
    await page.getByPlaceholder('Password').fill('secret');

    const ntlmUpdate = await page.evaluate(() => (window as any).__lastCollectionUpdate?.payload?.auth);
    expect(ntlmUpdate.type).toBe('ntlm');
    expect(ntlmUpdate.ntlm.username).toBe('svc-account');
    expect(ntlmUpdate.ntlm.domain).toBe('CORP');
  });
});
