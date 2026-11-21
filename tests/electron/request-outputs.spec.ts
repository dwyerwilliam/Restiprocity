import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication, type Page } from 'playwright';
import { closeApp, expect, launchApp, test } from './fixtures/electronApp';

// A distinctive part of every issued token, searched for afterwards in everything the app wrote.
const MARKER = 'chain-marker-7f3a';
const repoRoot = path.resolve(__dirname, '..', '..');

interface TokenServer {
  port: number;
  state: { issued: number; valid: Set<string>; tokenHits: number; protectedAuth: string[]; expiresIn: number; failStatus: number; slowMs: number };
  close(): Promise<void>;
}

/** /token issues tok-N-<marker>; /protected accepts any issued token until /revoke invalidates them all. Nothing echoes a token. */
async function startTokenServer(): Promise<TokenServer> {
  const state: TokenServer['state'] = { issued: 0, valid: new Set(), tokenHits: 0, protectedAuth: [], expiresIn: 3600, failStatus: 0, slowMs: 0 };
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = request.url ?? '/';
    if (url.startsWith('/token')) {
      state.tokenHits += 1;
      if (state.slowMs) await new Promise(resolve => setTimeout(resolve, state.slowMs));
      if (state.failStatus) {
        response.statusCode = state.failStatus;
        response.setHeader('Content-Type', 'application/json');
        response.end('{"error":"unavailable"}');
        return;
      }
      state.issued += 1;
      const token = `tok-${state.issued}-${MARKER}`;
      state.valid.add(token);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: state.expiresIn }));
      return;
    }
    if (url === '/revoke') {
      state.valid.clear();
      response.end('revoked');
      return;
    }
    if (url === '/protected') {
      const authorization = request.headers.authorization ?? '';
      state.protectedAuth.push(authorization);
      response.setHeader('Content-Type', 'text/plain');
      if (authorization.startsWith('Bearer ') && state.valid.has(authorization.slice('Bearer '.length))) response.end('orders: 3');
      else {
        response.statusCode = 401;
        response.end('unauthorized');
      }
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('token server has no port');
  return { port: address.port, state, close: () => new Promise(resolve => server.close(() => resolve())) };
}

type Api = Record<string, (...args: unknown[]) => Promise<any>>;

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp({
    args: ['.', '--host-rules=MAP *.restiprocity.test 127.0.0.1'], cwd: repoRoot,
    env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof (window as unknown as { api?: Api }).api?.sendRequest === 'function', undefined, { timeout: 60_000 });
  return { app, page };
}

async function call(page: Page, method: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(([name, values]) => (window as unknown as { api: Api }).api[name as string](...(values as unknown[])), [method, args] as const);
}

let operation = 0;
const outputs = (patch: Record<string, unknown> = {}) => ({
  enabled: true, values: [{ name: 'api_token', source: { kind: 'json', pointer: '/access_token' } }],
  refreshAfterSeconds: 3600, expiresInPointer: '/expires_in', resendOn401: 'safe-methods', ...patch,
});

function tokenRequest(port: number, patch: Record<string, unknown> = {}) {
  return {
    nodeType: 'request', name: 'Get session token', method: 'POST', url: `http://auth.restiprocity.test:${port}/token`,
    headers: [], parameters: [], body: { type: 'raw', raw: { language: 'json', content: '{"client":"native"}' } },
    auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {}, outputs: outputs(), ...patch,
  };
}

function childRequest(port: number, patch: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'orders', name: 'List orders', method: 'GET', url: `http://api.restiprocity.test:${port}/protected`, headers: [], parameters: [],
    body: { type: 'none' }, auth: { type: 'bearer', bearer: { token: '{{api_token}}', prefix: '' } },
    settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {}, createdAt: now, updatedAt: now, ...patch,
  };
}

async function send(page: Page, request: unknown, environmentId?: string): Promise<any> {
  return call(page, 'sendRequest', { operationId: `chain-${++operation}`, request, ...(environmentId ? { environmentId } : {}) });
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(full) : Promise.resolve([full]);
  }));
  return nested.flat();
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const file of await filesUnder(root)) {
    const content = await fs.readFile(file).catch(() => Buffer.alloc(0));
    if (content.includes(Buffer.from(needle))) hits.push(path.relative(root, file));
  }
  return hits;
}

test('a token request feeds Bearer auth: fetched once, reused, refreshed, resent after 401, kept off disk', async () => {
  test.setTimeout(120_000);
  const server = await startTokenServer();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-outputs-native-'));
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(userData));
    const page = await app.firstWindow();
    const login = await call(page, 'collectionCreate', tokenRequest(server.port, { outputs: outputs({ refreshAfterSeconds: 2 }) }));

    // Cold send: one token request, then the child with exactly that token.
    const first = await send(page, childRequest(server.port));
    expect(first.kind).toBe('response');
    expect(first.response.status).toBe(200);
    expect(server.state.tokenHits).toBe(1);
    expect(server.state.protectedAuth).toEqual([`Bearer tok-1-${MARKER}`]);

    // Reused within the interval.
    await send(page, childRequest(server.port, { id: 'create', name: 'Create order' }));
    expect(server.state.tokenHits).toBe(1);

    // Stale after the interval: fetched again first.
    await page.waitForTimeout(2100);
    const third = await send(page, childRequest(server.port));
    expect(third.response.status).toBe(200);
    expect(server.state.tokenHits).toBe(2);
    expect(server.state.protectedAuth.at(-1)).toBe(`Bearer tok-2-${MARKER}`);

    // Revoked early: the 401 is replaced by one new token and one resend.
    await fetch(`http://127.0.0.1:${server.port}/revoke`);
    const before = server.state.protectedAuth.length;
    const resent = await send(page, childRequest(server.port));
    expect(resent.response.status).toBe(200);
    expect(resent.response.outputsNote).toEqual({ kind: 'resent-after-401', names: ['api_token'] });
    expect(server.state.tokenHits).toBe(3);
    expect(server.state.protectedAuth.slice(before)).toEqual([`Bearer tok-2-${MARKER}`, `Bearer tok-3-${MARKER}`]);

    // By default a POST is not resent: its body is sent once and the 401 is the answer.
    await fetch(`http://127.0.0.1:${server.port}/revoke`);
    const beforePost = server.state.protectedAuth.length;
    const post = await send(page, childRequest(server.port, { method: 'POST', body: { type: 'raw', raw: { language: 'json', content: '{"qty":1}' } } }));
    expect(post.response.status).toBe(401);
    expect(post.response.outputsNote).toBeUndefined();
    expect(server.state.tokenHits).toBe(3);
    expect(server.state.protectedAuth.length).toBe(beforePost + 1);

    // A shorter expires_in wins over a long interval.
    server.state.expiresIn = 1;
    await call(page, 'collectionUpdate', login.id, { ...tokenRequest(server.port), nodeType: 'request' });
    await send(page, childRequest(server.port));
    expect(server.state.tokenHits).toBe(4);
    await page.waitForTimeout(1100);
    await send(page, childRequest(server.port));
    expect(server.state.tokenHits).toBe(5);
    server.state.expiresIn = 3600;

    // A failing token request stops the send before the child; the next send recovers.
    await call(page, 'outputsClear', { requestId: login.id });
    server.state.failStatus = 500;
    const hitsBeforeFailure = server.state.protectedAuth.length;
    const failed = await send(page, childRequest(server.port));
    expect(failed).toMatchObject({ kind: 'failed', error: { kind: 'authentication', code: 'TOKEN_SOURCE_HTTP' } });
    expect(failed.error.message).toBe('Couldn\'t get {{api_token}}: "Get session token" returned HTTP 500.');
    expect(server.state.protectedAuth.length).toBe(hitsBeforeFailure);
    const status = await call(page, 'outputsStatus', { requestId: login.id });
    expect(status).toMatchObject({ state: 'failed', error: { code: 'TOKEN_SOURCE_HTTP' } });
    server.state.failStatus = 0;
    expect((await send(page, childRequest(server.port))).response.status).toBe(200);
    const fresh = await call(page, 'outputsStatus', { requestId: login.id });
    expect(fresh).toMatchObject({ state: 'fresh', names: ['api_token'] });
    expect(JSON.stringify(fresh)).not.toContain(MARKER);

    // Refresh now runs the token request again while the value is still fresh, and answers with metadata only.
    const hitsBeforeRefresh = server.state.tokenHits;
    const refreshed = await call(page, 'outputsRefresh', { requestId: login.id });
    expect(refreshed).toMatchObject({ state: 'fresh', names: ['api_token'] });
    expect(JSON.stringify(refreshed)).not.toContain(MARKER);
    expect(server.state.tokenHits).toBe(hitsBeforeRefresh + 1);
    await send(page, childRequest(server.port));
    expect(server.state.tokenHits).toBe(hitsBeforeRefresh + 1);
    expect(server.state.protectedAuth.at(-1)).toBe(`Bearer tok-${server.state.issued}-${MARKER}`);

    // Copy as cURL: a fresh token needs confirmation; with none cached it explains and makes no request.
    const copy = await call(page, 'copyRequestAsCurl', { request: childRequest(server.port) });
    expect(copy).toMatchObject({ copied: false, requiresConfirmation: true });
    await call(page, 'outputsClear', { requestId: login.id });
    const tokenHitsBeforeCopy = server.state.tokenHits;
    const refused = await call(page, 'copyRequestAsCurl', { request: childRequest(server.port), confirmSensitive: true });
    expect(refused.copied).toBe(false);
    expect(refused.message).toContain('hasn\'t been fetched for this environment yet');
    expect(server.state.tokenHits).toBe(tokenHitsBeforeCopy);

    // Sending the token request yourself fills the cache, and its history entry keeps no body.
    const saved = (await call(page, 'collectionList')).find((item: { id: string }) => item.id === login.id);
    const manual = await send(page, saved);
    expect(manual.response.outputsNote).toEqual({ kind: 'updated', names: ['api_token'] });
    const tokenHitsAfterManual = server.state.tokenHits;
    await send(page, childRequest(server.port));
    expect(server.state.tokenHits).toBe(tokenHitsAfterManual);
    const history = await call(page, 'historyList', { limit: 50 });
    const manualEntry = history.find((entry: { requestId?: string; request_id?: string }) => (entry.requestId ?? entry.request_id) === login.id);
    expect(manualEntry).toBeTruthy();
    const detail = await call(page, 'historyGet', manualEntry.id);
    expect(detail.bodyWithheld).toBe('outputs');
    expect(detail.preview.kind).toBe('empty');

    await closeApp(app);
    app = undefined;
    expect(await filesContaining(userData, MARKER)).toEqual([]);

    // After a restart the cache is empty: the first send fetches again.
    ({ app } = await launch(userData));
    const restarted = await app.firstWindow();
    const hitsBeforeRestartSend = server.state.tokenHits;
    expect((await send(restarted, childRequest(server.port))).response.status).toBe(200);
    expect(server.state.tokenHits).toBe(hitsBeforeRestartSend + 1);
  } finally {
    if (app) await closeApp(app).catch(() => {});
    await server.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('cancelling while the token request runs stops before the child, and environments get separate tokens', async () => {
  test.setTimeout(90_000);
  const server = await startTokenServer();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-outputs-native-'));
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(userData));
    const page = await app.firstWindow();
    await call(page, 'collectionCreate', tokenRequest(server.port));

    server.state.slowMs = 4000;
    const operationId = `chain-cancel-${++operation}`;
    const pending = call(page, 'sendRequest', { operationId, request: childRequest(server.port) });
    await expect.poll(() => server.state.tokenHits).toBe(1);
    await call(page, 'cancelRequest', operationId);
    expect(await pending).toMatchObject({ kind: 'cancelled' });
    expect(server.state.protectedAuth).toEqual([]);

    // A slow Refresh now is cancelled the same way and leaves nothing cached.
    const login = (await call(page, 'collectionList')).find((item: { name: string }) => item.name === 'Get session token');
    const refreshing = call(page, 'outputsRefresh', { requestId: login.id });
    await expect.poll(() => server.state.tokenHits).toBe(2);
    await call(page, 'outputsCancelRefresh', { requestId: login.id });
    expect(await refreshing).toMatchObject({ state: 'empty' });
    server.state.slowMs = 0;

    const production = await call(page, 'envCreate', { name: 'Production', parentId: 'core', variables: [] });
    await send(page, childRequest(server.port));
    const hits = server.state.tokenHits;
    await send(page, childRequest(server.port), production.id);
    expect(server.state.tokenHits).toBe(hits + 1);
    await send(page, childRequest(server.port));
    await send(page, childRequest(server.port), production.id);
    expect(server.state.tokenHits).toBe(hits + 1);
  } finally {
    if (app) await closeApp(app).catch(() => {});
    await server.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('configured in the window: Outputs tab, a Bearer token that uses it, and Send', async () => {
  test.setTimeout(90_000);
  const server = await startTokenServer();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-outputs-native-'));
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(userData));
    const page = await app.firstWindow();
    const login = await call(page, 'collectionCreate', tokenRequest(server.port, { outputs: undefined }));
    const { id: _id, createdAt: _c, updatedAt: _u, ...childData } = childRequest(server.port, { auth: { type: 'none' } });
    const orders = await call(page, 'collectionCreate', { ...childData, nodeType: 'request' });
    await page.reload();
    await page.waitForFunction(() => typeof (window as unknown as { api?: Api }).api?.sendRequest === 'function');

    await page.getByTestId(`sidebar-request-row-${login.id}`).click();
    await page.getByTestId('request-outputs-tab').click();
    await page.getByTestId('request-outputs-enabled').check();
    await expect(page.getByTestId('request-outputs-status')).toContainText('not fetched yet');

    await page.getByTestId(`sidebar-request-row-${orders.id}`).click();
    await page.getByRole('button', { name: 'Auth', exact: true }).click();
    await page.locator('select').filter({ hasText: 'Bearer Token' }).selectOption('bearer');
    await page.getByTestId('bearer-token-field').locator('input').fill('{{api_token}}');
    await expect(page.getByTestId('bearer-output-hint')).toContainText('From “Get session token”');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('200 OK')).toBeVisible({ timeout: 15_000 });
    expect(server.state.tokenHits).toBe(1);
    expect(server.state.protectedAuth).toEqual([`Bearer tok-1-${MARKER}`]);

    await page.getByTestId(`sidebar-request-row-${login.id}`).click();
    await page.getByTestId('request-outputs-tab').click();
    await expect(page.getByTestId('request-outputs-status')).toContainText('fetched');
    await expect(page.getByTestId('request-outputs-resend-401')).toHaveValue('safe-methods');

    // Refresh now fetches a new token from the window.
    await page.getByTestId('request-outputs-refresh').click();
    await expect.poll(() => server.state.tokenHits).toBe(2);
    await expect(page.getByTestId('request-outputs-refresh')).toBeVisible();
    await expect(page.getByTestId('request-outputs-status')).toContainText('fetched');
  } finally {
    if (app) await closeApp(app).catch(() => {});
    await server.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});
