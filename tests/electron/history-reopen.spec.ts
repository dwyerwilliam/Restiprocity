import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { startHttpFixture, type NativeFixture } from './fixtures/nativeServers';

type RequestShape = {
  id: string;
  name: string;
  method: 'GET';
  url: string;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  parameters: [];
  body: { type: 'none' };
  auth: { type: 'none' };
  settings: { followRedirect: boolean; timeout: number; cookiesEnabled: boolean };
  scripts: {};
  createdAt: number;
  updatedAt: number;
};

type HistoryEntry = { id: string; requestId: string; requestName: string; method: string; url: string; status: number; duration: number };
type HistoryDetail = HistoryEntry & { headers: Array<Record<string, unknown>>; cookies: Array<Record<string, unknown>>; preview: { text?: string } };
type CollectionNode = { id: string; type: string; name: string };
type NativeApi = {
  sendRequest(payload: { operationId: string; request: RequestShape }): Promise<{ kind: string }>;
  collectionCreate(data: RequestShape): Promise<CollectionNode>;
  collectionDelete(id: string): Promise<void>;
  collectionList(): Promise<CollectionNode[]>;
  historyList(): Promise<HistoryEntry[]>;
  historyGet(id: string): Promise<HistoryDetail | null>;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const host = 'api.restiprocity.test';
let sequence = 0;

function request(url: string, name: string): RequestShape {
  const now = Date.now();
  return {
    id: `history-native-${++sequence}`,
    name,
    method: 'GET',
    url,
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.', `--host-rules=MAP *.restiprocity.test 127.0.0.1`],
    cwd: repoRoot,
    env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof (window as unknown as { api?: Partial<NativeApi> }).api?.historyGet === 'function', undefined, { timeout: 60_000 });
  return { app, page };
}

async function call<K extends keyof NativeApi>(page: Page, method: K, ...args: Parameters<NativeApi[K]>): Promise<Awaited<ReturnType<NativeApi[K]>>> {
  return page.evaluate(([name, values]) => {
    const api = (window as unknown as { api: Record<string, (...parameters: unknown[]) => Promise<unknown>> }).api;
    return api[name](...values);
  }, [method, args]) as Promise<Awaited<ReturnType<NativeApi[K]>>>;
}

async function send(page: Page, requestValue: RequestShape): Promise<void> {
  await call(page, 'sendRequest', { operationId: `history-operation-${++sequence}`, request: requestValue });
}

async function close(app: ElectronApplication | undefined): Promise<void> {
  if (app) await app.close().catch(() => {});
}

async function setup(): Promise<{ fixture: NativeFixture; userData: string }> {
  return { fixture: await startHttpFixture(), userData: await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-history-reopen-')) };
}

test('reopens persisted history after restart through rendered UI without resending', async () => {
  const { fixture, userData } = await setup();
  let app: ElectronApplication | undefined;
  try {
    const first = await launch(userData);
    app = first.app;
    const savedRequest = request(`http://${host}:${fixture.port}/set`, 'Persisted history request');
    await call(first.page, 'collectionCreate', savedRequest);
    await send(first.page, savedRequest);
    expect(fixture.observations).toHaveLength(1);

    const entry = (await call(first.page, 'historyList')).find(item => item.requestId === savedRequest.id);
    expect(entry).toBeDefined();
    const detail = await call(first.page, 'historyGet', entry!.id);
    expect(detail?.preview.text).toContain('set response without cookie values');
    expect(JSON.stringify(detail)).not.toContain('private-one');
    expect(JSON.stringify(detail)).not.toContain('Set-Cookie');

    await close(app);
    app = undefined;
    const restarted = await launch(userData);
    app = restarted.app;
    expect(await call(restarted.page, 'historyGet', entry!.id)).toMatchObject({ id: entry!.id, requestId: savedRequest.id });
    await restarted.page.getByTestId('sidebar').getByText(savedRequest.name, { exact: true }).click();
    await restarted.page.getByRole('button', { name: 'Show History', exact: true }).click();
    const row = restarted.page.getByTestId(`history-row-${entry!.id}`);
    await row.locator('[role="button"]').first().focus();
    await restarted.page.keyboard.press('Enter');
    const reopen = row.getByRole('button', { name: 'Reopen', exact: true });
    await reopen.click();
    await expect(restarted.page.getByTestId('historical-response-notice')).toBeVisible();
    await expect(restarted.page.getByText('set response without cookie values', { exact: true })).toBeVisible();
    await restarted.page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expect(restarted.page.getByTestId('response-cookies-redacted')).toBeVisible();
    await expect(restarted.page.locator('body')).not.toContainText('private-one');
    expect(fixture.observations).toHaveLength(1);
  } finally {
    await close(app);
    await fixture.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('deleted history reopens as non-persistent temporary state and stays absent after restart', async () => {
  const { fixture, userData } = await setup();
  let app: ElectronApplication | undefined;
  try {
    const first = await launch(userData);
    app = first.app;
    const deletedRequest = request(`http://${host}:${fixture.port}/identity`, 'Deleted history request');
    await call(first.page, 'collectionCreate', deletedRequest);
    await send(first.page, deletedRequest);
    const entry = (await call(first.page, 'historyList')).find(item => item.requestId === deletedRequest.id);
    expect(entry).toBeDefined();
    await call(first.page, 'collectionDelete', deletedRequest.id);
    expect((await call(first.page, 'collectionList')).some(node => node.id === deletedRequest.id)).toBe(false);
    await expect(fs.stat(path.join(userData, 'collections', `${deletedRequest.id}.req.json`))).rejects.toThrow();

    await first.page.reload();
    await first.page.getByRole('button', { name: 'Show History', exact: true }).click();
    const row = first.page.getByTestId(`history-row-${entry!.id}`);
    await row.locator('[role="button"]').first().focus();
    await first.page.keyboard.press('Enter');
    await row.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(first.page.getByTestId('temporary-request-banner')).toBeVisible();
    await expect(first.page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await first.page.locator('input[placeholder="Enter request URL"]').fill('http://edited-after-delete.test/');
    await first.page.locator('input[placeholder="Enter request URL"]').press('Tab');
    const draftState = await first.page.evaluate(() => localStorage.getItem('restiprocity:request-drafts'));
    expect(draftState ?? '{}').toBe('{}');
    expect(fixture.observations).toHaveLength(1);

    await close(app);
    app = undefined;
    const restarted = await launch(userData);
    app = restarted.app;
    expect(await call(restarted.page, 'historyGet', entry!.id)).toMatchObject({ id: entry!.id, requestId: deletedRequest.id });
    expect((await call(restarted.page, 'collectionList')).some(node => node.id === deletedRequest.id)).toBe(false);
    expect(await restarted.page.evaluate(() => localStorage.getItem('restiprocity:request-drafts'))).toBeNull();
    await expect(restarted.page.getByTestId('temporary-request-banner')).toHaveCount(0);
    expect(fixture.observations).toHaveLength(1);
  } finally {
    await close(app);
    await fixture.close();
    await fs.rm(userData, { recursive: true, force: true });
  }
});

test('legacy cookie-bearing and corrupt history rows stay private and recoverable over real IPC', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-history-legacy-'));
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData);
    app = launched.app;
    // The store opens history.db lazily; touch it so the schema exists before seeding.
    expect(await call(launched.page, 'historyList')).toEqual([]);
    // Seed rows directly into the live history.db from the main process, as an older build would have written them.
    await app.evaluate(async (_electron, dbPath) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const Database = createRequire(`${process.cwd()}/package.json`)('better-sqlite3');
      const db = new Database(dbPath);
      try {
        const insert = db.prepare(`
          INSERT INTO history (
            id, request_id, request_name, method, url, status, duration, size, timestamp,
            response_headers, response_timings, status_text, cookies_json,
            preview_version, preview_kind, preview_bytes, preview_truncated, preview_captured_bytes, media_type, charset
          ) VALUES (
            @id, 'legacy-native-request', 'Legacy request', 'GET', 'https://legacy.restiprocity.test/auth', 200, 45, 18, 1000,
            @headers, '{"total":5}', 'OK', @cookies,
            2, 'text', @bytes, 0, 18, 'text/plain', 'utf-8'
          )
        `);
        insert.run({
          id: 'legacy-cookie-row',
          headers: JSON.stringify([
            { key: 'Content-Type', value: 'text/plain', enabled: true },
            { key: 'Set-Cookie', value: 'legacy_token=legacy-secret-value; Path=/', enabled: true },
            { key: 'Cookie', value: 'legacy_session=legacy-session-value', enabled: true },
          ]),
          cookies: JSON.stringify([{ name: 'legacy_token', value: 'legacy-secret-value', domain: 'legacy.restiprocity.test' }]),
          bytes: Buffer.from('legacy response text'),
        });
        insert.run({ id: 'corrupt-headers-row', headers: '{"not":"an array"}', cookies: '[]', bytes: Buffer.from('corrupt') });
      } finally {
        db.close();
      }
    }, path.join(userData, 'history.db'));

    const legacy = await call(launched.page, 'historyGet', 'legacy-cookie-row');
    expect(legacy?.preview.text).toBe('legacy response text');
    expect(legacy?.cookies).toEqual([]);
    expect(legacy?.headers).toEqual([{ key: 'Content-Type', value: 'text/plain', enabled: true }]);
    const serialized = JSON.stringify(legacy);
    for (const secret of ['legacy-secret-value', 'legacy-session-value', 'legacy_token', 'legacy_session', 'Set-Cookie']) {
      expect(serialized).not.toContain(secret);
    }

    await expect(call(launched.page, 'historyGet', 'corrupt-headers-row')).rejects.toThrow('History entry could not be read.');
    expect(await call(launched.page, 'historyGet', 'missing-history-row')).toBeNull();
  } finally {
    await close(app);
    await fs.rm(userData, { recursive: true, force: true });
  }
});
