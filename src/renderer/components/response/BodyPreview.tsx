import React, { useCallback, useEffect, useState } from 'react';
import type { ResponseTextParseStateV2, ResponseV2 } from '@shared/types';
import { RESPONSE_JSON_MAX_DEPTH, RESPONSE_JSON_MAX_NODES, RESPONSE_PREVIEW_MAX_BYTES } from '@shared/responseLimits';
import { DownloadPreview } from './DownloadPreview';
import { JsonTreePreview } from './JsonTreePreview';
import { RasterPreview } from './RasterPreview';
import { ResponsePreviewErrorBoundary } from './ResponsePreviewErrorBoundary';
import { SourcePreview } from './SourcePreview';

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

const PREVIEW_LIMIT_MB = Math.round(RESPONSE_PREVIEW_MAX_BYTES / (1024 * 1024));

type JsonTreeFallbackReason = 'size-limit' | 'invalid' | 'over-budget';

const JSON_TREE_FALLBACK_LABELS: Record<JsonTreeFallbackReason, string> = {
  'size-limit': `Response exceeds the ${PREVIEW_LIMIT_MB} MB preview limit, so the JSON tree view isn't shown. Showing raw text instead.`,
  invalid: "Response isn't valid JSON, so the JSON tree view isn't shown. Showing raw text instead.",
  'over-budget': `JSON exceeds the ${RESPONSE_JSON_MAX_NODES.toLocaleString()}-node or ${RESPONSE_JSON_MAX_DEPTH}-level nesting preview budget, so the JSON tree view isn't shown. Showing raw text instead.`,
};

function jsonTreeFallbackReason(
  truncated: boolean,
  completeness: 'complete' | 'truncated' | 'unknown',
  parseState: ResponseTextParseStateV2,
): JsonTreeFallbackReason | undefined {
  if (truncated || completeness !== 'complete') return 'size-limit';
  if (parseState === 'invalid') return 'invalid';
  if (parseState === 'over-budget') return 'over-budget';
  return undefined;
}

export function BodyPreview({ response }: { response: ResponseV2 }) {
  const { preview } = response;
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'cancelled' | 'failed' | null>(null);
  const [openState, setOpenState] = useState<'opened' | 'failed' | null>(null);
  useEffect(() => {
    setCopyFeedback(null);
    setSaveState(null);
    setOpenState(null);
  }, [preview.kind, preview.kind === 'text' ? preview.text : preview.kind]);
  const copyText = useCallback(async () => {
    if (preview.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(preview.text);
      setCopyFeedback('copied');
    } catch {
      setCopyFeedback('failed');
    }
  }, [preview]);
  const textIsEmpty = preview.kind === 'text' && preview.text === '';
  const noBody = preview.kind === 'empty' || textIsEmpty;
  const statusLabel = response.statusText.trim()
    ? `${response.status} ${response.statusText.trim()}`
    : `${response.status}`;
  const canRenderJsonTree = preview.kind === 'text' && preview.format === 'json' && preview.parseState === 'valid' && !preview.truncated && preview.completeness === 'complete';
  const jsonFallbackReason = preview.kind === 'text' && !textIsEmpty && preview.format === 'json' && !canRenderJsonTree
    ? jsonTreeFallbackReason(preview.truncated, preview.completeness, preview.parseState)
    : undefined;
  const copyLabel = preview.kind === 'text' && !textIsEmpty ? (preview.truncated ? 'Copy preview' : preview.completeness === 'complete' ? 'Copy body' : null) : null;
  const isWindows = navigator.userAgent.includes('Windows');
  const saveLabel = preview.kind === 'text' && !textIsEmpty ? (preview.truncated ? 'Save preview' : 'Save As') : null;
  const saveBodyAs = useCallback(async () => {
    if (preview.kind !== 'text') return;
    const contentType = response.headers.find((header) => header.key.toLowerCase() === 'content-type')?.value ?? null;
    try {
      const result = await window.api.saveResponseAs({
        content: preview.text,
        contentType,
        ...(response.download?.suggestedFileName ? { suggestedFileName: response.download.suggestedFileName } : {}),
      });
      setSaveState(result.saved ? 'saved' : result.reason === 'cancelled' ? 'cancelled' : 'failed');
    } catch {
      setSaveState('failed');
    }
  }, [preview, response]);
  const openBodyExternally = useCallback(async () => {
    if (preview.kind !== 'text') return;
    const contentType = response.headers.find((header) => header.key.toLowerCase() === 'content-type')?.value ?? null;
    try {
      const result = await window.api.openResponseExternally({
        content: preview.text,
        contentType,
        ...(response.download?.suggestedFileName ? { suggestedFileName: response.download.suggestedFileName } : {}),
      });
      setOpenState(result.opened ? 'opened' : 'failed');
    } catch {
      setOpenState('failed');
    }
  }, [preview, response]);

  return <section className="response-preview space-y-3" data-testid="response-preview">
    {preview.kind === 'text' && !textIsEmpty && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
      <span>{preview.format.toUpperCase()} · {preview.charset}</span>
      <span>{formatBytes(preview.capturedBytes)} captured of {formatBytes(preview.totalBytes)}</span>
      {preview.decodeError && <span className="text-[var(--color-warning)]">Decode warning</span>}
       {copyLabel && <button type="button" onClick={() => void copyText()} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-hover)]">{copyLabel}</button>}
       {saveLabel && <button type="button" onClick={() => void saveBodyAs()} data-testid="response-save-as" className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-hover)]">{saveLabel}</button>}
       {isWindows && <button type="button" onClick={() => void openBodyExternally()} data-testid="response-open-notepad-plus-plus" className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-hover)]">Open in Notepad++</button>}
       {copyFeedback && <span role="status" className={copyFeedback === 'copied' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>{copyFeedback === 'copied' ? 'Copied' : 'Copy failed'}</span>}
       {saveState && <span role="status" data-testid="response-save-as-status" className={saveState === 'saved' ? 'text-[var(--color-success)]' : saveState === 'cancelled' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-error)]'}>{saveState === 'saved' ? 'Saved' : saveState === 'cancelled' ? 'Save cancelled' : 'Save failed'}</span>}
       {openState && <span role="status" data-testid="response-open-external-status" className={openState === 'opened' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>{openState === 'opened' ? 'Opened' : 'Open failed'}</span>}
    </div>}
    {preview.kind === 'text' && preview.truncated && preview.format !== 'json' && <div className="rounded border border-[var(--color-warning)]/50 bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-warning)]" data-testid="response-truncated">Preview is truncated; only the captured prefix is shown.</div>}
    {jsonFallbackReason && <div className="rounded border border-[var(--color-warning)]/50 bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-warning)]" data-testid="response-json-tree-fallback-reason">{JSON_TREE_FALLBACK_LABELS[jsonFallbackReason]}</div>}
    <ResponsePreviewErrorBoundary>
      {noBody && <div className="text-xs text-[var(--color-text-muted)]" data-testid="response-empty-body">{statusLabel} — Response has no body.</div>}
      {canRenderJsonTree && <JsonTreePreview text={preview.text} />}
      {preview.kind === 'text' && !canRenderJsonTree && !textIsEmpty && <SourcePreview text={preview.text} />}
      {preview.kind === 'image' && <RasterPreview preview={preview} download={response.download} />}
      {(preview.kind === 'binary' || preview.kind === 'download-only') && <DownloadPreview preview={preview} download={response.download} />}
    </ResponsePreviewErrorBoundary>
  </section>;
}
