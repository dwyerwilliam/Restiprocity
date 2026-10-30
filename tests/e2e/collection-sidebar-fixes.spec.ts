import { test, expect } from '@playwright/test';
import type { RendererApi, RequestOperationPayload } from '../../src/preload';
import type { ResponseV2 } from '../../src/shared/types';

type SidebarTestApi = Pick<
  RendererApi,
  | 'sendRequest'
  | 'cancelRequest'
  | 'collectionList'
   | 'envList'
   | 'envDelete'
   | 'settingsGet'
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
    collectionListCalls: number;
    moveCalls: number;
    reorderCalls: number;
    rejectMove: string | null;
    rejectReorder: string | null;
    rejectRefresh: boolean;
    holdMutation: boolean;
    releaseMutation?: () => void;
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

      const browserWindow = window as SidebarTestWindow;

      browserWindow.__sidebarTest = {
        collectionListCalls: 0,
        moveCalls: 0,
        reorderCalls: 0,
        rejectMove: null,
        rejectReorder: null,
        rejectRefresh: false,
        holdMutation: false,
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
        collectionList: async () => {
          browserWindow.__sidebarTest.collectionListCalls += 1;
          if (browserWindow.__sidebarTest.rejectRefresh) {
            throw new Error('Refresh failed at C:\\private\\collections');
          }
          return {
            nodes: nodes.map(node => ({ ...node, ...('children' in node ? { children: [...node.children] } : {}) })),
          };
        },
        envList: async () => [
           { id: 'env-base', name: 'Base Environment', variables: [], createdAt: Date.now(), updatedAt: Date.now() },
        ],
        collectionCreate: async (value: { nodeType: 'request' | 'group'; name: string; parentId?: string }) => createRequestNode(value),
        collectionDelete: async () => {},
        collectionUpdate: async (id: string, data: Record<string, unknown> & { nodeType?: string }) => {
          const node = nodes.find(n => n.id === id);
          if (!node) return null;

          const payload = { ...data };
          delete payload.nodeType;
          Object.assign(node as Record<string, unknown>, payload);
          notifyCollectionChanged();
          return null;
        },
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
          browserWindow.__sidebarTest.moveCalls += 1;
          if (browserWindow.__sidebarTest.holdMutation) {
            await new Promise<void>(resolve => { browserWindow.__sidebarTest.releaseMutation = resolve; });
          }
          const rejection = browserWindow.__sidebarTest.rejectMove;
          browserWindow.__sidebarTest.rejectMove = null;
          if (rejection) throw new Error(rejection);
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
        collectionReorder: async ({ parentId, children }) => {
          browserWindow.__sidebarTest.reorderCalls += 1;
          const rejection = browserWindow.__sidebarTest.rejectReorder;
          browserWindow.__sidebarTest.rejectReorder = null;
          if (rejection) throw new Error(rejection);
          if (parentId === group.id) {
            group.children = [...children];
            browserWindow.__sidebarTest.groupChildren = [...children];
          } else {
            nodes.sort((left, right) => children.indexOf(left.id) - children.indexOf(right.id));
            browserWindow.__sidebarTest.currentRootOrder = [...children];
          }
          return null;
        },
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

  test('move succeeds after rejected drop', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.rejectMove = 'COLLECTION_MOVE_REJECTED: Move failed at C:\\private\\collections';
    });

    const dragIntoGroup = async () => {
      const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
      const folderRow = page.getByTestId('sidebar-group-row-group-1');
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await requestHandle.dispatchEvent('dragstart', { dataTransfer });
      await folderRow.dispatchEvent('dragover', { dataTransfer });
      await folderRow.dispatchEvent('drop', { dataTransfer });
      await requestHandle.dispatchEvent('dragend', { dataTransfer });
    };

    await dragIntoGroup();

    const error = page.getByTestId('collection-move-error');
    await expect(error).toHaveRole('alert');
    await expect(error).toHaveText('Move was rejected. Refresh the collection and retry.');
    await expect(error).not.toContainText('private');
    expect(pageErrors).toEqual([]);

    const failedState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(failedState.moveCalls).toBe(1);
    expect(failedState.groupChildren).toEqual(['req-1']);
    expect(failedState.lastMoveRequest).toBeNull();
    await expect(page.getByTestId('sidebar-request-row-req-2')).toBeVisible();

    await dragIntoGroup();

    await expect(error).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest)).groupChildren).toEqual(['req-1', 'req-2']);
    const finalState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(finalState.moveCalls).toBe(2);
    expect(finalState.lastMoveRequest).toEqual({ requestId: 'req-2', targetParentId: 'group-1', targetIndex: 1 });
  });

  test('pending move ignores overlapping drops until the first settles', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.holdMutation = true;
    });

    const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
    const folderRow = page.getByTestId('sidebar-group-row-group-1');
    const firstDataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer: firstDataTransfer });
    await folderRow.dispatchEvent('dragover', { dataTransfer: firstDataTransfer });
    await folderRow.dispatchEvent('drop', { dataTransfer: firstDataTransfer });
    await expect.poll(async () => (await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest)).moveCalls).toBe(1);

    const secondDataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer: secondDataTransfer });
    await folderRow.dispatchEvent('dragover', { dataTransfer: secondDataTransfer });
    await folderRow.dispatchEvent('drop', { dataTransfer: secondDataTransfer });

    const overlappingState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(overlappingState.moveCalls).toBe(1);
    await expect(page.getByTestId('collection-tree')).toHaveAttribute('aria-busy', 'true');

    await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest.releaseMutation?.());
    await requestHandle.dispatchEvent('dragend', { dataTransfer: firstDataTransfer });
    await expect.poll(async () => (await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest)).groupChildren).toEqual(['req-1', 'req-2']);
    await expect(page.getByTestId('collection-move-error')).toHaveCount(0);
    await expect(page.getByTestId('collection-tree')).toHaveAttribute('aria-busy', 'false');
  });

  test('failed move shows inline error without exposing recovery paths', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.rejectMove = 'COLLECTION_ROLLBACK_INCOMPLETE: recovery manifest at C:\\private\\collections\\recovery.json';
    });

    const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
    const folderRow = page.getByTestId('sidebar-group-row-group-1');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer });
    await folderRow.dispatchEvent('dragover', { dataTransfer });
    await folderRow.dispatchEvent('drop', { dataTransfer });
    await requestHandle.dispatchEvent('dragend', { dataTransfer });

    const error = page.getByTestId('collection-move-error');
    await expect(error).toHaveText('Move recovery was incomplete. Stop rearranging collections and recover the retained collection backups before retrying.');
    await expect(error).not.toContainText('C:\\private');
    await expect(page.getByTestId('sidebar-request-row-req-2')).toBeVisible();
    await expect(page.locator('[data-droppable="true"]')).toHaveCount(0);
  });

  test('move error survives an authoritative refresh failure', async ({ page }) => {
    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.rejectMove = 'COLLECTION_MOVE_REJECTED: Move failed at C:\\private\\collections';
      browserWindow.__sidebarTest.rejectRefresh = true;
    });

    const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
    const folderRow = page.getByTestId('sidebar-group-row-group-1');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await requestHandle.dispatchEvent('dragstart', { dataTransfer });
    await folderRow.dispatchEvent('dragover', { dataTransfer });
    await folderRow.dispatchEvent('drop', { dataTransfer });
    await requestHandle.dispatchEvent('dragend', { dataTransfer });

    const error = page.getByTestId('collection-move-error');
    await expect(error).toHaveText('Move was rejected. Refresh the collection and retry.');
    await expect(error).not.toContainText('Refresh failed');
    await expect(page.getByTestId('sidebar-request-row-req-2')).toBeVisible();
    await expect(page.getByTestId('collection-tree')).toHaveAttribute('aria-busy', 'false');
  });

  test('failed reorder clears drag state and can retry', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    await page.evaluate(() => {
      const browserWindow = window as SidebarTestWindow;
      browserWindow.__sidebarTest.rejectReorder = 'COLLECTION_MOVE_REJECTED: Reorder failed at C:\\private\\collections';
    });

    const reorderAtRootEdge = async () => {
      const requestHandle = page.getByRole('button', { name: 'Drag POST /posts to reorder' });
      const tree = page.getByTestId('collection-tree');
      const rootEdge = tree.locator(':scope > .h-3');
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await requestHandle.dispatchEvent('dragstart', { dataTransfer });
      await rootEdge.dispatchEvent('dragover', { dataTransfer });
      await rootEdge.dispatchEvent('drop', { dataTransfer });
      await requestHandle.dispatchEvent('dragend', { dataTransfer });
    };

    await reorderAtRootEdge();

    const error = page.getByTestId('collection-move-error');
    await expect(error).toHaveText('Move was rejected. Refresh the collection and retry.');
    await expect(error).not.toContainText('private');
    await expect(page.locator('[data-droppable="true"]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);

    const failedState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(failedState.reorderCalls).toBe(1);
    expect(failedState.currentRootOrder).toEqual(['group-1', 'req-1', 'req-2']);

    await reorderAtRootEdge();

    await expect(error).toHaveCount(0);
    await expect.poll(async () => (await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest)).currentRootOrder).toEqual(['req-2', 'group-1']);
    const finalState = await page.evaluate(() => (window as SidebarTestWindow).__sidebarTest);
    expect(finalState.reorderCalls).toBe(2);
    expect(finalState.groupChildren).toEqual(['req-1']);
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

  test('hover add-request button creates a request inside the group and starts inline rename', async ({ page }) => {
    const groupRow = page.getByTestId('sidebar-group-row-group-1');
    await groupRow.hover();

    const addButton = page.getByRole('button', { name: 'Add request to My API' });
    await addButton.click();

    const createdParentId = await page.evaluate(async () => {
      const w = window as SidebarTestWindow;
      const { nodes } = await w.api.collectionList();
      const created = nodes.find(
        n => (n as { name?: string }).name === 'New Request' && !('type' in n),
      );
      return (created as { parentId?: string } | undefined)?.parentId;
    });
    expect(createdParentId).toBe('group-1');

    const renameInput = page.getByTestId('sidebar').locator('input[type="text"]');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('New Request');

    await expect(page.getByPlaceholder('Enter request URL')).toHaveValue('https://example.com');
  });

  test('New Request from the menu is created inside the selected group', async ({ page }) => {
    await page.getByTestId('sidebar-group-row-group-1').click();

    await page.getByRole('button', { name: 'New' }).click();
    await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Request', exact: true }).click();

    const createdParentId = await page.evaluate(async () => {
      const w = window as SidebarTestWindow;
      const { nodes } = await w.api.collectionList();
      const created = nodes.find(
        n => (n as { name?: string }).name === 'New Request' && !('type' in n),
      );
      return (created as { parentId?: string } | undefined)?.parentId;
    });
    expect(createdParentId).toBe('group-1');
  });

  test('rename before first URL edit is not reverted by the editor save (issue #2)', async ({ page }) => {
    await page.getByRole('button', { name: 'New' }).click();
    await page.getByTestId('new-request-menu').getByRole('button', { name: 'New Request', exact: true }).click();

    const renameInput = page.getByTestId('sidebar').locator('input[type="text"]');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('New Request');

    await renameInput.fill('GET /repos');
    await renameInput.press('Enter');

    await expect(page.getByTestId('sidebar').getByText('GET /repos')).toBeVisible();

    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill('https://api.github.com/repos');
    await urlInput.press('Tab');

    await expect(page.getByTestId('sidebar').getByText('GET /repos')).toBeVisible();
    await expect(page.getByTestId('sidebar').getByText('New Request')).toHaveCount(0);

    const persisted = await page.evaluate(async () => {
      const w = window as SidebarTestWindow;
      const { nodes } = await w.api.collectionList();
      const created = nodes.find(n => (n as { url?: string }).url === 'https://api.github.com/repos');
      return (created as { name?: string } | undefined)?.name ?? null;
    });
    expect(persisted).toBe('GET /repos');
  });

  test('rename inside a folder is not reverted by the editor save (issue #2, folder level)', async ({ page }) => {
    const groupRow = page.getByTestId('sidebar-group-row-group-1');
    await groupRow.hover();
    await page.getByRole('button', { name: 'Add request to My API' }).click();

    const renameInput = page.getByTestId('sidebar').locator('input[type="text"]');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('New Request');

    await renameInput.fill('GET /repos');
    await renameInput.press('Enter');

    await expect(page.getByTestId('sidebar').getByText('GET /repos')).toBeVisible();

    const urlInput = page.getByPlaceholder('Enter request URL');
    await urlInput.fill('https://api.github.com/repos');
    await urlInput.press('Tab');

    await expect(page.getByTestId('sidebar').getByText('GET /repos')).toBeVisible();
    await expect(page.getByTestId('sidebar').getByText('New Request')).toHaveCount(0);

    const persisted = await page.evaluate(async () => {
      const w = window as SidebarTestWindow;
      const { nodes } = await w.api.collectionList();
      const created = nodes.find(n => (n as { url?: string }).url === 'https://api.github.com/repos');
      return {
        name: (created as { name?: string } | undefined)?.name ?? null,
        parentId: (created as { parentId?: string } | undefined)?.parentId ?? null,
      };
    });
    expect(persisted).toEqual({ name: 'GET /repos', parentId: 'group-1' });
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
