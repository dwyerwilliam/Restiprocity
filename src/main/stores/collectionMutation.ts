import fs from 'fs/promises';
import { randomUUID } from 'crypto';

export type CollectionFileOperations = Pick<typeof fs, 'readFile' | 'writeFile' | 'rename' | 'unlink'>;

export class CollectionMoveError extends Error {
  readonly name: string = 'CollectionMoveError';
  constructor(message: string, options?: ErrorOptions) {
    super(`COLLECTION_MOVE_REJECTED: ${message}`, options);
  }
}

export class CollectionRollbackIncompleteError extends Error {
  readonly name = 'CollectionRollbackIncompleteError';
  constructor(readonly recoveryManifest: string, options: ErrorOptions) {
    super('COLLECTION_ROLLBACK_INCOMPLETE: Move recovery was incomplete. Stop rearranging collections and recover the retained collection backup files.', options);
  }
}

export class CollectionMoveCleanupError extends Error {
  readonly name = 'CollectionMoveCleanupError';
  constructor(options: ErrorOptions) {
    super('COLLECTION_MOVE_CLEANUP_FAILED: Collection files have settled, but temporary file cleanup failed. Refresh the collection and check filesystem access.', options);
  }
}

export class CollectionMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function readOriginal(filePath: string, files: CollectionFileOperations): Promise<Buffer | null> {
  try {
    return await files.readFile(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function parseMembership(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string' && id.length > 0)
    || new Set(value).size !== value.length) {
    throw new CollectionMoveError('Collection membership must be an array of unique IDs. Repair the collection links before retrying.');
  }
  return [...value];
}

type FileChange = { readonly path: string; readonly data: string };

export async function replaceCollectionFiles(changes: readonly FileChange[], files: CollectionFileOperations): Promise<void> {
  const token = randomUUID();
  const originals = await Promise.all(changes.map(async (change) => ({
    ...change,
    original: await readOriginal(change.path, files),
    backup: `${change.path}.${token}.original`,
    staged: `${change.path}.${token}.next`,
    restore: `${change.path}.${token}.restore`,
  })));
  const manifest = `${originals[0].path}.${token}.recovery.json`;
  const owned = new Set<string>();
  const stage = async (filePath: string, data: string | Buffer) => {
    owned.add(filePath);
    try {
      await files.writeFile(filePath, data, { flag: 'wx' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') owned.delete(filePath);
      throw error;
    }
  };
  const attempted: typeof originals = [];
  let failure: unknown;
  try {
    await stage(manifest, JSON.stringify(originals.map((item) => ({ path: item.path, existed: item.original !== null, backup: item.backup }))));
    for (const item of originals) {
      if (item.original !== null) await stage(item.backup, item.original);
      await stage(item.staged, item.data);
    }
    for (const item of originals) {
      attempted.push(item);
      await files.rename(item.staged, item.path);
    }
  } catch (error) {
    failure = error;
    const recoveryFailures: unknown[] = [];
    for (const item of attempted.reverse()) {
      try {
        if (item.original === null) {
          await removeIfPresent(item.path, files);
        } else {
          await stage(item.restore, item.original);
          await files.rename(item.restore, item.path);
        }
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
    }
    if (recoveryFailures.length > 0) {
      throw new CollectionRollbackIncompleteError(manifest, { cause: new AggregateError([error, ...recoveryFailures]) });
    }
  }
  const cleanup = await Promise.allSettled([...owned].filter((filePath) => filePath !== manifest).map((filePath) => removeIfPresent(filePath, files)));
  const cleanupFailures = cleanup.filter((result) => result.status === 'rejected');
  if (cleanupFailures.length > 0) {
    throw new CollectionMoveCleanupError({ cause: new AggregateError(cleanupFailures) });
  }
  if (owned.has(manifest)) {
    try {
      await removeIfPresent(manifest, files);
    } catch (error) {
      throw new CollectionMoveCleanupError({ cause: error });
    }
  }
  if (failure !== undefined) throw new CollectionMoveError('Move failed; original collection files were restored. Retry after checking filesystem access.', { cause: failure });
}

async function removeIfPresent(filePath: string, files: CollectionFileOperations): Promise<void> {
  try {
    await files.unlink(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}
