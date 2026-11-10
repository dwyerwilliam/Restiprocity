import { BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import yaml from 'js-yaml';
import type { CollectionExportFileResult, CollectionImportFileResult, Id } from '@shared/types';
import type { CollectionStore } from '../stores/collectionStore';
import { CollectionImportError } from '../stores/collectionExport';
import { CollectionMoveCleanupError, CollectionRollbackIncompleteError } from '../stores/collectionMutation';
import { sanitizeResponseBasename } from '../engine/responseClassifier';

const EXPORT_FILTERS = [
  { name: 'Restiprocity collection', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
];
const IMPORT_FILTERS = [
  { name: 'Restiprocity, OpenAPI, Insomnia or Postman export', extensions: ['json', 'yaml', 'yml'] },
  { name: 'All files', extensions: ['*'] },
];
// Collections are small JSON documents; refuse anything that clearly isn't one before parsing it.
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export async function exportCollectionToFile(
  sender: Electron.WebContents,
  collectionStore: Pick<CollectionStore, 'exportBundle'>,
  id?: Id,
): Promise<CollectionExportFileResult> {
  try {
    const bundle = await collectionStore.exportBundle(typeof id === 'string' && id ? id : undefined);
    const root = bundle.roots.length === 1
      ? [...bundle.groups, ...bundle.requests].find((item) => item.id === bundle.roots[0])
      : undefined;
    const baseName = sanitizeResponseBasename(root?.name ?? '') || 'collection';
    const options = {
      title: 'Export Collection',
      buttonLabel: 'Export',
      defaultPath: `${baseName}.restiprocity.json`,
      filters: EXPORT_FILTERS,
      properties: ['showOverwriteConfirmation' as const],
    };
    const parentWindow = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = parentWindow ? await dialog.showSaveDialog(parentWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false, reason: 'cancelled' };

    await fs.writeFile(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    return { saved: true, path: result.filePath, requests: bundle.requests.length, groups: bundle.groups.length };
  } catch (error) {
    return { saved: false, reason: 'failed', message: errorMessage(error) };
  }
}

export async function importCollectionFromFile(
  sender: Electron.WebContents,
  collectionStore: Pick<CollectionStore, 'importBundle'>,
): Promise<CollectionImportFileResult> {
  try {
    const options = {
      title: 'Import Collection',
      buttonLabel: 'Import',
      filters: IMPORT_FILTERS,
      properties: ['openFile' as const],
    };
    const parentWindow = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    const [filePath] = result.filePaths;
    if (result.canceled || !filePath) return { imported: false, reason: 'cancelled' };

    const { size } = await fs.stat(filePath);
    if (size > IMPORT_MAX_BYTES) {
      return { imported: false, reason: 'failed', message: 'This file is too large to be a collection export.' };
    }
    const data = parseCollectionFile(await fs.readFile(filePath, 'utf-8'));
    if (data === undefined) {
      return { imported: false, reason: 'failed', message: 'This file is not valid JSON or YAML.' };
    }
    const summary = await collectionStore.importBundle(data);
    return { imported: true, ...summary };
  } catch (error) {
    return { imported: false, reason: 'failed', message: importFailureMessage(error) };
  }
}

/** JSON first (Restiprocity, OpenAPI and Insomnia v4); otherwise YAML (OpenAPI/Insomnia v5). Undefined when neither parses to a document. */
export function parseCollectionFile(contents: string): unknown {
  const text = contents.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON; try YAML below.
  }
  try {
    // CORE_SCHEMA keeps dates and other YAML-only scalars as strings.
    const data = yaml.load(text, { schema: yaml.CORE_SCHEMA });
    return data !== null && typeof data === 'object' ? data : undefined;
  } catch {
    return undefined;
  }
}

function importFailureMessage(error: unknown): string {
  if (error instanceof CollectionImportError) return error.message;
  if (error instanceof CollectionRollbackIncompleteError) {
    return 'Import failed and could not be fully undone. Check the collections folder for leftover backup files before retrying.';
  }
  if (error instanceof CollectionMoveCleanupError) {
    return 'Import finished writing, but temporary files could not be removed. Refresh the collection to check what was imported.';
  }
  // replaceCollectionFiles restored every original file before rethrowing.
  return `Import failed and the collection was left unchanged: ${errorMessage(error)}`;
}
