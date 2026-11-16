import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { startHttpFixture } from './fixtures/nativeServers';

test('the window is sandboxed, runs only its own script, holds no browser permissions, and cannot navigate, open windows or reach the network', async () => {
  const server = await startHttpFixture();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-hardening-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.api?.collectionList === 'function', undefined, { timeout: 60_000 });
    const appUrl = page.url();

    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()!;
      return { sandbox, contextIsolation, nodeIntegration };
    });
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });

    // Content-Security-Policy: page code cannot evaluate strings, run injected script, or make its own requests.
    const target = `http://127.0.0.1:${server.port}/identity`;
    const attempts = await page.evaluate(async (url) => {
      const script = document.createElement('script');
      script.textContent = 'window.__injectedScriptRan = true;';
      document.head.append(script);
      const fetched = await fetch(url).then(() => 'reached', () => 'blocked');
      const image = await new Promise<string>((resolve) => {
        const element = new Image();
        element.onload = () => resolve('reached');
        element.onerror = () => resolve('blocked');
        element.src = url;
      });
      // Checked after the awaits above: a string evaluated directly inside a debugger call is exempt from the policy.
      let evaluated = 'blocked';
      try { evaluated = String((0, eval)('1 + 1')); } catch { /* blocked */ }
      return { evaluated, injected: (window as any).__injectedScriptRan === true, fetched, image };
    }, target);
    expect(attempts).toEqual({ evaluated: 'blocked', injected: false, fetched: 'blocked', image: 'blocked' });
    expect(server.observations).toEqual([]);

    // Browser permissions: the page may copy text and nothing else. Electron grants all of these by default.
    const permissions = await page.evaluate(async () => {
      const state = async (name: string) => (await navigator.permissions.query({ name: name as PermissionName })).state;
      return {
        camera: await state('camera'), microphone: await state('microphone'), geolocation: await state('geolocation'),
        notifications: await state('notifications'), clipboardRead: await state('clipboard-read'),
        clipboardWrite: await state('clipboard-write'),
        notificationRequest: await Notification.requestPermission(),
        // 1 is PERMISSION_DENIED; an allowed request with no location service fails with 2 instead.
        locationRequest: await new Promise<number>((resolve) => {
          navigator.geolocation.getCurrentPosition(() => resolve(0), (error) => resolve(error.code), { timeout: 5000 });
        }),
      };
    });
    expect(permissions).toEqual({
      camera: 'denied', microphone: 'denied', geolocation: 'denied', notifications: 'denied', clipboardRead: 'denied',
      clipboardWrite: 'granted', notificationRequest: 'denied', locationRequest: 1,
    });

    // No new windows, and the window stays on the app's own page.
    expect(await page.evaluate((url) => window.open(url) === null, target)).toBe(true);
    await page.evaluate((url) => { window.location.href = url; }, target);
    await page.waitForTimeout(500);
    expect(page.url()).toBe(appUrl);
    expect(app.windows()).toHaveLength(1);
    expect(server.observations).toEqual([]);

    // The app still works: the preload bridge answers, and a real send still goes through the main process.
    expect(Array.isArray(await page.evaluate(() => window.api.collectionList()))).toBe(true);
    const now = Date.now();
    const sent = await page.evaluate(({ url, createdAt }) => window.api.sendRequest({
      operationId: 'hardening-send',
      request: {
        id: 'hardening-send', name: 'hardening-send', method: 'GET', url, headers: [], parameters: [], body: { type: 'none' },
        auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {},
        createdAt, updatedAt: createdAt,
      },
    }), { url: target, createdAt: now });
    expect(sent.kind).toBe('response');
    expect(server.observations).toHaveLength(1);

    // The main process answers only the app's own page: another page holding the same bridge is refused.
    const foreignPage = await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
      const probe = new BrowserWindow({ show: false, webPreferences: { preload: `${electronApp.getAppPath()}/dist-electron/preload/index.js` } });
      try {
        await probe.loadURL('data:text/html,<title>not the app</title>');
        return await probe.webContents.executeJavaScript(`Promise.all([
          window.api.envList().then(() => 'answered', (error) => error.message),
          window.api.envRevealSecret({ environmentId: 'core', key: 'any' }).then(() => 'answered', (error) => error.message),
          window.api.collectionList().then(() => 'answered', (error) => error.message),
          window.api.settingsGet().then(() => 'answered', (error) => error.message),
        ])`) as string[];
      } finally {
        probe.destroy();
      }
    });
    expect(foreignPage).toHaveLength(4);
    for (const answer of foreignPage) expect(answer).toContain('This call must come from the application page.');

    // The sandbox is app-wide: a window that asks for Node in its page still gets none.
    const nodeInPage = await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false } });
      try {
        await probe.loadURL('about:blank');
        return await probe.webContents.executeJavaScript('typeof require + "/" + typeof process') as string;
      } finally {
        probe.destroy();
      }
    });
    expect(nodeInPage).toBe('undefined/undefined');
  } finally {
    if (app) await app.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The dev command starts the app this way, and some Linux systems cannot run Chromium's sandbox at all.
// Forcing the app-wide sandbox together with this switch crashed Electron 39 a few seconds after start.
test('the app still starts and answers when launched with --no-sandbox', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-nosandbox-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    const page = await app.firstWindow();
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 60_000 });
    expect(Array.isArray(await page.evaluate(() => window.api.collectionList()))).toBe(true);
    // The crash came a few seconds in, after the window had already loaded.
    await page.waitForTimeout(5000);
    expect(Array.isArray(await page.evaluate(() => window.api.collectionList()))).toBe(true);
    expect(app.windows()).toHaveLength(1);
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
