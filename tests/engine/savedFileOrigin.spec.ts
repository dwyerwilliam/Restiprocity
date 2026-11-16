import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { defaultSaveName, runsWhenOpened } from '../../src/main/engine/responseClassifier';
import { ResponseDownloadCoordinator } from '../../src/main/engine/responseDownloadCoordinator';
import { markSavedFromNetwork } from '../../src/main/engine/savedFileOrigin';

test.describe('the name a save dialog starts with', () => {
  const cases: Array<[suggested: string, contentType: string | null, fallback: string, offered: string]> = [
    // A name that would run when opened gets a harmless extension for what the response is.
    ['report.pdf.exe', 'application/pdf', '.bin', 'report.pdf.exe.pdf'],
    ['setup.exe', 'application/octet-stream', '.bin', 'setup.exe.bin'],
    ['setup.MSI', null, '.bin', 'setup.MSI.bin'],
    ['run.bat', 'text/plain', '.txt', 'run.bat.txt'],
    ['install.command', 'text/plain; charset=utf-8', '.txt', 'install.command.txt'],
    ['app.js', 'application/javascript', '.txt', 'app.js.txt'],
    ['deploy.ps1', 'application/json', '.txt', 'deploy.ps1.json'],
    ['shortcut.lnk', 'application/octet-stream', '.bin', 'shortcut.lnk.bin'],
    ['image.iso', 'application/zip', '.bin', 'image.iso.zip'],
    ['.desktop', 'text/plain', '.txt', '.desktop.txt'],
    // Everything else is offered as the server named it.
    ['report.pdf', 'application/pdf', '.bin', 'report.pdf'],
    ['data.json', 'application/json', '.txt', 'data.json'],
    ['archive.tar.gz', 'application/gzip', '.bin', 'archive.tar.gz'],
    ['exe', 'application/octet-stream', '.bin', 'exe'],
    ['notes.exe.txt', 'text/plain', '.txt', 'notes.exe.txt'],
    ['response', null, '.bin', 'response'],
  ];
  for (const [suggested, contentType, fallback, offered] of cases) {
    test(`${suggested} (${contentType ?? 'no type'}) is offered as ${offered}`, () => {
      expect(defaultSaveName(suggested, contentType, fallback)).toBe(offered);
      expect(runsWhenOpened(offered)).toBe(false);
    });
  }

  test('a long name keeps the added extension when it is shortened', () => {
    const offered = defaultSaveName(`${'a'.repeat(176)}.exe`, 'text/plain', '.txt');
    expect(offered.endsWith('.txt')).toBe(true);
    expect(Buffer.byteLength(offered)).toBeLessThanOrEqual(180);
    expect(runsWhenOpened(offered)).toBe(false);
  });
});

test.describe('marking a saved file as downloaded', () => {
  let dir: string;
  test.beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-origin-')); });
  test.afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('Windows: the file gets an Internet-zone mark and keeps its content', async () => {
    test.skip(process.platform !== 'win32', 'Zone.Identifier streams exist only on Windows (NTFS).');
    const file = path.join(dir, 'saved.txt');
    await fs.writeFile(file, 'body');
    expect(await markSavedFromNetwork(file)).toBe(true);
    expect(await fs.readFile(`${file}:Zone.Identifier`, 'utf-8')).toBe('[ZoneTransfer]\r\nZoneId=3\r\n');
    expect(await fs.readFile(file, 'utf-8')).toBe('body');
    // Saving over the file again leaves one mark, not an error.
    await fs.writeFile(file, 'second body');
    expect(await markSavedFromNetwork(file)).toBe(true);
    expect(await fs.readFile(`${file}:Zone.Identifier`, 'utf-8')).toBe('[ZoneTransfer]\r\nZoneId=3\r\n');
  });

  test('macOS: the file gets the quarantine attribute and keeps its content', async () => {
    test.skip(process.platform !== 'darwin', 'The quarantine attribute exists only on macOS.');
    const file = path.join(dir, 'saved.txt');
    await fs.writeFile(file, 'body');
    expect(await markSavedFromNetwork(file)).toBe(true);
    expect(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file], { encoding: 'utf-8' })).toMatch(/^0081;[0-9a-f]+;Restiprocity;/);
    expect(await fs.readFile(file, 'utf-8')).toBe('body');
  });

  test('Linux: nothing is written, and the call says so', async () => {
    test.skip(process.platform !== 'linux', 'Linux has no enforced mark.');
    const file = path.join(dir, 'saved.txt');
    await fs.writeFile(file, 'body');
    expect(await markSavedFromNetwork(file)).toBe(false);
    expect(await fs.readdir(dir)).toEqual(['saved.txt']);
  });

  test('a path with no file is left alone on every system', async () => {
    const missing = path.join(dir, 'missing.txt');
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(await markSavedFromNetwork(missing, platform)).toBe(false);
    }
    expect(await markSavedFromNetwork(dir)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

test.describe('a download', () => {
  let dir: string;
  test.beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-origin-dl-')); });
  test.afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function download(suggestedFileName: string, markSaved: (filePath: string) => Promise<unknown>) {
    const destination = path.join(dir, 'chosen-by-user.exe');
    const offered: string[] = [];
    const coordinator = new ResponseDownloadCoordinator({
      showSaveDialog: async (_parent, options) => { offered.push(String(options.defaultPath)); return { canceled: false, filePath: destination }; },
      markSaved,
      logger: { error: () => {} },
    });
    const started = await coordinator.start({ parentWindow: undefined, suggestedFileName, mediaType: 'application/octet-stream' });
    if (started.kind !== 'ready') throw new Error(`Expected ready, received ${started.kind}`);
    await started.handle.write(Buffer.from([1, 2, 3, 4]));
    return { result: await started.handle.complete(), destination, offered };
  }

  test('is offered under a name that does not run, saved under the name the user chose, and marked once it is in place', async () => {
    const marked: Array<{ filePath: string; bytes: number[] }> = [];
    const { result, destination, offered } = await download('installer.exe', async (filePath) => {
      marked.push({ filePath, bytes: [...await fs.readFile(filePath)] });
    });
    expect(offered).toEqual(['installer.exe.bin']);
    expect(result).toEqual({ outcome: 'saved', fileName: 'chosen-by-user.exe', receivedBytes: 4 });
    expect(marked).toEqual([{ filePath: destination, bytes: [1, 2, 3, 4] }]);
    expect(await fs.readdir(dir)).toEqual(['chosen-by-user.exe']);
  });

  test('is still saved when it cannot be marked', async () => {
    const { result, destination } = await download('data.bin', async () => { throw new Error('no streams on this volume'); });
    expect(result).toMatchObject({ outcome: 'saved', receivedBytes: 4 });
    expect([...await fs.readFile(destination)]).toEqual([1, 2, 3, 4]);
  });
});
