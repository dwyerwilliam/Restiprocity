import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { BaseWindow, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import type { DownloadFailureV2 } from '@shared/types';
import {
  getSaveDialogFilters,
  sanitizeResponseBasename,
} from './responseClassifier';

const CLEANUP_ATTEMPTS = 2;

export type ResponseDownloadFailureCode =
  | 'disk-full'
  | 'permission-denied'
  | 'destination-conflict'
  | 'destination-unavailable'
  | 'invalid-filename'
  | 'io-error'
  | 'write-failed';

export const DOWNLOAD_FAILURE_MESSAGES: Readonly<Record<ResponseDownloadFailureCode, string>> = {
  'disk-full': 'There is not enough disk space to save the response.',
  'permission-denied': 'Permission was denied while saving the response.',
  'destination-conflict': 'The selected destination is already in use.',
  'destination-unavailable': 'The selected destination is unavailable.',
  'invalid-filename': 'The selected filename is invalid.',
  'io-error': 'A filesystem error occurred while saving the response.',
  'write-failed': 'The response could not be saved.',
};

export interface ResponseDownloadPhaseEvent {
  readonly phase: 'awaiting-destination' | 'downloading' | 'publishing';
  readonly receivedBytes: number;
  readonly declaredSize?: number;
}

export type ResponseDownloadResult =
  | {
      readonly outcome: 'saved' | 'cancelled';
      readonly fileName: string;
      readonly receivedBytes: number;
    }
  | {
      readonly outcome: 'failed';
      readonly fileName: string;
      readonly receivedBytes: number;
      readonly failure: DownloadFailureV2 & { readonly code: ResponseDownloadFailureCode };
      readonly recoveryAvailable: boolean;
    };

export interface ResponseDownloadFileHandle {
  write(data: Uint8Array): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ResponseDownloadFileSystemAdapter {
  openExclusive(filePath: string): Promise<ResponseDownloadFileHandle>;
  pathExists(filePath: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(filePath: string): Promise<void>;
}

export interface ResponseDownloadLogger {
  error(message: string, details?: unknown): void;
}

export interface ResponseDownloadActiveHandle {
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<ResponseDownloadResult>;
  cancel(): Promise<ResponseDownloadResult>;
  dispose(): Promise<void>;
}

export interface StartResponseDownloadInput {
  readonly parentWindow: BaseWindow | undefined;
  readonly suggestedFileName: string;
  readonly mediaType: string | null;
  readonly declaredSize?: number;
}

export type StartResponseDownloadResult =
  | { readonly kind: 'ready'; readonly handle: ResponseDownloadActiveHandle }
  | { readonly kind: 'cancelled' | 'failed'; readonly result: ResponseDownloadResult };

type ShowSaveDialogAdapter = (
  parentWindow: BaseWindow | undefined,
  options: SaveDialogOptions,
) => Promise<SaveDialogReturnValue>;

export interface ResponseDownloadCoordinatorDependencies {
  readonly showSaveDialog: ShowSaveDialogAdapter;
  readonly fileSystem?: ResponseDownloadFileSystemAdapter;
  readonly createUniqueToken?: () => string;
  readonly onPhase?: (event: ResponseDownloadPhaseEvent) => void;
  readonly logger?: ResponseDownloadLogger;
  readonly maximumNameAttempts?: number;
}

interface ActiveDownloadOptions {
  readonly targetPath: string;
  readonly partPath: string;
  readonly partHandle: ResponseDownloadFileHandle;
  readonly fileName: string;
  readonly declaredSize?: number;
  readonly fileSystem: ResponseDownloadFileSystemAdapter;
  readonly createUniqueToken: () => string;
  readonly maximumNameAttempts: number;
  readonly onPhase: (event: ResponseDownloadPhaseEvent) => void;
  readonly logger: ResponseDownloadLogger;
  readonly onSettled: (download: ActiveResponseDownload) => void;
}

const nodeFileSystem: ResponseDownloadFileSystemAdapter = {
  openExclusive: (filePath) => fs.open(filePath, 'wx'),
  async pathExists(filePath) {
    try {
      await fs.lstat(filePath);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') return false;
      throw error;
    }
  },
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  async rm(filePath) {
    await fs.rm(filePath, { force: true });
  },
};

const consoleLogger: ResponseDownloadLogger = {
  error: (message, details) => console.error(message, details),
};

export class ResponseDownloadFailureError extends Error {
  readonly name = 'ResponseDownloadFailureError';

  constructor(readonly failure: DownloadFailureV2 & { readonly code: ResponseDownloadFailureCode }) {
    super(failure.message);
  }
}

export function sanitizeDownloadFailure(error: unknown): DownloadFailureV2 & {
  readonly code: ResponseDownloadFailureCode;
} {
  const nativeCode = getErrorCode(error);
  let code: ResponseDownloadFailureCode;

  switch (nativeCode) {
    case 'ENOSPC':
      code = 'disk-full';
      break;
    case 'EACCES':
    case 'EPERM':
      code = 'permission-denied';
      break;
    case 'EEXIST':
      code = 'destination-conflict';
      break;
    case 'ENOENT':
      code = 'destination-unavailable';
      break;
    case 'ENAMETOOLONG':
      code = 'invalid-filename';
      break;
    case 'EIO':
      code = 'io-error';
      break;
    default:
      code = 'write-failed';
  }

  return { code, message: DOWNLOAD_FAILURE_MESSAGES[code] };
}

export class ResponseDownloadCoordinator {
  private readonly fileSystem: ResponseDownloadFileSystemAdapter;
  private readonly createUniqueToken: () => string;
  private readonly onPhase: (event: ResponseDownloadPhaseEvent) => void;
  private readonly logger: ResponseDownloadLogger;
  private readonly maximumNameAttempts: number;
  private readonly activeDownloads = new Set<ActiveResponseDownload>();
  private readonly pendingStarts = new Set<Promise<StartResponseDownloadResult>>();
  private readonly reservedDestinations = new Set<string>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: ResponseDownloadCoordinatorDependencies) {
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
    this.createUniqueToken = dependencies.createUniqueToken ?? randomUUID;
    this.onPhase = dependencies.onPhase ?? (() => {});
    this.logger = dependencies.logger ?? consoleLogger;
    this.maximumNameAttempts = Math.max(1, dependencies.maximumNameAttempts ?? 32);
  }

  start(input: StartResponseDownloadInput): Promise<StartResponseDownloadResult> {
    const pending = this.startDownload(input);
    this.pendingStarts.add(pending);
    void pending.then(
      () => this.pendingStarts.delete(pending),
      () => this.pendingStarts.delete(pending),
    );
    return pending;
  }

  private async startDownload(input: StartResponseDownloadInput): Promise<StartResponseDownloadResult> {
    const defaultFileName = sanitizeResponseBasename(input.suggestedFileName) ?? 'response';
    if (this.disposed) return cancelledStart(defaultFileName);

    this.emitPhase({
      phase: 'awaiting-destination',
      receivedBytes: 0,
      ...(input.declaredSize === undefined ? {} : { declaredSize: input.declaredSize }),
    });

    let dialogResult: SaveDialogReturnValue;
    try {
      dialogResult = await this.dependencies.showSaveDialog(input.parentWindow, {
        title: 'Save Response',
        buttonLabel: 'Save',
        defaultPath: defaultFileName,
        filters: getSaveDialogFilters(input.mediaType).map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })),
        properties: ['showOverwriteConfirmation'],
      });
    } catch (error) {
      this.logger.error('Response Save dialog failed.', { error });
      return failedStart(defaultFileName, error);
    }

    if (this.disposed || dialogResult.canceled) return cancelledStart(defaultFileName);
    if (!dialogResult.filePath) {
      const error = systemError('ENOENT', 'Save dialog returned no destination.');
      this.logger.error('Response Save dialog returned no destination.', { error });
      return failedStart(defaultFileName, error);
    }

    const targetPath = path.resolve(dialogResult.filePath);
    const fileName = path.basename(targetPath) || defaultFileName;
    const destinationKey = normalizeDestinationKey(targetPath);
    if (this.reservedDestinations.has(destinationKey)) {
      const error = systemError('EEXIST', 'Another response download is using this destination.');
      this.logger.error('Response download destination is already active.', {
        error,
        destinationPath: targetPath,
      });
      return failedStart(fileName, error);
    }
    this.reservedDestinations.add(destinationKey);

    let part: { path: string; handle: ResponseDownloadFileHandle };
    try {
      part = await this.createExclusivePart(targetPath);
    } catch (error) {
      this.reservedDestinations.delete(destinationKey);
      this.logger.error('Could not create response download partial file.', {
        error,
        destinationPath: targetPath,
      });
      return failedStart(fileName, error);
    }

    if (this.disposed) {
      await this.closeAndRemovePart(part.handle, part.path);
      this.reservedDestinations.delete(destinationKey);
      return cancelledStart(fileName);
    }

    const download = new ActiveResponseDownload({
      targetPath,
      partPath: part.path,
      partHandle: part.handle,
      fileName,
      declaredSize: input.declaredSize,
      fileSystem: this.fileSystem,
      createUniqueToken: this.createUniqueToken,
      maximumNameAttempts: this.maximumNameAttempts,
      onPhase: (event) => this.emitPhase(event),
      logger: this.logger,
      onSettled: (settled) => {
        this.activeDownloads.delete(settled);
        this.reservedDestinations.delete(destinationKey);
      },
    });
    this.activeDownloads.add(download);
    download.emitDownloadingPhase();
    return { kind: 'ready', handle: download };
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      while (this.pendingStarts.size > 0) {
        await Promise.allSettled([...this.pendingStarts]);
      }
      await Promise.allSettled([...this.activeDownloads].map((download) => download.dispose()));
    })();
    return this.disposePromise;
  }

  private async createExclusivePart(targetPath: string): Promise<{
    path: string;
    handle: ResponseDownloadFileHandle;
  }> {
    const directory = path.dirname(targetPath);
    const basename = path.basename(targetPath);
    let lastCollision: unknown;

    for (let attempt = 0; attempt < this.maximumNameAttempts; attempt += 1) {
      const partPath = path.join(directory, `.${basename}.${safeToken(this.createUniqueToken())}.part`);
      try {
        return { path: partPath, handle: await this.fileSystem.openExclusive(partPath) };
      } catch (error) {
        if (getErrorCode(error) !== 'EEXIST') throw error;
        lastCollision = error;
      }
    }

    throw lastCollision ?? systemError('EEXIST', 'Could not allocate a unique partial file.');
  }

  private async closeAndRemovePart(handle: ResponseDownloadFileHandle, partPath: string): Promise<void> {
    let closeError: unknown;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await handle.close();
        closeError = undefined;
        break;
      } catch (error) {
        closeError = error;
      }
    }
    if (closeError !== undefined) {
      this.logger.error('Could not close disposed response download partial file.', {
        error: closeError,
        partPath,
      });
      return;
    }
    try {
      await this.fileSystem.rm(partPath);
    } catch (error) {
      this.logger.error('Could not remove disposed response download partial file.', { error, partPath });
    }
  }

  private emitPhase(event: ResponseDownloadPhaseEvent): void {
    try {
      this.onPhase(event);
    } catch (error) {
      this.logger.error('Response download phase callback failed.', { error });
    }
  }
}

class ActiveResponseDownload implements ResponseDownloadActiveHandle {
  private partHandle: ResponseDownloadFileHandle | undefined;
  private ownsPart = true;
  private receivedBytes = 0;
  private writeTail: Promise<void> = Promise.resolve();
  private terminalResult: ResponseDownloadResult | undefined;
  private terminalFailure: ResponseDownloadFailureError | undefined;
  private finalization: Promise<ResponseDownloadResult> | undefined;
  private stopping = false;
  private released = false;

  constructor(private readonly options: ActiveDownloadOptions) {
    this.partHandle = options.partHandle;
  }

  emitDownloadingPhase(): void {
    this.emitPhase('downloading');
  }

  write(chunk: Uint8Array): Promise<void> {
    if (this.stopping || this.terminalResult) {
      return Promise.reject(this.terminalFailure ?? new ResponseDownloadFailureError({
        code: 'write-failed',
        message: DOWNLOAD_FAILURE_MESSAGES['write-failed'],
      }));
    }

    const ownedChunk = Buffer.from(chunk);
    const currentWrite = this.writeTail.then(() => this.writeChunk(ownedChunk));
    this.writeTail = currentWrite.catch(() => {});
    return currentWrite;
  }

  complete(): Promise<ResponseDownloadResult> {
    if (this.terminalResult) return Promise.resolve(this.terminalResult);
    if (this.finalization) return this.finalization;
    this.stopping = true;
    this.finalization = this.finishAndPublish();
    return this.finalization;
  }

  cancel(): Promise<ResponseDownloadResult> {
    if (this.terminalResult) return Promise.resolve(this.terminalResult);
    if (this.finalization) return this.finalization;
    this.stopping = true;
    this.finalization = this.cancelAndClean();
    return this.finalization;
  }

  async dispose(): Promise<void> {
    if (!this.terminalResult) await this.cancel();
    if (this.ownsPart) await this.cleanOwnedPart();
  }

  private async writeChunk(chunk: Uint8Array): Promise<void> {
    if (this.terminalResult) throw this.terminalFailure ?? new Error('Response download is already settled.');
    const handle = this.partHandle;
    if (!handle) throw new ResponseDownloadFailureError({
      code: 'write-failed',
      message: DOWNLOAD_FAILURE_MESSAGES['write-failed'],
    });

    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk.subarray(offset));
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
          throw systemError('EIO', 'Filesystem reported an invalid write length.');
        }
        offset += bytesWritten;
        this.receivedBytes += bytesWritten;
        this.emitPhase('downloading');
      }
    } catch (error) {
      await this.fail(error, 'Response download write failed.');
      throw this.terminalFailure;
    }
  }

  private async finishAndPublish(): Promise<ResponseDownloadResult> {
    await this.writeTail;
    if (this.terminalResult) return this.terminalResult;

    try {
      await this.partHandle?.sync();
      await this.closePart();
    } catch (error) {
      return this.fail(error, 'Could not flush and close response download partial file.');
    }

    this.emitPhase('publishing');
    return this.publish();
  }

  private async publish(): Promise<ResponseDownloadResult> {
    let backupPath: string | undefined;
    let backupMoved = false;

    try {
      if (await this.options.fileSystem.pathExists(this.options.targetPath)) {
        backupPath = await this.findAvailableBackupPath();
        await this.options.fileSystem.rename(this.options.targetPath, backupPath);
        backupMoved = true;
      }
    } catch (error) {
      return this.fail(error, 'Could not protect the existing response destination.');
    }

    try {
      await this.options.fileSystem.rename(this.options.partPath, this.options.targetPath);
      this.ownsPart = false;
    } catch (publicationError) {
      let recoveryAvailable = false;
      if (backupMoved && backupPath) {
        try {
          await this.options.fileSystem.rename(backupPath, this.options.targetPath);
          backupMoved = false;
        } catch (restorationError) {
          recoveryAvailable = true;
          this.options.logger.error('Response publication and backup restoration failed.', {
            publicationError,
            restorationError,
            destinationPath: this.options.targetPath,
            partPath: this.options.partPath,
            recoveryPath: backupPath,
          });
        }
      }

      if (!recoveryAvailable) {
        this.options.logger.error('Response publication failed.', {
          error: publicationError,
          destinationPath: this.options.targetPath,
          partPath: this.options.partPath,
          backupPath,
        });
      }
      return this.fail(publicationError, undefined, recoveryAvailable);
    }

    if (backupMoved && backupPath) {
      let removalError: unknown;
      for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
        try {
          await this.options.fileSystem.rm(backupPath);
          removalError = undefined;
          break;
        } catch (error) {
          removalError = error;
        }
      }
      if (removalError !== undefined) {
        this.options.logger.error('Published response but could not remove its backup.', {
          error: removalError,
          destinationPath: this.options.targetPath,
          backupPath,
        });
      }
    }

    return this.settle({
      outcome: 'saved',
      fileName: this.options.fileName,
      receivedBytes: this.receivedBytes,
    });
  }

  private async findAvailableBackupPath(): Promise<string> {
    const directory = path.dirname(this.options.targetPath);
    const basename = path.basename(this.options.targetPath);
    for (let attempt = 0; attempt < this.options.maximumNameAttempts; attempt += 1) {
      const candidate = path.join(
        directory,
        `.${basename}.${safeToken(this.options.createUniqueToken())}.backup`,
      );
      if (!await this.options.fileSystem.pathExists(candidate)) return candidate;
    }
    throw systemError('EEXIST', 'Could not allocate a unique response backup.');
  }

  private async cancelAndClean(): Promise<ResponseDownloadResult> {
    await this.writeTail;
    if (this.terminalResult) return this.terminalResult;
    await this.cleanOwnedPart();
    return this.settle({
      outcome: 'cancelled',
      fileName: this.options.fileName,
      receivedBytes: this.receivedBytes,
    });
  }

  private async fail(
    error: unknown,
    logMessage?: string,
    recoveryAvailable = false,
  ): Promise<ResponseDownloadResult> {
    if (this.terminalResult) return this.terminalResult;
    if (logMessage) {
      this.options.logger.error(logMessage, {
        error,
        destinationPath: this.options.targetPath,
        partPath: this.options.partPath,
      });
    }
    const failure = sanitizeDownloadFailure(error);
    this.terminalFailure = new ResponseDownloadFailureError(failure);
    await this.cleanOwnedPart();
    return this.settle({
      outcome: 'failed',
      fileName: this.options.fileName,
      receivedBytes: this.receivedBytes,
      failure,
      recoveryAvailable,
    });
  }

  private async cleanOwnedPart(): Promise<void> {
    if (!this.ownsPart) return;
    let closeError: unknown;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await this.closePart();
        closeError = undefined;
        break;
      } catch (error) {
        closeError = error;
      }
    }
    if (closeError !== undefined) {
      this.options.logger.error('Could not close response download partial file during cleanup.', {
        error: closeError,
        partPath: this.options.partPath,
      });
      return;
    }
    try {
      await this.options.fileSystem.rm(this.options.partPath);
      this.ownsPart = false;
      if (this.terminalResult) this.release();
    } catch (error) {
      this.options.logger.error('Could not remove response download partial file during cleanup.', {
        error,
        partPath: this.options.partPath,
      });
    }
  }

  private async closePart(): Promise<void> {
    if (!this.partHandle) return;
    await this.partHandle.close();
    this.partHandle = undefined;
  }

  private emitPhase(phase: ResponseDownloadPhaseEvent['phase']): void {
    if (this.terminalResult) return;
    this.options.onPhase({
      phase,
      receivedBytes: this.receivedBytes,
      ...(this.options.declaredSize === undefined ? {} : { declaredSize: this.options.declaredSize }),
    });
  }

  private settle(result: ResponseDownloadResult): ResponseDownloadResult {
    if (this.terminalResult) return this.terminalResult;
    this.terminalResult = result;
    if (!this.ownsPart) this.release();
    return result;
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.options.onSettled(this);
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function systemError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function safeToken(token: string): string {
  const sanitized = token.replace(/[^0-9A-Za-z_-]/g, '');
  return sanitized || randomUUID();
}

function normalizeDestinationKey(targetPath: string): string {
  return process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
}

function cancelledStart(fileName: string): StartResponseDownloadResult {
  return {
    kind: 'cancelled',
    result: { outcome: 'cancelled', fileName, receivedBytes: 0 },
  };
}

function failedStart(fileName: string, error: unknown): StartResponseDownloadResult {
  return {
    kind: 'failed',
    result: {
      outcome: 'failed',
      fileName,
      receivedBytes: 0,
      failure: sanitizeDownloadFailure(error),
      recoveryAvailable: false,
    },
  };
}
