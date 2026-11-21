import { expect, test, type Page } from '@playwright/test';
import { createMockRequest, createResponseResult, createTextResponse, installMockApi, type MockWindow } from './fixtures/mockApi';
import type { RequestOutputs } from '../../src/shared/types';

const defaults: RequestOutputs = {
  enabled: true,
  values: [{ name: 'api_token', source: { kind: 'json', pointer: '/access_token' } }],
  refreshAfterSeconds: 3600,
  expiresInPointer: '/expires_in',
  resendOn401: 'safe-methods',
};

const core = { id: 'core', name: 'Core', variables: [], createdAt: 1, updatedAt: 1 };
const login = (patch: Parameters<typeof createMockRequest>[0] extends infer T ? Partial<T> : never = {}) =>
  createMockRequest({ id: 'login', name: 'Get session token', method: 'POST', url: 'https://auth.test/token', ...patch });
const child = (patch: Partial<ReturnType<typeof createMockRequest>> = {}) =>
  createMockRequest({ id: 'orders', name: 'List orders', url: 'https://api.test/orders', auth: { type: 'bearer', bearer: { token: '{{api_token}}', prefix: '' } }, ...patch });

async function openRequest(page: Page, id: string) {
  await page.getByTestId(`sidebar-request-row-${id}`).click();
}

async function lastOutputsSaved(page: Page) {
  return page.evaluate(() => ((window as unknown as MockWindow).__lastCollectionUpdate?.payload as { outputs?: unknown } | undefined)?.outputs);
}

test.describe('Outputs tab', () => {
  test('turning outputs on saves the defaults, edits save, and invalid values are not saved', async ({ page }) => {
    await installMockApi(page, { nodes: [login(), child()], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-enabled').check();

    await expect(page.getByTestId('request-output-name-0')).toHaveValue('api_token');
    await expect(page.getByTestId('request-output-path-0')).toHaveValue('/access_token');
    await expect(page.getByTestId('request-outputs-refresh-seconds')).toHaveValue('3600');
    await expect(page.getByTestId('request-outputs-expires-pointer')).toHaveValue('/expires_in');
    await expect(page.getByTestId('request-outputs-resend-401')).toHaveValue('safe-methods');
    await expect.poll(() => lastOutputsSaved(page)).toEqual(defaults);

    await page.getByTestId('request-outputs-refresh-seconds').fill('60');
    await expect.poll(() => lastOutputsSaved(page)).toMatchObject({ refreshAfterSeconds: 60 });

    // The expiry field follows the first JSON field while it is still its sibling.
    await page.getByTestId('request-output-path-0').fill('/data/access_token');
    await expect(page.getByTestId('request-outputs-expires-pointer')).toHaveValue('/data/expires_in');

    await page.getByTestId('request-outputs-refresh-seconds').fill('0');
    await expect(page.getByTestId('request-outputs-error')).toContainText('whole number of seconds');
    await page.getByTestId('request-output-path-0').fill('access_token');
    await expect(page.getByTestId('request-outputs-error')).toContainText('must start with "/"');
    await expect.poll(() => lastOutputsSaved(page)).toMatchObject({ refreshAfterSeconds: 60, values: [{ source: { pointer: '/data/access_token' } }] });

    // Navigating away and back shows what was saved.
    await openRequest(page, 'orders');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await expect(page.getByTestId('request-outputs-refresh-seconds')).toHaveValue('60');
    await expect(page.getByTestId('request-output-path-0')).toHaveValue('/data/access_token');
  });

  test('a name another request provides is refused before saving', async ({ page }) => {
    const other = createMockRequest({ id: 'other', name: 'Other login', outputs: defaults });
    await installMockApi(page, { nodes: [login(), other], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-enabled').check();
    await expect(page.getByTestId('request-outputs-error')).toHaveText('"api_token" is already an output of "Other login". Choose another name. Not saved.');
    expect(await lastOutputsSaved(page)).toBeUndefined();

    await page.getByTestId('request-output-name-0').fill('session_token');
    await expect(page.getByTestId('request-outputs-error')).toHaveCount(0);
    await expect.poll(() => lastOutputsSaved(page)).toMatchObject({ values: [{ name: 'session_token' }] });
  });

  test('the 401 resend mode saves, any method warns that a body is sent twice, and an earlier boolean shows its meaning', async ({ page }) => {
    await installMockApi(page, { nodes: [login({ outputs: defaults }), createMockRequest({ id: 'legacy', name: 'Legacy login', outputs: { ...defaults, enabled: false, resendOn401: true as never } })], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    const resend = page.getByTestId('request-outputs-resend-401');
    await expect(resend).toHaveValue('safe-methods');
    await expect(page.getByText('sends its body to the server a second time')).toHaveCount(0);
    await resend.selectOption('any-method');
    await expect.poll(() => lastOutputsSaved(page)).toMatchObject({ resendOn401: 'any-method' });
    await expect(page.getByText('A resent POST, PUT, PATCH or DELETE sends its body to the server a second time.')).toBeVisible();
    await resend.selectOption('off');
    await expect.poll(() => lastOutputsSaved(page)).toMatchObject({ resendOn401: 'off' });

    await openRequest(page, 'legacy');
    await page.getByTestId('request-outputs-tab').click();
    await expect(page.getByTestId('request-outputs-resend-401')).toHaveValue('any-method');
  });

  test('Refresh now runs the token request for the selected environment, shows the answer, and can be cancelled', async ({ page }) => {
    const fetchedAt = new Date(2026, 10, 19, 14, 2, 0).getTime();
    await installMockApi(page, {
      nodes: [login({ outputs: defaults })], environments: [core],
      outputRefreshStatus: { requestId: 'login', environmentId: 'core', state: 'fresh', names: ['api_token'], fetchedAt, refreshAt: fetchedAt + 3_570_000 },
    });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await expect(page.getByTestId('request-outputs-status')).toContainText('not fetched yet');
    await page.getByTestId('request-outputs-refresh').click();
    await expect(page.getByTestId('request-outputs-status')).toContainText('Core: fetched');
    const calls = () => page.evaluate(() => (window as unknown as { __outputsCalls: { refresh: unknown[]; cancel: unknown[] } }).__outputsCalls);
    expect((await calls()).refresh).toEqual([{ requestId: 'login', environmentId: 'core' }]);
    await expect(page.getByTestId('request-outputs-refresh')).toBeEnabled();

    // While a refresh runs the button becomes Cancel, which stops it.
    await page.evaluate(() => {
      const api = (window as unknown as MockWindow).api as unknown as { outputsRefresh: (payload: unknown) => Promise<unknown>; outputsCancelRefresh: (payload: unknown) => Promise<void> };
      let release: (() => void) | undefined;
      api.outputsRefresh = async (payload: unknown) => {
        (window as unknown as { __outputsCalls: { refresh: unknown[] } }).__outputsCalls.refresh.push(payload);
        await new Promise<void>(resolve => { release = resolve; });
        return { requestId: 'login', environmentId: 'core', state: 'empty', names: ['api_token'] };
      };
      const cancel = api.outputsCancelRefresh;
      api.outputsCancelRefresh = async (payload: unknown) => { await cancel(payload); release?.(); };
    });
    await page.getByTestId('request-outputs-refresh').click();
    await expect(page.getByTestId('request-outputs-status')).toHaveText('Core: fetching…');
    await page.getByTestId('request-outputs-cancel-refresh').click();
    await expect(page.getByTestId('request-outputs-refresh')).toBeVisible();
    await expect(page.getByTestId('request-outputs-cancel-refresh')).toHaveCount(0);
    expect((await calls()).cancel).toEqual([{ requestId: 'login' }]);
  });

  test('Refresh now waits until the outputs form is valid', async ({ page }) => {
    await installMockApi(page, { nodes: [login({ outputs: defaults })], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-refresh-seconds').fill('0');
    await expect(page.getByTestId('request-outputs-refresh')).toBeDisabled();
    await page.getByTestId('request-outputs-refresh-seconds').fill('60');
    await expect(page.getByTestId('request-outputs-refresh')).toBeEnabled();
  });

  test('turning outputs off keeps the rows', async ({ page }) => {
    await installMockApi(page, { nodes: [login({ outputs: defaults })], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-enabled').uncheck();
    await expect.poll(() => lastOutputsSaved(page)).toEqual({ ...defaults, enabled: false });
    await expect(page.getByTestId('request-output-name-0')).toHaveValue('api_token');
  });

  test('shows the cached status and clears it', async ({ page }) => {
    const fetchedAt = new Date(2026, 10, 19, 14, 2, 0).getTime();
    await installMockApi(page, {
      nodes: [login({ outputs: defaults })], environments: [core],
      outputStatus: { requestId: 'login', environmentId: 'core', state: 'fresh', names: ['api_token'], fetchedAt, refreshAt: fetchedAt + 3_570_000 },
    });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await expect(page.getByTestId('request-outputs-status')).toContainText('Core: fetched');
    await expect(page.getByTestId('request-outputs-status')).toContainText('refreshes after');
    await page.getByTestId('request-outputs-clear').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __outputsCalls: { clear: unknown[] } }).__outputsCalls.clear)).toEqual([{ requestId: 'login' }]);
  });

  test('a refusal from the store rolls back, so later edits never resend the refused outputs', async ({ page }) => {
    await installMockApi(page, { nodes: [login()], environments: [core] });
    await page.goto('/');
    await page.evaluate(() => {
      const api = (window as unknown as MockWindow).api;
      const original = api.collectionUpdate;
      api.collectionUpdate = async (id: string, data: { outputs?: unknown }) => {
        if (data?.outputs) throw new Error("Error invoking remote method 'collection:update': Error: \"api_token\" is already an output of \"Hidden\". Choose another name.");
        return original(id, data);
      };
    });
    await openRequest(page, 'login');
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-enabled').check();
    await expect(page.getByTestId('request-outputs-error')).toHaveText('"api_token" is already an output of "Hidden". Choose another name. Not saved.');

    await page.getByRole('button', { name: 'Headers', exact: true }).click();
    await page.locator('textarea[aria-label="Request URL"]').fill('https://auth.test/token2');
    await page.locator('textarea[aria-label="Request URL"]').blur();
    await expect.poll(() => page.evaluate(() => ((window as unknown as MockWindow).__lastCollectionUpdate?.payload as { url?: string })?.url)).toBe('https://auth.test/token2');
    expect(await lastOutputsSaved(page)).toBeUndefined();
  });

  test('the draft of a request with outputs keeps no response body in local storage', async ({ page }) => {
    const lastResponse = createTextResponse({ requestId: 'login', text: '{"access_token":"tok-secret-1"}', format: 'json' });
    await installMockApi(page, { nodes: [login({ outputs: defaults, lastResponse: lastResponse as never }), child()], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'login');
    await page.locator('textarea[aria-label="Request URL"]').fill('https://auth.test/token?v=2');
    await openRequest(page, 'orders');
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('restiprocity:request-drafts') ?? '')).toContain('"login"');
    expect(await page.evaluate(() => window.localStorage.getItem('restiprocity:request-drafts'))).not.toContain('tok-secret-1');
  });
});

test.describe('using outputs in other requests', () => {
  test('the URL preview masks an output and autocomplete offers it', async ({ page }) => {
    await installMockApi(page, {
      nodes: [child({ url: 'https://api.test/orders?t={{api_token}}' }), login({ outputs: defaults })], environments: [core],
    });
    await page.goto('/');
    await openRequest(page, 'orders');
    await expect(page.getByTestId('request-url-preview')).toContainText('••••••••');

    const url = page.locator('textarea[aria-label="Request URL"]');
    await url.fill('https://api.test/_.api');
    await expect(page.getByText('api_token', { exact: true })).toBeVisible();
  });

  test('the Bearer field shows where its token comes from', async ({ page }) => {
    await installMockApi(page, { nodes: [child(), login({ outputs: defaults })], environments: [core] });
    await page.goto('/');
    await openRequest(page, 'orders');
    await page.getByRole('button', { name: 'Auth', exact: true }).click();
    await expect(page.getByTestId('bearer-output-hint')).toHaveText('From “Get session token” · refreshes after 3600 s, or sooner if the response says so');
  });

  test('the overlay names the token request while it runs', async ({ page }) => {
    await installMockApi(page, { nodes: [child(), login({ outputs: defaults })], environments: [core], sendMode: 'pending' });
    await page.goto('/');
    await openRequest(page, 'orders');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as MockWindow).__lastSendRequest?.operationId ?? '')).not.toBe('');
    const operationId = await page.evaluate(() => (window as unknown as MockWindow).__lastSendRequest!.operationId);
    await page.evaluate((id) => (window as unknown as MockWindow).__mockApi.emitProgress({
      version: 2, operationId: id, phase: 'acquiring-token', receivedBytes: 0, tokenSource: 'Get session token',
    }), operationId);
    await expect(page.getByText('Getting token from “Get session token”…')).toBeVisible();
  });

  for (const [label, patch, expected] of [
    ['updated', { outputsNote: { kind: 'updated', names: ['api_token'] } }, 'Outputs updated: api_token (kept in memory only).'],
    ['not updated', { outputsNote: { kind: 'not-updated', message: 'Couldn\'t get {{api_token}}: "Get session token" returned HTTP 403.' } }, 'Outputs not updated: Couldn\'t get {{api_token}}: "Get session token" returned HTTP 403.'],
    ['resent after 401', { outputsNote: { kind: 'resent-after-401', names: ['api_token'] } }, 'Got HTTP 401, so a new api_token was fetched and the request was sent again.'],
    ['withheld body', { bodyWithheld: 'outputs' }, 'Body not saved: this request provides outputs, which are kept in memory only.'],
  ] as const) {
    test(`the response shows the ${label} note`, async ({ page }) => {
      const response = { ...createTextResponse({ requestId: 'orders', text: 'ok' }), ...patch };
      await installMockApi(page, { nodes: [child(), login({ outputs: defaults })], environments: [core], defaultResponse: createResponseResult(response as never) });
      await page.goto('/');
      await openRequest(page, 'orders');
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByTestId('response-outputs-note')).toHaveText(expected);
    });
  }
});
