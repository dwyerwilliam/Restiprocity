import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * A download's save dialog must be parented to the window that sent the request. The main process used to
 * copy its window reference before the window existed, so the dialog opened unparented behind the app.
 * The dialog itself is replaced; the request, classification and download coordinator are the real ones.
 */
test('the save dialog for a download is parented to the sending window', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', 'attachment; filename="report.bin"');
    response.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-download-dialog-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ['.'], cwd: repoRoot, env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.api?.sendRequest === 'function', undefined, { timeout: 60_000 });
    await app.evaluate(({ dialog, BrowserWindow }) => {
      const calls: Array<{ argumentCount: number; firstIsWindow: boolean }> = [];
      (globalThis as any).__saveDialogCalls = calls;
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        calls.push({ argumentCount: args.length, firstIsWindow: args[0] instanceof BrowserWindow });
        return { canceled: true, filePath: '' };
      }) as typeof dialog.showSaveDialog;
    });

    const now = Date.now();
    const request = {
      id: 'download-dialog-request', name: 'Download', method: 'GET', url: `http://127.0.0.1:${port}/report`, headers: [], parameters: [],
      body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {},
      createdAt: now, updatedAt: now,
    };
    const result = await page.evaluate(payload => window.api.sendRequest(payload), { operationId: 'download-dialog-1', request });
    const outcome = JSON.stringify(result, (_key, value) => (value instanceof Object && 'bytes' in value ? '[bytes]' : value)).slice(0, 600);

    // The send must reach the download path before the dialog can be asked at all.
    expect(result.kind, outcome).toBe('download');
    expect(await app.evaluate(() => (globalThis as any).__saveDialogCalls), outcome).toEqual([{ argumentCount: 2, firstIsWindow: true }]);
  } finally {
    if (app) await app.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(userData, { recursive: true, force: true });
  }
});
