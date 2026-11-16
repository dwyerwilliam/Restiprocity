import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';
import { startHttpFixture } from './fixtures/nativeServers';

test('the window is sandboxed, runs only its own script, and cannot navigate, open windows or reach the network', async () => {
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
  } finally {
    if (app) await app.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
