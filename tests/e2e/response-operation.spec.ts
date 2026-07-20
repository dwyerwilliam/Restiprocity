import { expect, test } from '@playwright/test';
import {
  createMockGroup,
  createMockRequest,
  createFailedResult,
  createResponseResult,
  createTextResponse,
  installMockApi,
} from './fixtures/mockApi';

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
