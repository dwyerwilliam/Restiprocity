import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { expect, test } from '@playwright/test';
import { startHttpFixture, startHttpsFixture, type NativeFixture } from './fixtures/nativeServers';

type NativeResult = { kind: string; response?: { status: number; cookies: Array<Record<string, unknown>>; preview: { text?: string } }; error?: { kind: string } };
type NativeCollectionNode = { id: string; parentId?: string };
type NativeEnvironment = { id: string; name: string };
type NativeApi = {
  sendRequest(payload: { operationId: string; request: RequestShape; environmentId?: string }): Promise<NativeResult>;
  collectionCreate(data: unknown): Promise<NativeCollectionNode>;
  collectionMoveRequest(data: unknown): Promise<NativeCollectionNode>;
  collectionList(): Promise<NativeCollectionNode[]>;
  envCreate(data: unknown): Promise<NativeEnvironment>;
  envList(): Promise<NativeEnvironment[]>;
  envSwitch(id: string | null): Promise<string>;
  settingsGet(): Promise<{ activeEnvironmentId?: string }>;
  historyList(filters?: unknown): Promise<Array<Record<string, unknown>>>;
};
type RequestShape = {
  id: string; name: string; method: 'GET'; url: string; headers: Array<{ key: string; value: string; enabled: boolean }>;
  parameters: []; body: { type: 'none' }; auth: { type: string; ntlm?: { useCurrentAuthContext: boolean } }; settings: { followRedirect: boolean; timeout: number; cookiesEnabled?: boolean; allowInsecureCertificates?: boolean };
  scripts: {}; createdAt: number; updatedAt: number;
};

const repoRoot = path.resolve(__dirname, '..', '..');
const host = 'api.restiprocity.test';
const tlsHost = 'tls.restiprocity.test';
let operation = 0;

function request(url: string, overrides: Partial<RequestShape> = {}): RequestShape {
  const now = Date.now();
  return { id: `native-${++operation}`, name: 'Native identity request', method: 'GET', url, headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {}, createdAt: now, updatedAt: now, ...overrides };
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.', `--host-rules=MAP *.restiprocity.test 127.0.0.1`], cwd: repoRoot,
    env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => {
    const candidate = (window as unknown as { api?: Partial<NativeApi> }).api;
    return typeof candidate?.sendRequest === 'function';
  }, undefined, { timeout: 60_000 });
  return { app, page };
}

async function call<K extends keyof NativeApi>(page: Page, expression: K, ...args: Parameters<NativeApi[K]>): Promise<Awaited<ReturnType<NativeApi[K]>>> {
  return page.evaluate(([source, values]) => {
    const nativeApi = (window as unknown as { api: Record<string, (...parameters: unknown[]) => Promise<unknown>> }).api;
    return nativeApi[source](...values);
  }, [expression, args]) as Promise<Awaited<ReturnType<NativeApi[K]>>>;
}
async function send(page: Page, req: RequestShape, environmentId?: string): Promise<NativeResult> {
  return call(page, 'sendRequest', { operationId: `op-${++operation}`, request: req, ...(environmentId ? { environmentId } : {}) });
}
async function isolatedUserData(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-native-')); }
async function close(app: ElectronApplication | undefined): Promise<void> { if (app) await app.close().catch(() => {}); }
async function withFixture<T>(run: (fixture: NativeFixture, userData: string) => Promise<T>): Promise<T> {
  const fixture = await startHttpFixture();
  const userData = await isolatedUserData();
  try { return await run(fixture, userData); } finally { await fixture.close(); await fs.rm(userData, { recursive: true, force: true }); }
}

test('real send identity and private history', async () => withFixture(async (fixture, userData) => {
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData); app = launched.app;
    const req = request(`http://${host}:${fixture.port}/identity`);
    const result = await send(launched.page, req);
    expect(result.kind).toBe('response');
    expect(fixture.observations.at(-1)).toMatchObject({ path: '/identity', host: `${host}:${fixture.port}` });
    const history = await call(launched.page, 'historyList');
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: req.id, requestName: req.name, method: 'GET', url: req.url, status: 200 })]));
    expect((await fs.stat(path.join(userData, 'history.db'))).size).toBeGreaterThan(0);
  } finally { await close(app); }
}));

test('session cookie transport and privacy', async () => withFixture(async (fixture, userData) => {
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData); app = launched.app;
    const set = await send(launched.page, request(`http://${host}:${fixture.port}/set`));
    expect(set.response.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'private-one', httpOnly: true })]));
    const echo = await send(launched.page, request(`http://${host}:${fixture.port}/redirect`));
    expect(fixture.observations.at(-1)?.cookie).toContain('session=private-one');
    expect(fixture.observations.at(-1)?.cookie).toContain('domain-cookie=domain-value');
    expect(echo.response.preview.text).toContain('session=private-one');
    const history = await call<any[]>(launched.page, 'historyList');
    expect(JSON.stringify(history)).not.toContain('private-one');
    expect(JSON.stringify(history)).not.toContain('Set-Cookie');
  } finally { await close(app); }
}));

test('restart restores environment but not API cookies', async () => withFixture(async (fixture, userData) => {
  let app: ElectronApplication | undefined;
  try {
    let launched = await launch(userData); app = launched.app;
    const env = await call(launched.page, 'envCreate', { id: 'native-local', name: 'Native Local', variables: [{ key: 'base', value: `http://${host}:${fixture.port}`, type: 'standard' }] });
    await call(launched.page, 'envSwitch', env.id);
    await send(launched.page, request(`http://${host}:${fixture.port}/set`));
    await close(app); app = undefined;
    launched = await launch(userData); app = launched.app;
    expect((await call(launched.page, 'settingsGet')).activeEnvironmentId).toBe('native-local');
    await send(launched.page, request(`http://${host}:${fixture.port}/echo`));
    expect(fixture.observations.at(-1)?.cookie).toBeUndefined();
  } finally { await close(app); }
}));

test('cookie-disabled native login', async () => withFixture(async (fixture, userData) => {
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData); app = launched.app;
    const result = await send(launched.page, request(`http://${host}:${fixture.port}/login`, { auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: false } }));
    expect(result.kind).toBe('response');
    expect(result.response.status).toBe(401);
    expect(result.response.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'login-observed' })]));
    expect(fixture.observations[0]?.cookie).toBeUndefined();
    expect(fixture.observations.length).toBeGreaterThan(0);
    await send(launched.page, request(`http://${host}:${fixture.port}/echo`));
    expect(fixture.observations.at(-1)?.cookie).toBeUndefined();
  } finally { await close(app); }
}));

test('TLS and jar isolation', async () => {
  const fixture = await startHttpsFixture(); const userData = await isolatedUserData(); let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData); app = launched.app;
    const strict = await send(launched.page, request(`https://${tlsHost}:${fixture.port}/identity`));
    expect(strict.kind).toBe('failed'); expect(strict.error.kind).toBe('certificate');
    const insecure = await send(launched.page, request(`https://${tlsHost}:${fixture.port}/set`, { settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true, allowInsecureCertificates: true } }));
    expect(insecure.kind).toBe('response');
    await send(launched.page, request(`https://${tlsHost}:${fixture.port}/echo`, { settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true, allowInsecureCertificates: true } }));
    expect(fixture.observations.at(-1)?.cookie).toContain('session=private-one');
    const observationsBeforeStrict = fixture.observations.length;
    const strictEcho = await send(launched.page, request(`https://${tlsHost}:${fixture.port}/echo`, { settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true } }));
    expect(strictEcho.kind).toBe('failed');
    expect(fixture.observations.length).toBe(observationsBeforeStrict);
  } finally { await close(app); await fixture.close(); await fixture.cleanupCertificate(); await fs.rm(userData, { recursive: true, force: true }); }
});

test('invalid move leaves files untouched', async () => {
  const userData = await isolatedUserData(); let app: ElectronApplication | undefined;
  try {
    const launched = await launch(userData); app = launched.app;
    await call(launched.page, 'collectionCreate', { name: 'Target', children: [] });
    const req = await call(launched.page, 'collectionCreate', request('http://invalid.test', { name: 'Move me' }));
    const directory = path.join(userData, 'collections');
    const namesBefore = (await fs.readdir(directory)).sort();
    const before = Object.fromEntries(await Promise.all(namesBefore.map(async (name) => [name, (await fs.readFile(path.join(directory, name))).toString('base64')])));
    await expect(call(launched.page, 'collectionMoveRequest', { requestId: req.id, targetParentId: 'missing-target', targetIndex: 0 })).rejects.toThrow();
    const namesAfter = (await fs.readdir(directory)).sort();
    const after = Object.fromEntries(await Promise.all(namesAfter.map(async (name) => [name, (await fs.readFile(path.join(directory, name))).toString('base64')])));
    expect(namesAfter).toEqual(namesBefore);
    expect(after).toEqual(before);
    expect((await call(launched.page, 'collectionList')).find((node) => node.id === req.id)?.parentId).toBeUndefined();
  } finally { await close(app); await fs.rm(userData, { recursive: true, force: true }); }
});

test('invalid environment fallback', async () => {
  const userData = await isolatedUserData(); let app: ElectronApplication | undefined;
  try {
    await fs.mkdir(path.join(userData, 'environments'), { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ theme: 'light', activeEnvironmentId: 'missing-environment' }));
    const launched = await launch(userData); app = launched.app;
    expect((await call(launched.page, 'settingsGet')).activeEnvironmentId).toBe('core');
    expect((await call(launched.page, 'envList')).some((env) => env.id === 'core')).toBe(true);
  } finally { await close(app); await fs.rm(userData, { recursive: true, force: true }); }
});
