import { expect, test } from '@playwright/test';
import {
  createMockGroup,
  createMockRequest,
  createFailedResult,
  createResponseResult,
  createTextResponse,
  installMockApi,
} from './fixtures/mockApi';
import { toPersistedResponseV2 } from '../../src/shared/responseContracts';
import type { HistoryEntry, Request, ResponseV2 } from '../../src/shared/types';

function createHistoryEntry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, 'id' | 'requestId' | 'requestName'>): HistoryEntry {
  return {
    method: 'GET',
    url: `https://example.test/${overrides.id}`,
    status: 200,
    timestamp: 1,
    duration: 2,
    size: 2,
    ...overrides,
  };
}

function createHistoryDetail(entry: HistoryEntry, response: ResponseV2): Record<string, unknown> {
  return {
    ...entry,
    ...toPersistedResponseV2(response),
    id: entry.id,
    requestId: entry.requestId,
    status: entry.status,
    timestamp: entry.timestamp,
    size: entry.size,
  };
}

type HistoryStoreWindow = Window & {
  __requestStore?: {
    getState: () => {
      reopenHistory: (entry: HistoryEntry) => Promise<boolean>;
      updateRequest: (updates: Partial<Request>) => void;
      setCurrentResponse: (response: ResponseV2 | null) => void;
      cancelRequestOperation: (operationId: string | null) => boolean;
      currentRequest?: Request | null;
      currentOrigin?: unknown;
      currentResponse?: ResponseV2 | null;
      isSending?: boolean;
      activeOperationId?: string | null;
      historyReopenPending?: boolean;
      historyReopenError?: string | null;
    };
  };
  __resolveHistoryDetail?: (value: unknown) => void;
};

test.describe('response operation ownership', () => {
  test('owns and cancels an unsafe certificate retry when switching requests', async ({ page }) => {
    const requests = [
      createMockRequest({ id: 'request-a', name: 'Certificate A' }),
      createMockRequest({ id: 'request-b', name: 'Certificate B' }),
    ];
    await installMockApi(page, {
      nodes: [
        createMockGroup({ id: 'group-1', name: 'Certificates', children: requests.map((request) => request.id) }),
        ...requests,
      ],
      sendMode: 'pending',
    });

    await page.goto('/');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await sidebar.getByText('Certificate A', { exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => window.__mockApi?.pendingOperations.size === 1);
    const initialOperation = await page.evaluate(() => [...window.__mockApi.pendingOperations.keys()][0]);
    await page.evaluate(({ operationId, result }) => {
      window.__mockApi.resolveOperation(operationId, result);
    }, {
      operationId: initialOperation,
      result: createFailedResult({ kind: 'certificate', message: 'Untrusted certificate' }),
    });

    await page.getByRole('button', { name: 'Send anyway (unsafe)' }).click();
    await page.waitForFunction(() => window.__mockApi?.pendingOperations.size === 1);
    const retry = await page.evaluate(() => {
      const [operationId, payload] = [...window.__mockApi.pendingOperations.entries()][0];
      const state = window.__requestStore?.getState();
      return {
        operationId,
        allowInsecureCertificates: payload.request.settings.allowInsecureCertificates,
        activeOperationId: state?.activeOperationId,
      };
    });
    expect(retry).toEqual({
      operationId: retry.operationId,
      allowInsecureCertificates: true,
      activeOperationId: retry.operationId,
    });

    await sidebar.getByText('Certificate B', { exact: true }).click();
    await expect.poll(() => page.evaluate((operationId) => ({
      cancelled: window.__mockApi.cancelledOperations.includes(operationId),
      pending: window.__mockApi.pendingOperations.has(operationId),
      currentRequestId: window.__requestStore?.getState().currentRequest?.id,
      responseRequestId: window.__requestStore?.getState().currentResponse?.requestId ?? null,
    }), retry.operationId)).toEqual({
      cancelled: true,
      pending: false,
      currentRequestId: 'request-b',
      responseRequestId: null,
    });
  });

  test('ignores stale progress and completion after request switch', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const requests = [
      createMockRequest({ id: 'request-a', name: 'Operation A' }),
      createMockRequest({ id: 'request-b', name: 'Operation B' }),
    ];
    await installMockApi(page, {
      nodes: [
        createMockGroup({ id: 'group-1', name: 'Operations', children: requests.map((request) => request.id) }),
        ...requests,
      ],
      sendMode: 'pending',
    });

    await page.goto('/');
    const sidebar = page.locator('[data-testid="sidebar"]');
    await sidebar.getByText('Operation A', { exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => (window as Window & { __mockApi?: { pendingOperations: Map<string, unknown> } }).__mockApi?.pendingOperations.size === 1);
    const operationA = await page.evaluate(() => (
      [...(window as Window & { __mockApi: { pendingOperations: Map<string, unknown> } }).__mockApi.pendingOperations.keys()][0]
    ));

    await sidebar.getByText('Operation B', { exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => (window as Window & { __mockApi?: { pendingOperations: Map<string, unknown> } }).__mockApi?.pendingOperations.size === 1);
    const operationB = await page.evaluate((operationAId) => (
      [...(window as Window & { __mockApi: { pendingOperations: Map<string, unknown> } }).__mockApi.pendingOperations.keys()]
        .find((operationId) => operationId !== operationAId)
    ), operationA);
    expect(operationB).toBeTruthy();

    await page.evaluate(({ operationAId, operationBId }) => {
      const harness = window as Window & {
        __mockApi: { emitProgress: (progress: Record<string, unknown>) => void };
      };
      harness.__mockApi.emitProgress({
        version: 2,
        operationId: operationAId,
        phase: 'receiving',
        receivedBytes: 999,
      });
      harness.__mockApi.emitProgress({
        version: 2,
        operationId: operationBId,
        phase: 'downloading',
        receivedBytes: 12,
      });
    }, { operationAId: operationA, operationBId: operationB! });

    const responseA = createResponseResult(createTextResponse({ requestId: 'request-a', text: 'body-request-a', status: 200, statusText: 'OK' }));
    await page.evaluate(({ operationAId, result }) => {
      (window as Window & { __mockApi: { resolveOperation: (operationId: string, result: typeof result) => void } }).__mockApi.resolveOperation(operationAId, result);
    }, { operationAId: operationA, result: responseA });

    await expect.poll(() => page.evaluate(() => {
      const state = (window as Window & {
        __requestStore?: { getState: () => {
          currentRequest?: { id?: string };
          currentResponse?: { requestId?: string } | null;
          isSending?: boolean;
          activeOperationId?: string | null;
          requestPhase?: string | null;
        } };
      }).__requestStore?.getState();
      return {
        requestId: state?.currentRequest?.id,
        responseRequestId: state?.currentResponse?.requestId ?? null,
        isSending: state?.isSending,
        activeOperationId: state?.activeOperationId,
        requestPhase: state?.requestPhase,
      };
    })).toEqual({
      requestId: 'request-b',
      responseRequestId: null,
      isSending: true,
      activeOperationId: operationB,
      requestPhase: 'downloading',
    });

    const responseB = createResponseResult(createTextResponse({ requestId: 'request-b', text: 'body-request-b', status: 201, statusText: 'Created' }));
    await page.evaluate(({ operationBId, result }) => {
      (window as Window & { __mockApi: { resolveOperation: (operationId: string, result: typeof result) => void } }).__mockApi.resolveOperation(operationBId, result);
    }, { operationBId: operationB!, result: responseB });

    await expect(page.getByText('201 Created')).toBeVisible();
    const unsubscribeState = await page.evaluate(() => {
      const harness = window as Window & {
        __mockApi: {
          progressListeners: Set<unknown>;
        };
        api: { onRequestProgress: (listener: () => void) => () => void };
      };
      const unsubscribe = harness.api.onRequestProgress(() => undefined);
      const before = harness.__mockApi.progressListeners.size;
      unsubscribe();
      unsubscribe();
      return { before, after: harness.__mockApi.progressListeners.size };
    });
    expect(unsubscribeState).toEqual({ before: 2, after: 1 });

    const finalState = await page.evaluate(() => {
      const harness = window as Window & {
        __mockApi: {
          progressListeners: Set<unknown>;
          cancelledOperations: string[];
        };
        __requestStore?: { getState: () => {
          currentResponse?: { requestId?: string } | null;
          activeOperationId?: string | null;
          isSending?: boolean;
        } };
      };
      const state = harness.__requestStore?.getState();
      return {
        listenerCount: harness.__mockApi.progressListeners.size,
        cancelledOperations: harness.__mockApi.cancelledOperations,
        responseRequestId: state?.currentResponse?.requestId,
        activeOperationId: state?.activeOperationId,
        isSending: state?.isSending,
      };
    });
    expect(finalState).toEqual({
      listenerCount: 1,
      cancelledOperations: [operationA],
      responseRequestId: 'request-b',
      activeOperationId: null,
      isSending: false,
    });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('race-safe history reopening', () => {
  test('uses the current collection definition, preserves its draft, and selects the saved response', async ({ page }) => {
    const request = createMockRequest({
      id: 'history-current-request',
      name: 'Current definition',
      url: 'https://example.test/current-definition',
      headers: [{ key: 'X-Current', value: 'definition', enabled: true }],
    });
    const group = createMockGroup({ id: 'history-group', name: 'History', children: [request.id] });
    const entry = createHistoryEntry({
      id: 'history-existing',
      requestId: request.id,
      requestName: request.name,
      url: request.url,
      status: 201,
    });
    const response = createTextResponse({ requestId: request.id, status: 201, statusText: 'Created', text: 'historical-body' });

    await installMockApi(page, {
      nodes: [group, request],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.goto('/');
    await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();

    await page.evaluate(() => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      store.getState().updateRequest({
        url: 'https://example.test/authored-draft',
        headers: [{ key: 'X-Draft', value: 'preserved', enabled: true }],
        body: { type: 'raw', raw: { language: 'json', content: '{"draft":true}' } },
      });
    });
    await page.evaluate((definition) => {
      window.api.collectionExport = async (id) => id === definition.id ? structuredClone(definition) : null;
    }, request);

    const reopened = await page.evaluate(async (historyEntry) => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      return store.getState().reopenHistory(historyEntry);
    }, entry);

    expect(reopened).toBe(true);
    const state = await page.evaluate(() => {
      const store = (window as HistoryStoreWindow).__requestStore;
      const current = store?.getState();
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      return {
        request: current?.currentRequest,
        origin: current?.currentOrigin,
        response: current?.currentResponse,
        error: current?.historyReopenError,
        pending: current?.historyReopenPending,
        draft: drafts['history-current-request'],
        sends: window.__mockApi.sendAttempts,
        historyGets: window.__mockApi.historyGetAttempts,
      };
    });

    expect(state.request).toMatchObject({
      id: request.id,
      url: 'https://example.test/authored-draft',
      headers: [{ key: 'X-Draft', value: 'preserved', enabled: true }],
      body: { type: 'raw', raw: { language: 'json', content: '{"draft":true}' } },
    });
    expect(state.origin).toEqual({ kind: 'collection', requestId: request.id });
    expect(state.response).toMatchObject({ status: 201, preview: { kind: 'text', text: 'historical-body' } });
    expect(state.error).toBeNull();
    expect(state.pending).toBe(false);
    expect(state.draft.url).toBe('https://example.test/authored-draft');
    expect(state.draft.lastResponse).toBeUndefined();
    expect(state.sends).toBe(0);
    expect(state.historyGets).toBe(1);
  });

  test('uses a fresh temporary shell when the original request is absent without persisting or sending', async ({ page }) => {
    const currentRequest = createMockRequest({ id: 'history-current', name: 'Current request' });
    const entry = createHistoryEntry({
      id: 'history-deleted',
      requestId: 'deleted-request-id',
      requestName: 'Deleted request',
      method: 'POST',
      url: 'https://user:password@example.test/private?token=secret&visible=yes',
    });
    const response = createTextResponse({ requestId: entry.requestId, text: 'deleted-history-body' });

    await installMockApi(page, {
      nodes: [currentRequest],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.goto('/');
    await page.getByTestId('sidebar').getByText(currentRequest.name, { exact: true }).click();

    const before = await page.evaluate(() => ({
      updates: window.__mockApi.collectionUpdateAttempts,
      drafts: window.localStorage.getItem('restiprocity:request-drafts'),
    }));
    const reopened = await page.evaluate(async (historyEntry) => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      return store.getState().reopenHistory(historyEntry);
    }, entry);

    expect(reopened).toBe(true);
    const state = await page.evaluate(() => {
      const store = (window as HistoryStoreWindow).__requestStore;
      const current = store?.getState();
      const drafts = JSON.parse(window.localStorage.getItem('restiprocity:request-drafts') ?? '{}');
      return {
        request: current?.currentRequest,
        origin: current?.currentOrigin,
        response: current?.currentResponse,
        drafts,
        updates: window.__mockApi.collectionUpdateAttempts,
        sends: window.__mockApi.sendAttempts,
      };
    });

    expect(state.request?.id).not.toBe(entry.requestId);
    expect(state.request).toMatchObject({
      name: entry.requestName,
      method: entry.method,
      headers: [],
      parameters: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    });
    expect(state.request?.url).toContain('https://example.test/private');
    expect(state.request?.url).toContain('visible=yes');
    expect(state.request?.url).not.toContain('password');
    expect(state.request?.url).not.toContain('secret');
    expect(state.origin).toMatchObject({ kind: 'deleted-history', historyId: entry.id });
    expect(state.response).toMatchObject({ preview: { kind: 'text', text: 'deleted-history-body' } });
    expect(state.drafts[state.request!.id]).toBeUndefined();
    expect(state.updates).toBe(before.updates);
    expect(state.sends).toBe(0);
  });

  for (const [label, detail] of [
    ['missing', null],
    ['corrupt', { version: 1, id: 'corrupt-history' }],
  ] as const) {
    test(`leaves the existing workbench unchanged for ${label} history detail`, async ({ page }) => {
      const request = createMockRequest({ id: `history-${label}-request`, name: `${label} request` });
      const entry = createHistoryEntry({ id: `history-${label}`, requestId: request.id, requestName: request.name });
      const priorResponse = createTextResponse({ requestId: request.id, text: 'prior-response' });

      await installMockApi(page, {
        nodes: [request],
        historyEntries: [entry],
        historyDetails: { [entry.id]: detail },
      });
      await page.goto('/');
      await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
      await page.evaluate(() => {
        const store = (window as HistoryStoreWindow).__requestStore;
        if (!store) throw new Error('Missing request store');
        store.getState().updateRequest({ url: 'https://example.test/keep-this-draft' });
      });
      await page.evaluate((responseValue) => {
        const store = (window as HistoryStoreWindow).__requestStore;
        if (!store) throw new Error('Missing request store');
        store.getState().setCurrentResponse(responseValue);
      }, priorResponse);

      const before = await page.evaluate(() => {
        const store = (window as HistoryStoreWindow).__requestStore;
        const current = store?.getState();
        return {
          request: current?.currentRequest,
          response: current?.currentResponse,
          drafts: window.localStorage.getItem('restiprocity:request-drafts'),
          updates: window.__mockApi.collectionUpdateAttempts,
        };
      });
      const reopened = await page.evaluate(async (historyEntry) => {
        const store = (window as HistoryStoreWindow).__requestStore;
        if (!store) throw new Error('Missing request store');
        return store.getState().reopenHistory(historyEntry);
      }, entry);

      expect(reopened).toBe(false);
      const after = await page.evaluate(() => {
        const store = (window as HistoryStoreWindow).__requestStore;
        const current = store?.getState();
        return {
          request: current?.currentRequest,
          response: current?.currentResponse,
          error: current?.historyReopenError,
          pending: current?.historyReopenPending,
          drafts: window.localStorage.getItem('restiprocity:request-drafts'),
          updates: window.__mockApi.collectionUpdateAttempts,
          sends: window.__mockApi.sendAttempts,
        };
      });

      expect(after.request).toEqual(before.request);
      expect(after.response).toEqual(before.response);
      expect(after.error).toContain('Unable to reopen this history response');
      expect(after.pending).toBe(false);
      expect(after.drafts).toBe(before.drafts);
      expect(after.updates).toBe(before.updates);
      expect(after.sends).toBe(0);
    });
  }

  test('rejects a stale completion after switching requests', async ({ page }) => {
    const requestA = createMockRequest({ id: 'history-stale-a', name: 'History stale A' });
    const requestB = createMockRequest({ id: 'history-stale-b', name: 'History stale B' });
    const entry = createHistoryEntry({ id: 'history-stale', requestId: requestA.id, requestName: requestA.name });
    const response = createTextResponse({ requestId: requestA.id, text: 'stale-history-response' });

    await installMockApi(page, {
      nodes: [createMockGroup({ id: 'history-stale-group', name: 'History stale', children: [requestA.id, requestB.id] }), requestA, requestB],
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.goto('/');
    const sidebar = page.getByTestId('sidebar');
    await sidebar.getByText(requestA.name, { exact: true }).click();
    await page.evaluate(() => {
      const browserWindow = window as HistoryStoreWindow;
      window.api.historyGet = async () => new Promise(resolve => {
        browserWindow.__resolveHistoryDetail = resolve;
      });
    });

    const reopenPromise = page.evaluate(async (historyEntry) => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      return store.getState().reopenHistory(historyEntry);
    }, entry);
    await page.waitForFunction(() => (window as HistoryStoreWindow).__requestStore?.getState().historyReopenPending === true);
    await sidebar.getByText(requestB.name, { exact: true }).click();
    await page.evaluate((historyDetail) => {
      (window as HistoryStoreWindow).__resolveHistoryDetail?.(historyDetail);
    }, createHistoryDetail(entry, response));

    expect(await reopenPromise).toBe(false);
    await expect.poll(() => page.evaluate(() => {
      const state = (window as HistoryStoreWindow).__requestStore?.getState();
      return {
        requestId: state?.currentRequest?.id,
        response: state?.currentResponse,
        pending: state?.historyReopenPending,
        error: state?.historyReopenError,
        sends: window.__mockApi.sendAttempts,
      };
    })).toEqual({ requestId: requestB.id, response: null, pending: false, error: null, sends: 0 });
  });

  test('does not fetch history or reopen while a request is sending', async ({ page }) => {
    const request = createMockRequest({ id: 'history-busy-request', name: 'History busy request' });
    const entry = createHistoryEntry({ id: 'history-busy', requestId: request.id, requestName: request.name });
    const response = createTextResponse({ requestId: request.id, text: 'busy-history-response' });

    await installMockApi(page, {
      nodes: [request],
      sendMode: 'pending',
      historyEntries: [entry],
      historyDetails: { [entry.id]: createHistoryDetail(entry, response) },
    });
    await page.goto('/');
    await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.waitForFunction(() => window.__mockApi.pendingOperations.size === 1);

    const reopened = await page.evaluate(async (historyEntry) => {
      const store = (window as HistoryStoreWindow).__requestStore;
      if (!store) throw new Error('Missing request store');
      return store.getState().reopenHistory(historyEntry);
    }, entry);
    const state = await page.evaluate(() => {
      const current = (window as HistoryStoreWindow).__requestStore?.getState();
      return {
        sending: current?.isSending,
        pending: current?.historyReopenPending,
        error: current?.historyReopenError,
        sends: window.__mockApi.sendAttempts,
        historyGets: window.__mockApi.historyGetAttempts,
      };
    });

    expect(reopened).toBe(false);
    expect(state).toEqual({
      sending: true,
      pending: false,
      error: 'Finish the active request before reopening history.',
      sends: 1,
      historyGets: 0,
    });
    await page.evaluate(() => {
      const store = (window as HistoryStoreWindow).__requestStore;
      const operationId = store?.getState().activeOperationId;
      store?.getState().cancelRequestOperation(operationId ?? null);
    });
  });
});
