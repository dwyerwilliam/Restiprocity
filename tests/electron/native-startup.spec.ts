import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';

test('native Electron startup exposes the preload IPC bridge with isolated user data', async () => {
  const tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-electron-smoke-'));
  let electronApp: ElectronApplication | undefined;
  try {
    electronApp = await _electron.launch({
      args: ['.'],
      // Repo root: the app's package.json (main -> dist-electron/main/index.js)
      // lives here. `args: ['.']` is resolved by Electron against this cwd.
      cwd: path.resolve(__dirname, '..', '..'),
      env: {
        ...process.env,
        RESTIPROCITY_TEST_USER_DATA: tempUserData,
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForFunction(
      () =>
        typeof (window as unknown as { api?: unknown }).api === 'object' &&
        typeof (window as unknown as { api?: { collectionList?: unknown } }).api?.collectionList === 'function' &&
        typeof (window as unknown as { api?: { historyList?: unknown } }).api?.historyList === 'function',
      undefined,
      { timeout: 60_000 },
    );

    // Exercise the real IPC round-trip: renderer → preload bridge → main handlers.
    const collections = await window.evaluate(() =>
      (window as unknown as { api: { collectionList(): Promise<unknown> } }).api.collectionList(),
    );
    const history = await window.evaluate(() =>
      (window as unknown as { api: { historyList(): Promise<unknown> } }).api.historyList(),
    );
    const settings = await window.evaluate(() =>
      (window as unknown as { api: { settingsGet(): Promise<unknown> } }).api.settingsGet(),
    );

    expect(Array.isArray(collections)).toBe(true);
    expect(Array.isArray(history)).toBe(true);
    expect(settings).not.toBeNull();
    expect(typeof settings).toBe('object');

    // Prove the isolated userData dir was actually used: HistoryStore creates
    // history.db under it during init. If this fails, the env override didn't take.
    const db = await fs.stat(path.join(tempUserData, 'history.db'));
    expect(db.size).toBeGreaterThan(0);
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => {});
    }
    await fs.rm(tempUserData, { recursive: true, force: true });
  }
});
