import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication } from 'playwright';
import { closeApp, expect, launchApp, test } from './fixtures/electronApp';

const repoRoot = path.resolve(__dirname, '..', '..');

/** What the operating system now records about where the file came from; null where nothing is recorded. */
async function downloadedMark(filePath: string): Promise<string | null> {
  if (process.platform === 'win32') return fs.readFile(`${filePath}:Zone.Identifier`, 'utf-8');
  if (process.platform === 'darwin') return execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', filePath], { encoding: 'utf-8' });
  return null;
}

function expectMarkedAsDownloaded(mark: string | null) {
  if (process.platform === 'win32') expect(mark).toContain('ZoneId=3');
  else if (process.platform === 'darwin') expect(mark).toContain('Restiprocity');
  else expect(mark).toBeNull();
}

/**
 * A server names the file a response is saved as. Both ways of saving one (Save As from the viewer, and a download)
 * must offer a name that does not run when opened, write the file where the user chose, and mark it as downloaded.
 * The save dialog is replaced; the request, classification, download and file writes are the real ones.
 */
test('a saved response is offered under a name that does not run and is marked as downloaded', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', 'attachment; filename="installer.exe"');
    response.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-saved-files-'));
  const saveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-saved-out-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ args: ['.'], cwd: repoRoot, env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.api?.saveResponseAs === 'function', undefined, { timeout: 60_000 });
    // The user accepts each dialog but saves under a name of their own, as they are free to.
    await app.evaluate(({ dialog }, prefix) => {
      const offered: string[] = [];
      (globalThis as any).__offeredNames = offered;
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        const options = args[args.length - 1] as { defaultPath?: string };
        offered.push(String(options.defaultPath));
        return { canceled: false, filePath: `${prefix}chosen-${offered.length}.dat` };
      }) as typeof dialog.showSaveDialog;
    }, saveDir + path.sep);

    // Save As from the response viewer: the body is text, the server suggested a script name.
    const savedAs = await page.evaluate(() => window.api.saveResponseAs({ content: 'echo from the server', contentType: 'text/plain', suggestedFileName: 'report.pdf.bat' }));
    expect(savedAs).toEqual({ saved: true, path: path.join(saveDir, 'chosen-1.dat') });
    expect(await fs.readFile(path.join(saveDir, 'chosen-1.dat'), 'utf-8')).toBe('echo from the server');
    expectMarkedAsDownloaded(await downloadedMark(path.join(saveDir, 'chosen-1.dat')));

    // A download: the server sent a program as an attachment.
    const now = Date.now();
    const request = {
      id: 'saved-files-download', name: 'Download', method: 'GET', url: `http://127.0.0.1:${port}/installer`, headers: [], parameters: [],
      body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {},
      createdAt: now, updatedAt: now,
    };
    const result = await page.evaluate(payload => window.api.sendRequest(payload as never), { operationId: 'saved-files-1', request });
    expect(result.kind, JSON.stringify(result).slice(0, 400)).toBe('download');
    expect([...await fs.readFile(path.join(saveDir, 'chosen-2.dat'))]).toEqual([1, 2, 3, 4]);
    expectMarkedAsDownloaded(await downloadedMark(path.join(saveDir, 'chosen-2.dat')));

    expect(await app.evaluate(() => (globalThis as any).__offeredNames)).toEqual(['report.pdf.bat.txt', 'installer.exe.bin']);
    expect((await fs.readdir(saveDir)).sort()).toEqual(['chosen-1.dat', 'chosen-2.dat']);
  } finally {
    if (app) await closeApp(app).catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rm(saveDir, { recursive: true, force: true });
  }
});
