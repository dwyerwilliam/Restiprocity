import { test, expect } from '@playwright/test';
import type { RendererApi, RequestOperationPayload } from '../../src/preload';
import type { ResponseV2 } from '../../src/shared/types';

type SidebarTestApi = Pick<
  RendererApi,
  | 'sendRequest'
  | 'cancelRequest'
  | 'collectionList'
  | 'envList'
  | 'collectionCreate'
  | 'collectionDelete'
  | 'collectionUpdate'
  | 'collectionExport'
  | 'collectionDuplicate'
  | 'collectionMoveRequest'
  | 'collectionReorder'
  | 'envSwitch'
  | 'onCollectionChanged'
  | 'onConsoleLog'
>;

type SidebarTestWindow = Window & {
  __sidebarTest: {
    collectionExportCalls: string[];
    currentRootOrder: string[];
    groupChildren: string[];
    lastHydratedRequest: string | null;
    lastMoveRequest: { requestId: string; targetParentId?: string; targetIndex: number } | null;
    lastSendRequest: RequestOperationPayload | null;
  };
  api: SidebarTestApi;
};

type SidebarTestRequest = {
  id: string;
  type?: 'request';
  name: string;
  method: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
};

type SidebarTestGroup = {
  id: string;
  type: 'group';
  name: string;
  children: string[];
  createdAt: number;
  updatedAt: number;
  parentId?: string;
};

type SidebarTestCollectionNode = SidebarTestRequest | SidebarTestGroup;

test.describe('Collection & Sidebar Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const group: SidebarTestGroup = {
        id: 'group-1',
        type: 'group',
        name: 'My API',
        children: ['req-1'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const requests: SidebarTestRequest[] = [
        {
          id: 'req-1',
          name: 'GET /users',
          method: 'GET',
          url: 'https://jsonplaceholder.typicode.com/users',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: 'req-2',
          type: 'request',
          name: 'POST /posts',
          method: 'POST',
          url: 'https://jsonplaceholder.typicode.com/posts',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      const nodes: SidebarTestCollectionNode[] = [group, ...requests];
      const collectionChangedCallbacks: Array<() => void> = [];

      const notifyCollectionChanged = () => {
        for (const callback of collectionChangedCallbacks) {
          callback();
        }
      };

      const createRequestNode = (value: { nodeType: 'request' | 'group'; name: string; parentId?: string }): SidebarTestCollectionNode => {
        const now = Date.now();

        if (value.nodeType === 'group') {
          const createdGroup: SidebarTestGroup = {
            id: `group-${now}`,
            type: 'group',
            name: value.name,
            children: [],
            createdAt: now,
            updatedAt: now,
          };

          if (value.parentId === group.id) {
            group.children.push(createdGroup.id);
            createdGroup.parentId = value.parentId;
          }

          nodes.push(createdGroup);
          notifyCollectionChanged();
          return createdGroup;
        }

        const createdRequest: SidebarTestRequest = {
          id: `req-${now}`,
          type: 'request',
          name: value.name,
          method: 'GET',
          url: 'https://example.com',
          createdAt: now,
          updatedAt: now,
          parentId: value.parentId,
        };

        if (value.parentId === group.id) {
          group.children.push(createdRequest.id);
        }

        nodes.push(createdRequest);
        notifyCollectionChanged();
        return createdRequest;
      };

      const browserWindow = window as Window & {
        __sidebarTest: {
          collectionExportCalls: string[];
          currentRootOrder: string[];
          groupChildren: string[];
          lastHydratedRequest: string | null;
          lastMoveRequest: { requestId: string; targetParentId?: string; targetIndex: number } | null;
          lastSendRequest: RequestOperationPayload | null;
        };
        api: SidebarTestWindow['api'];
      };

      browserWindow.__sidebarTest = {
        collectionExportCalls: [],
        currentRootOrder: ['group-1', 'req-1', 'req-2'],
        groupChildren: ['req-1'],
        lastHydratedRequest: null,
        lastMoveRequest: null,
        lastSendRequest: null,
      };

      const sendRequest: RendererApi['sendRequest'] = async (payload) => {
        browserWindow.__sidebarTest.lastSendRequest = structuredClone(payload);

        const response: ResponseV2 = {
          version: 2,
          id: `response-${payload.operationId}`,
          requestId: payload.request.id,
          status: 200,
          statusText: 'OK',
          headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
          preview: {
            kind: 'text',
            format: 'text',
            text: 'ok',
            parseState: 'not-applicable',
            charset: 'utf-8',
            decodeError: false,
            capturedBytes: 2,
            totalBytes: 2,
            truncated: false,
            completeness: 'complete',
          },
          timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
          timestamp: Date.now(),
          size: 2,
          cookies: [],
        };

        return {
          version: 2,
          operationId: payload.operationId,
          kind: 'response',
          response,
        };
      };

      const cancelRequest: RendererApi['cancelRequest'] = async (operationId) => ({
        version: 2,
        operationId,
        kind: 'cancelled' as const,
      });

      browserWindow.api = {
        sendRequest,
        cancelRequest,
        collectionList: async () => ({
          nodes: nodes.map(node => ({ ...node, ...(node.type === 'group' ? { children: [...node.children] } : {}) })),
        }),
        envList: async () => [
          { id: 'env-base', name: 'Base Environment', variables: {} },
        ],
        collectionCreate: async (value: { nodeType: 'request' | 'group'; name: string; parentId?: string }) => createRequestNode(value),
        collectionDelete: async () => {},
        collectionUpdate: async () => null,
        collectionExport: async (id: string) => {
          browserWindow.__sidebarTest.collectionExportCalls.push(id);
          browserWindow.__sidebarTest.lastHydratedRequest = id;
          if (id === group.id) return { ...group };
          return requests.find(r => r.id === id) ?? null;
        },
        collectionDuplicate: async (id: string) => {
          const original = requests.find(r => r.id === id);
          if (original) {
            const copy = {
              ...original,
              id: `req-copy-${Date.now()}`,
              name: `${original.name} (copy)`,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            requests.push(copy);
            nodes.push(copy);
            notifyCollectionChanged();
            return copy;
          }
          return null;
        },
        collectionMoveRequest: async ({ requestId, targetParentId, targetIndex }: { requestId: string; targetParentId?: string; targetIndex: number }) => {
          const request = requests.find(r => r.id === requestId);
          if (!request) return null;

          group.children = group.children.filter(id => id !== requestId);

          if (targetParentId === group.id) {
            group.children.splice(Math.max(0, Math.min(targetIndex, group.children.length)), 0, requestId);
            browserWindow.__sidebarTest.groupChildren = [...group.children];
            request.parentId = targetParentId;
          } else if (targetParentId === undefined) {
            delete request.parentId;
            const currentRequestIndex = requests.findIndex(r => r.id === requestId);
            if (currentRequestIndex !== -1) {
              requests.splice(currentRequestIndex, 1);
              const rootInsertIndex = Math.max(0, Math.min(targetIndex, nodes.length));
              const groupIndex = nodes.findIndex(node => node.id === group.id);
              const insertIndex = groupIndex === -1 ? rootInsertIndex : Math.min(rootInsertIndex, groupIndex);
              nodes.splice(insertIndex, 0, request);
              browserWindow.__sidebarTest.currentRootOrder = nodes.map(node => node.id);
            }
            browserWindow.__sidebarTest.groupChildren = [...group.children];
          } else {
            return null;
          }

          browserWindow.__sidebarTest.lastMoveRequest = { requestId, targetParentId, targetIndex };
          return request;
        },
        collectionReorder: async () => null,
        envSwitch: async () => {},
        onCollectionChanged: (callback: () => void) => {
          collectionChangedCallbacks.push(callback);
        },
        onConsoleLog: () => {},
      };

    });

    await page.goto('/');
  });

  test('duplicate request creates a new entry with (copy) suffix', async ({ page }) => {
    // Verify original request exists
    await expect(page.getByText('GET /users')).toBeVisible();

    // Right-click on the request to open context menu
    await page.getByText('GET /users').first().click({ button: 'right' });

    // Click Duplicate in the context menu
    await page.getByText('Duplicate').click();

    // After duplication, the collection reloads — both original and copy should appear
    await expect(page.getByText('GET /users').first()).toBeVisible();
    await expect(page.getByText('GET /users (copy)')).toBeVisible({ timeout: 5000 });
  });

  test('folder click does not export into the request editor', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.collectionExportCalls = [];
      browserWindow.__sidebarTest.lastHydratedRequest = null;
    });

    const urlInput = page.getByPlaceholder('Enter request URL');
    const beforeValue = await urlInput.inputValue();

    await page.getByTestId('sidebar-group-row-group-1').click();

    await expect(page.getByText('My API')).toBeVisible();
    await expect(page.getByTestId('sidebar-group-row-group-1')).toHaveAttribute('data-folder-row', 'true');
    const exportCalls = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.collectionExportCalls);
    const hydratedRequest = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.lastHydratedRequest);
    expect(exportCalls).toEqual([]);
    expect(hydratedRequest).toBeNull();
    await expect(urlInput).toHaveValue(beforeValue);
  });

  test('request click hydrates editor even when persisted type is omitted', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.collectionExportCalls = [];
      browserWindow.__sidebarTest.lastHydratedRequest = null;
    });

    await page.getByTestId('sidebar-request-row-req-2').click();
    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://jsonplaceholder.typicode.com/posts');

    await page.getByTestId('sidebar-request-row-req-1').click();

    const exportCalls = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.collectionExportCalls);
    const hydratedRequest = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.lastHydratedRequest);
    const urlInput = page.getByPlaceholder('Enter request URL');

    expect(exportCalls).toEqual(['req-2', 'req-1']);
    expect(hydratedRequest).toBe('req-1');
    await expect(urlInput).toHaveValue('https://jsonplaceholder.typicode.com/users');
  });

  test('folder row accepts dropped request via collectionMoveRequest', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.lastMoveRequest = null;
    });

    const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
    const folderRow = page.getByTestId('sidebar-group-row-group-1');

    await expect(folderRow).toBeVisible();
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer });
    await expect(folderRow).toHaveAttribute('data-droppable', 'true');
    await folderRow.dispatchEvent('dragover', { dataTransfer });
    await folderRow.dispatchEvent('drop', { dataTransfer });
    await requestHandle.dispatchEvent('dragend', { dataTransfer });

    await expect(page.getByTestId('sidebar-request-row-req-2')).toBeVisible();
    const moveRequest = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.lastMoveRequest);
    expect(moveRequest).toEqual({ requestId: 'req-2', targetParentId: 'group-1', targetIndex: 1 });

    const getUsersBox = await page.getByTestId('sidebar-request-row-req-1').boundingBox();
    const postUsersBox = await page.getByTestId('sidebar-request-row-req-2').boundingBox();
    expect(getUsersBox).not.toBeNull();
    expect(postUsersBox).not.toBeNull();
    expect(postUsersBox!.y).toBeGreaterThan(getUsersBox!.y);
  });

  test('root edge accepts a child request dragged before its group', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.lastMoveRequest = null;
    });

    const requestHandle = page.getByRole('button', { name: 'Drag GET /users to reorder' });
    const tree = page.getByTestId('collection-tree');
    const rootEdge = tree.locator(':scope > .h-3');

    await expect(page.getByTestId('sidebar-request-row-req-1')).toBeVisible();
    await expect(page.getByTestId('sidebar-group-row-group-1')).toBeVisible();
    await expect(rootEdge).toBeVisible();

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer });
    await rootEdge.dispatchEvent('dragover', { dataTransfer });
    await rootEdge.dispatchEvent('drop', { dataTransfer });
    await requestHandle.dispatchEvent('dragend', { dataTransfer });

    const moveRequest = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.lastMoveRequest);
    expect(moveRequest).toEqual({ requestId: 'req-1', targetParentId: undefined, targetIndex: 0 });

    const requestNode = page.getByTestId('sidebar-request-row-req-1');
    const groupNode = page.getByTestId('sidebar-group-row-group-1');
    const requestBox = await requestNode.boundingBox();
    const groupBox = await groupNode.boundingBox();
    expect(requestBox).not.toBeNull();
    expect(groupBox).not.toBeNull();
    expect(requestBox!.y).toBeLessThan(groupBox!.y);

    const sidebarState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(sidebarState.groupChildren).toEqual([]);
    expect(sidebarState.currentRootOrder.slice(0, 2)).toEqual(['req-1', 'group-1']);
  });

  test('browser mock exposes preload request and create methods through the UI', async ({ page }) => {
    const result = await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      return {
        sendType: typeof browserWindow.api.sendRequest,
        createType: typeof browserWindow.api.collectionCreate,
      };
    });

    expect(result).toEqual({ sendType: 'function', createType: 'function' });

    const newMenu = page.getByRole('button', { name: 'New' });
    await newMenu.click();
    await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Request', exact: true }).click();

    const urlInput = page.getByPlaceholder('Enter request URL');
    await expect(urlInput).toHaveValue('https://example.com');
    await urlInput.fill('https://example.com/created-via-ui');
    await page.getByRole('button', { name: 'Send' }).click();

    const lastSendRequest = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.lastSendRequest);
    expect(lastSendRequest).not.toBeNull();
    expect(lastSendRequest).toMatchObject({
      request: {
        method: 'GET',
        url: 'https://example.com/created-via-ui',
      },
    });
    expect(lastSendRequest?.operationId).toBeTruthy();
  });

  test('footer new control exposes one plus and accessible actions', async ({ page }) => {
    const newControl = page.getByRole('button', { name: 'New' });
    await expect(newControl).toBeVisible();
    await expect(newControl.locator('svg')).toHaveCount(1);
    await expect(newControl).not.toHaveAttribute('aria-haspopup');

    await newControl.click();
    const menuItems = page.getByTestId('new-request-menu').getByRole('button');
    await expect(menuItems).toHaveCount(3);
    await expect(menuItems.nth(0)).toHaveText('New Folder');
    await expect(menuItems.nth(1)).toHaveText('New Request');
    await expect(menuItems.nth(2)).toHaveText('New Request from Clipboard');
  });

  test('sidebar can be collapsed and restored', async ({ page }) => {
    const sidebar = page.locator('[data-testid="sidebar"]');

    // Sidebar is initially expanded
    await expect(sidebar).toHaveCSS('width', /^256px$/);

    // Collapse the sidebar
    await page.getByTitle('Collapse sidebar').click();
    await expect(sidebar).toHaveCSS('width', /^56px$/, { timeout: 3000 });

    // Expand button should appear when sidebar is collapsed
    await expect(page.getByTitle('Expand sidebar')).toBeVisible({ timeout: 3000 });

    // Click the expand button to restore sidebar
    await page.getByTitle('Expand sidebar').click();

    // Sidebar should be expanded again
    await expect(sidebar).toHaveCSS('width', /^256px$/, { timeout: 3000 });

    // Collections header should be visible again
    await expect(page.getByText('Collections')).toBeVisible();
  });
});
