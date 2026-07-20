import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, test as base } from '@playwright/test';
import { installShutdownHandler } from '../../src/main/ipc/handlers';
import { ResponseDownloadCoordinator } from '../../src/main/engine/responseDownloadCoordinator';

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class FakeApplication extends EventEmitter {
  readonly exitCodes: number[] = [];

  exit(code: number): void {
    this.exitCodes.push(code);
  }
}

const test = base.extend<{ tempDirectory: string }>({
  tempDirectory: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-shutdown-'));
    try {
      await use(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

test.describe('main process shutdown lifecycle', () => {
  test('awaits active download cleanup before exiting', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'response.bin');
    const recoveryBackup = path.join(tempDirectory, '.response.bin.sole-recovery.backup');
    await fs.writeFile(recoveryBackup, 'recoverable original');

    const coordinator = new ResponseDownloadCoordinator({
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      createUniqueToken: () => 'active-part',
      logger: { error: () => {} },
    });
    const started = await coordinator.start({
      suggestedFileName: 'response.bin',
      mediaType: 'application/octet-stream',
    });
    expect(started.kind).toBe('ready');
    if (started.kind !== 'ready') throw new Error('Expected an active download');
    await started.handle.write(Buffer.from('partial payload'));

    const activePart = path.join(tempDirectory, '.response.bin.active-part.part');
    expect(await fs.readFile(activePart, 'utf8')).toBe('partial payload');

    const cleanupGate = gate();
    const application = new FakeApplication();
    let cleanupCalls = 0;
    installShutdownHandler(application as never, async () => {
      cleanupCalls += 1;
      await cleanupGate.promise;
      await coordinator.dispose();
    });

    let preventDefaultCalls = 0;
    application.emit('before-quit', {
      preventDefault: () => { preventDefaultCalls += 1; },
    });
    application.emit('before-quit', {
      preventDefault: () => { preventDefaultCalls += 1; },
    });

    expect(cleanupCalls).toBe(1);
    expect(preventDefaultCalls).toBe(2);
    expect(application.exitCodes).toEqual([]);
    expect(await fs.readFile(recoveryBackup, 'utf8')).toBe('recoverable original');

    cleanupGate.release();
    await waitFor(() => application.exitCodes.length === 1);

    expect(application.exitCodes).toEqual([0]);
    await expect(fs.stat(activePart)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(recoveryBackup, 'utf8')).toBe('recoverable original');
  });
});
