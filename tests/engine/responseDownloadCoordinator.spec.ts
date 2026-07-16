import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, test as base } from '@playwright/test';
import {
  DOWNLOAD_FAILURE_MESSAGES,
  ResponseDownloadCoordinator,
  ResponseDownloadFailureError,
} from '../../src/main/engine/responseDownloadCoordinator';
import type {
  ResponseDownloadFileHandle,
  ResponseDownloadFileSystemAdapter,
  ResponseDownloadPhaseEvent,
  ResponseDownloadResult,
} from '../../src/main/engine/responseDownloadCoordinator';

type FileOperation = 'open' | 'write' | 'sync' | 'close' | 'exists' | 'rename' | 'rm';

interface FailurePoint {
  operation: FileOperation;
  call: number;
  code: string;
}

interface RecordedFileOperation {
  operation: FileOperation;
  paths: string[];
}

class FailureInjectedFileSystem implements ResponseDownloadFileSystemAdapter {
  readonly operations: RecordedFileOperation[] = [];
  private readonly calls = new Map<FileOperation, number>();
  private readonly nativeHandles = new Set<Awaited<ReturnType<typeof fs.open>>>();

  constructor(
    private readonly failures: readonly FailurePoint[] = [],
    private readonly maximumWriteBytes = Number.POSITIVE_INFINITY,
  ) {}

  async openExclusive(filePath: string): Promise<ResponseDownloadFileHandle> {
    this.record('open', filePath);
    this.failIfRequested('open', [filePath]);
    const handle = await fs.open(filePath, 'wx');
    this.nativeHandles.add(handle);

    return {
      write: async (data) => {
        this.record('write', filePath);
        this.failIfRequested('write', [filePath]);
        const length = Math.min(data.byteLength, this.maximumWriteBytes);
        return handle.write(data, 0, length, null);
      },
      sync: async () => {
        this.record('sync', filePath);
        this.failIfRequested('sync', [filePath]);
        await handle.sync();
      },
      close: async () => {
        this.record('close', filePath);
        this.failIfRequested('close', [filePath]);
        await handle.close();
        this.nativeHandles.delete(handle);
      },
    };
  }

  get openHandleCount(): number {
    return this.nativeHandles.size;
  }

  async closeOutstandingHandles(): Promise<void> {
    await Promise.allSettled([...this.nativeHandles].map(async (handle) => {
      await handle.close();
      this.nativeHandles.delete(handle);
    }));
  }

  async pathExists(filePath: string): Promise<boolean> {
    this.record('exists', filePath);
    this.failIfRequested('exists', [filePath]);
    try {
      await fs.lstat(filePath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.record('rename', oldPath, newPath);
    this.failIfRequested('rename', [oldPath, newPath]);
    await fs.rename(oldPath, newPath);
  }

  async rm(filePath: string): Promise<void> {
    this.record('rm', filePath);
    this.failIfRequested('rm', [filePath]);
    await fs.rm(filePath, { force: true });
  }

  private record(operation: FileOperation, ...paths: string[]): void {
    this.operations.push({ operation, paths });
  }

  private failIfRequested(operation: FileOperation, paths: string[]): void {
    const call = (this.calls.get(operation) ?? 0) + 1;
    this.calls.set(operation, call);
    const failure = this.failures.find((candidate) =>
      candidate.operation === operation && candidate.call === call
    );
    if (!failure) return;

    throw Object.assign(
      new Error(`Injected ${failure.code} at ${paths.join(' -> ')}`),
      { code: failure.code },
    );
  }
}

const test = base.extend<{ tempDirectory: string }>({
  tempDirectory: async ({}, use) => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-download-'));
    try {
      await use(tempDirectory);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  },
});

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function containsUnsafePathData(value: unknown): boolean {
  if (typeof value === 'string') {
    return path.isAbsolute(value) || value.includes('.part') || value.includes('.backup');
  }
  if (Array.isArray(value)) return value.some(containsUnsafePathData);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    /(?:file|destination|part|backup|recovery)path/i.test(key) || containsUnsafePathData(nested)
  );
}

function containsString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some((nested) => containsString(nested, expected));
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some((nested) => containsString(nested, expected));
}

const silentLogger = { error: () => {} };

function tokenSequence(...tokens: string[]): () => string {
  let index = 0;
  return () => tokens[index++] ?? `token-${index}`;
}

async function startReady(
  coordinator: ResponseDownloadCoordinator,
  parentWindow: object,
  suggestedFileName = 'response.bin',
) {
  const started = await coordinator.start({
    parentWindow: parentWindow as never,
    suggestedFileName,
    mediaType: 'application/octet-stream',
    declaredSize: 12,
  });
  expect(started.kind).toBe('ready');
  if (started.kind !== 'ready') throw new Error(`Expected ready, received ${started.kind}`);
  return started.handle;
}

test.describe('Response download coordinator', () => {
  test('publishes a completed overwrite with backup protection', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'report.bin');
    const original = Buffer.from('existing response');
    const payload = Buffer.from('new-response-body-with-partial-writes');
    await fs.writeFile(destination, original);

    const fileSystem = new FailureInjectedFileSystem([], 3);
    const phases: ResponseDownloadPhaseEvent[] = [];
    const dialogCalls: Array<{ parent: unknown; options: unknown }> = [];
    const parentWindow = { id: 'main-window' };
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part-id', 'backup-id'),
      showSaveDialog: async (parent, options) => {
        dialogCalls.push({ parent, options });
        return { canceled: false, filePath: destination };
      },
      onPhase: (event) => phases.push(event),
    });

    const handle = await startReady(coordinator, parentWindow, '../unsafe/report.bin');
    await handle.write(payload.subarray(0, 7));
    await handle.write(payload.subarray(7));
    const result = await handle.complete();

    expect(result).toEqual({
      outcome: 'saved',
      fileName: 'report.bin',
      receivedBytes: payload.byteLength,
    });
    expect(sha256(await fs.readFile(destination))).toBe(sha256(payload));
    expect(dialogCalls).toHaveLength(1);
    expect(dialogCalls[0]).toMatchObject({
      parent: parentWindow,
      options: {
        defaultPath: 'report.bin',
        filters: [{ name: 'All Files', extensions: ['*'] }],
        properties: ['showOverwriteConfirmation'],
      },
    });

    const publicationOperations = fileSystem.operations.filter(({ operation }) =>
      operation === 'rename' || operation === 'rm'
    );
    expect(publicationOperations.map(({ operation }) => operation)).toEqual(['rename', 'rename', 'rm']);
    expect(publicationOperations[0].paths).toEqual([
      destination,
      path.join(tempDirectory, '.report.bin.backup-id.backup'),
    ]);
    expect(publicationOperations[1].paths).toEqual([
      path.join(tempDirectory, '.report.bin.part-id.part'),
      destination,
    ]);
    expect(await fs.readdir(tempDirectory)).toEqual(['report.bin']);
    expect(phases.at(-1)).toEqual({
      phase: 'publishing',
      receivedBytes: payload.byteLength,
      declaredSize: 12,
    });
    expect(containsUnsafePathData(phases)).toBe(false);
    expect(containsUnsafePathData(result)).toBe(false);
  });

  test('returns cancellation before creating destination artifacts', async ({ tempDirectory }) => {
    const fileSystem = new FailureInjectedFileSystem();
    const phases: ResponseDownloadPhaseEvent[] = [];
    const parentWindow = { id: 'main-window' };
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      showSaveDialog: async (parent, options) => {
        expect(parent).toBe(parentWindow);
        expect(options.defaultPath).toBe('safe.json');
        expect(options.filters).toEqual([{ name: 'JSON', extensions: ['json'] }]);
        return { canceled: true, filePath: '' };
      },
      onPhase: (event) => phases.push(event),
    });

    const result = await coordinator.start({
      parentWindow: parentWindow as never,
      suggestedFileName: '../../safe.json',
      mediaType: 'application/json',
    });

    expect(result).toEqual({
      kind: 'cancelled',
      result: { outcome: 'cancelled', fileName: 'safe.json', receivedBytes: 0 },
    });
    expect(fileSystem.operations).toEqual([]);
    expect(await fs.readdir(tempDirectory)).toEqual([]);
    expect(phases).toEqual([
      { phase: 'awaiting-destination', receivedBytes: 0 },
    ]);
  });

  test('creates same-directory parts exclusively and preserves colliding files', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'response.bin');
    const collision = path.join(tempDirectory, '.response.bin.collision.part');
    await fs.writeFile(collision, 'not ours');
    const fileSystem = new FailureInjectedFileSystem();
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('collision', 'available'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    });

    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('payload'));
    expect(await handle.complete()).toMatchObject({ outcome: 'saved' });

    expect(await fs.readFile(collision, 'utf8')).toBe('not ours');
    expect(await fs.readFile(destination, 'utf8')).toBe('payload');
    expect(fileSystem.operations.filter(({ operation }) => operation === 'open')).toHaveLength(2);
  });

  test('rejects concurrent active downloads to the same destination', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'shared.bin');
    const fileSystem = new FailureInjectedFileSystem();
    const logs: unknown[] = [];
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('first-part', 'second-part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: { error: (...values) => logs.push(values) },
    });

    const first = await startReady(coordinator, {});
    const second = await coordinator.start({
      parentWindow: undefined,
      suggestedFileName: 'shared.bin',
      mediaType: null,
    });

    expect(second).toEqual({
      kind: 'failed',
      result: {
        outcome: 'failed',
        fileName: 'shared.bin',
        receivedBytes: 0,
        failure: {
          code: 'destination-conflict',
          message: DOWNLOAD_FAILURE_MESSAGES['destination-conflict'],
        },
        recoveryAvailable: false,
      },
    });
    expect(containsUnsafePathData(second)).toBe(false);
    expect(fileSystem.operations.filter(({ operation }) => operation === 'open')).toHaveLength(1);

    await first.write(Buffer.from('first payload'));
    expect(await first.complete()).toMatchObject({ outcome: 'saved' });
    expect(await fs.readFile(destination, 'utf8')).toBe('first payload');
    expect(containsString(logs, destination)).toBe(true);
  });

  test('maps fixed filesystem failures without exposing paths', async ({ tempDirectory }) => {
    const cases = [
      ['ENOSPC', 'disk-full'],
      ['EACCES', 'permission-denied'],
      ['EPERM', 'permission-denied'],
      ['EEXIST', 'destination-conflict'],
      ['ENOENT', 'destination-unavailable'],
      ['ENAMETOOLONG', 'invalid-filename'],
      ['EIO', 'io-error'],
      ['EBUSY', 'write-failed'],
    ] as const;

    for (const [nativeCode, publicCode] of cases) {
      const destination = path.join(tempDirectory, `${nativeCode}.bin`);
      const logs: unknown[] = [];
      const coordinator = new ResponseDownloadCoordinator({
        fileSystem: new FailureInjectedFileSystem([
          { operation: 'open', call: 1, code: nativeCode },
          { operation: 'open', call: 2, code: nativeCode },
          { operation: 'open', call: 3, code: nativeCode },
        ]),
        maximumNameAttempts: nativeCode === 'EEXIST' ? 3 : 1,
        createUniqueToken: tokenSequence('one', 'two', 'three'),
        showSaveDialog: async () => ({ canceled: false, filePath: destination }),
        logger: { error: (...values) => logs.push(values) },
      });

      const started = await coordinator.start({
        parentWindow: undefined,
        suggestedFileName: `${nativeCode}.bin`,
        mediaType: null,
      });

      expect(started).toEqual({
        kind: 'failed',
        result: {
          outcome: 'failed',
          fileName: `${nativeCode}.bin`,
          receivedBytes: 0,
          failure: { code: publicCode, message: DOWNLOAD_FAILURE_MESSAGES[publicCode] },
          recoveryAvailable: false,
        },
      });
      expect(containsUnsafePathData(started)).toBe(false);
      expect(containsString(logs, tempDirectory)).toBe(true);
    }
  });

  for (const operation of ['write', 'sync', 'close'] as const) {
    test(`cleans the part and sanitizes an injected ${operation} failure`, async ({ tempDirectory }) => {
      const destination = path.join(tempDirectory, `${operation}.bin`);
      const logs: unknown[] = [];
      const fileSystem = new FailureInjectedFileSystem([
        { operation, call: 1, code: operation === 'write' ? 'ENOSPC' : 'EIO' },
      ]);
      const coordinator = new ResponseDownloadCoordinator({
        fileSystem,
        createUniqueToken: tokenSequence(`${operation}-part`),
        showSaveDialog: async () => ({ canceled: false, filePath: destination }),
        logger: { error: (...values) => logs.push(values) },
      });
      const handle = await startReady(coordinator, {});

      let result: ResponseDownloadResult;
      if (operation === 'write') {
        const rejection = handle.write(Buffer.from('payload'));
        await expect(rejection).rejects.toBeInstanceOf(ResponseDownloadFailureError);
        await expect(rejection).rejects.toMatchObject({
          failure: { code: 'disk-full', message: DOWNLOAD_FAILURE_MESSAGES['disk-full'] },
        });
        result = await handle.complete();
      } else {
        await handle.write(Buffer.from('payload'));
        result = await handle.complete();
      }

      expect(result).toMatchObject({
        outcome: 'failed',
        failure: {
          code: operation === 'write' ? 'disk-full' : 'io-error',
        },
      });
      expect(containsUnsafePathData(result)).toBe(false);
      expect(await fs.readdir(tempDirectory)).toEqual([]);
      expect(containsString(logs, tempDirectory)).toBe(true);
    });
  }

  test('leaves the original intact when moving it to backup fails', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'target.bin');
    await fs.writeFile(destination, 'original');
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem: new FailureInjectedFileSystem([{ operation: 'rename', call: 1, code: 'EPERM' }]),
      createUniqueToken: tokenSequence('part', 'backup'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: silentLogger,
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('replacement'));

    expect(await handle.complete()).toMatchObject({
      outcome: 'failed',
      failure: { code: 'permission-denied' },
      recoveryAvailable: false,
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect(await fs.readdir(tempDirectory)).toEqual(['target.bin']);
  });

  test('restores the original when publishing the part fails', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'target.bin');
    await fs.writeFile(destination, 'original');
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem: new FailureInjectedFileSystem([{ operation: 'rename', call: 2, code: 'EIO' }]),
      createUniqueToken: tokenSequence('part', 'backup'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: silentLogger,
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('replacement'));

    expect(await handle.complete()).toMatchObject({
      outcome: 'failed',
      failure: { code: 'io-error' },
      recoveryAvailable: false,
    });
    expect(await fs.readFile(destination, 'utf8')).toBe('original');
    expect(await fs.readdir(tempDirectory)).toEqual(['target.bin']);
  });

  test('removes the part when first publication rename fails', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'new-target.bin');
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem: new FailureInjectedFileSystem([{ operation: 'rename', call: 1, code: 'EIO' }]),
      createUniqueToken: tokenSequence('part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: silentLogger,
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('unpublished'));

    expect(await handle.complete()).toMatchObject({
      outcome: 'failed',
      failure: { code: 'io-error' },
      recoveryAvailable: false,
    });
    expect(await fs.readdir(tempDirectory)).toEqual([]);
  });

  test('preserves backup when publication and restoration fail', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'target.bin');
    await fs.writeFile(destination, 'original');
    const logs: unknown[] = [];
    const fileSystem = new FailureInjectedFileSystem([
      { operation: 'rename', call: 2, code: 'EIO' },
      { operation: 'rename', call: 3, code: 'EPERM' },
    ]);
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part', 'recovery'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: { error: (...values) => logs.push(values) },
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('replacement'));
    const result = await handle.complete();

    expect(result).toEqual({
      outcome: 'failed',
      fileName: 'target.bin',
      receivedBytes: Buffer.byteLength('replacement'),
      failure: { code: 'io-error', message: DOWNLOAD_FAILURE_MESSAGES['io-error'] },
      recoveryAvailable: true,
    });
    expect(containsUnsafePathData(result)).toBe(false);
    expect(await fs.readdir(tempDirectory)).toEqual(['.target.bin.recovery.backup']);
    expect(await fs.readFile(path.join(tempDirectory, '.target.bin.recovery.backup'), 'utf8')).toBe('original');
    expect(containsString(logs, path.join(tempDirectory, '.target.bin.recovery.backup'))).toBe(true);
    expect(containsString(logs, destination)).toBe(true);
  });

  test('preserves colliding backup names and removes the owned backup', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'target.bin');
    const collision = path.join(tempDirectory, '.target.bin.collision.backup');
    await fs.writeFile(destination, 'original');
    await fs.writeFile(collision, 'unrelated backup');
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem: new FailureInjectedFileSystem(),
      createUniqueToken: tokenSequence('part', 'collision', 'owned'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('replacement'));

    expect(await handle.complete()).toMatchObject({ outcome: 'saved' });
    expect(await fs.readFile(destination, 'utf8')).toBe('replacement');
    expect(await fs.readFile(collision, 'utf8')).toBe('unrelated backup');
    expect(await fs.readdir(tempDirectory)).toEqual(['.target.bin.collision.backup', 'target.bin']);
  });

  test('retries transient backup removal after successful publication', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'target.bin');
    await fs.writeFile(destination, 'original');
    const fileSystem = new FailureInjectedFileSystem([{ operation: 'rm', call: 1, code: 'EIO' }]);
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part', 'backup'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: silentLogger,
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('replacement'));

    expect(await handle.complete()).toMatchObject({ outcome: 'saved' });
    expect(await fs.readFile(destination, 'utf8')).toBe('replacement');
    expect(await fs.readdir(tempDirectory)).toEqual(['target.bin']);
    expect(fileSystem.operations.filter(({ operation }) => operation === 'rm')).toHaveLength(2);
  });

  test('cleans an unpublished part after active cancellation', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'cancelled.bin');
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem: new FailureInjectedFileSystem(),
      createUniqueToken: tokenSequence('part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('partial'));

    expect(await handle.cancel()).toEqual({
      outcome: 'cancelled',
      fileName: 'cancelled.bin',
      receivedBytes: Buffer.byteLength('partial'),
    });
    expect(await handle.cancel()).toMatchObject({ outcome: 'cancelled' });
    expect(await fs.readdir(tempDirectory)).toEqual([]);
  });

  test('disposes active handles idempotently and removes safe parts', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'disposed.bin');
    const fileSystem = new FailureInjectedFileSystem();
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('partial'));

    await coordinator.dispose();
    await coordinator.dispose();
    await handle.dispose();

    expect(await fs.readdir(tempDirectory)).toEqual([]);
    expect(fileSystem.operations.filter(({ operation }) => operation === 'close')).toHaveLength(1);
    expect(await handle.complete()).toMatchObject({ outcome: 'cancelled' });
    const afterDispose = await coordinator.start({
      parentWindow: undefined,
      suggestedFileName: 'later.bin',
      mediaType: null,
    });
    expect(afterDispose).toMatchObject({ kind: 'cancelled', result: { outcome: 'cancelled' } });
  });

  test('retries a transient close failure during disposal before removing the part', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'close-race.bin');
    const fileSystem = new FailureInjectedFileSystem([{ operation: 'close', call: 1, code: 'EIO' }]);
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
      logger: silentLogger,
    });
    const handle = await startReady(coordinator, {});
    await handle.write(Buffer.from('partial'));

    try {
      await coordinator.dispose();
      expect(fileSystem.openHandleCount).toBe(0);
      expect(fileSystem.operations.filter(({ operation }) => operation === 'close')).toHaveLength(2);
      expect(await fs.readdir(tempDirectory)).toEqual([]);
    } finally {
      await fileSystem.closeOutstandingHandles();
    }
  });

  test('waits for pending exclusive creation and cleans it during disposal', async ({ tempDirectory }) => {
    const destination = path.join(tempDirectory, 'pending.bin');
    const delegate = new FailureInjectedFileSystem();
    let releaseOpen!: () => void;
    let signalOpenStarted!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const openStarted = new Promise<void>((resolve) => { signalOpenStarted = resolve; });
    const fileSystem: ResponseDownloadFileSystemAdapter = {
      async openExclusive(filePath) {
        signalOpenStarted();
        await openGate;
        return delegate.openExclusive(filePath);
      },
      pathExists: (filePath) => delegate.pathExists(filePath),
      rename: (oldPath, newPath) => delegate.rename(oldPath, newPath),
      rm: (filePath) => delegate.rm(filePath),
    };
    const coordinator = new ResponseDownloadCoordinator({
      fileSystem,
      createUniqueToken: tokenSequence('part'),
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    });

    const startPromise = coordinator.start({
      parentWindow: undefined,
      suggestedFileName: 'pending.bin',
      mediaType: null,
    });
    await openStarted;
    let disposalSettled = false;
    const disposal = coordinator.dispose().then(() => { disposalSettled = true; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    releaseOpen();
    expect(await startPromise).toMatchObject({ kind: 'cancelled' });
    await disposal;
    expect(await fs.readdir(tempDirectory)).toEqual([]);
  });
});
