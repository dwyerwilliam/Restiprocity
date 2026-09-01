import { BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ResponseFileActionPayload,
  ResponseOpenExternalResult,
  ResponseSaveAsResult,
} from '@shared/types';
import {
  getSaveDialogFilters,
  safeExtensionForMediaType,
  sanitizeResponseBasename,
} from '../engine/responseClassifier';

function normalizePayload(payload: ResponseFileActionPayload): {
  content: string;
  contentType: string | null;
  suggestedFileName?: string;
} {
  const candidate = (payload ?? {}) as Partial<ResponseFileActionPayload>;
  return {
    content: typeof candidate.content === 'string' ? candidate.content : '',
    contentType: typeof candidate.contentType === 'string' && candidate.contentType.trim() ? candidate.contentType : null,
    ...(typeof candidate.suggestedFileName === 'string' && candidate.suggestedFileName.trim()
      ? { suggestedFileName: candidate.suggestedFileName }
      : {}),
  };
}

function buildSaveAsBaseName(contentType: string | null, suggestedFileName?: string): string {
  const extension = safeExtensionForMediaType(contentType);
  const sanitized = sanitizeResponseBasename(suggestedFileName ?? '');
  if (!sanitized) return `response${extension || '.txt'}`;
  return path.extname(sanitized) ? sanitized : `${sanitized}${extension}`;
}

export async function saveResponseAs(
  sender: Electron.WebContents,
  payload: ResponseFileActionPayload,
): Promise<ResponseSaveAsResult> {
  const { content, contentType, suggestedFileName } = normalizePayload(payload);
  const defaultPath = buildSaveAsBaseName(contentType, suggestedFileName);

  const options = {
    title: 'Save Response Body',
    buttonLabel: 'Save',
    defaultPath,
    filters: getSaveDialogFilters(contentType).map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions],
    })),
    properties: ['showOverwriteConfirmation' as const],
  };

  try {
    const parentWindow = BrowserWindow.fromWebContents(sender) ?? undefined;
    const result = parentWindow
      ? await dialog.showSaveDialog(parentWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { saved: false, reason: 'cancelled' };
    }
    await fs.writeFile(path.resolve(result.filePath), content, 'utf-8');
    return { saved: true, path: result.filePath };
  } catch (error) {
    return {
      saved: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function locateNotepadPlusPlus(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Notepad++', 'notepad++.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Notepad++', 'notepad++.exe') : null,
    process.env.LocalAppData ? path.join(process.env.LocalAppData, 'Programs', 'Notepad++', 'notepad++.exe') : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function openResponseExternally(
  payload: ResponseFileActionPayload,
): Promise<ResponseOpenExternalResult> {
  const { content, contentType, suggestedFileName } = normalizePayload(payload);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-response-'));
  const tempPath = path.join(tempDir, buildSaveAsBaseName(contentType || 'text/plain', suggestedFileName));
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    const notepadPlusPlus = locateNotepadPlusPlus();
    if (notepadPlusPlus) {
      const child = spawn(notepadPlusPlus, [tempPath], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => {
        console.error('Could not launch Notepad++ for response body.', { error, tempPath });
      });
      child.unref();
      return { opened: true, editor: 'notepad++' };
    }
    const errorMessage = await shell.openPath(tempPath);
    if (errorMessage) {
      return { opened: false, message: errorMessage };
    }
    return { opened: true, editor: 'default' };
  } catch (error) {
    return {
      opened: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
