import React, { useCallback, useEffect, useState } from 'react';
import type { ResponseV2 } from '@shared/types';
import { DownloadPreview } from './DownloadPreview';
import { JsonTreePreview } from './JsonTreePreview';
import { RasterPreview } from './RasterPreview';
import { ResponsePreviewErrorBoundary } from './ResponsePreviewErrorBoundary';
import { SourcePreview } from './SourcePreview';

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function BodyPreview({ response }: { response: ResponseV2 }) {
  const { preview } = response;
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    setCopyFeedback(null);
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
  const canRenderJsonTree = preview.kind === 'text' && preview.format === 'json' && preview.parseState === 'valid' && !preview.truncated && preview.completeness === 'complete';
  const copyLabel = preview.kind === 'text' ? (preview.truncated ? 'Copy preview' : preview.completeness === 'complete' ? 'Copy body' : null) : null;

  return <section className="response-preview space-y-3" data-testid="response-preview">
    {preview.kind === 'text' && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
      <span>{preview.format.toUpperCase()} · {preview.charset}</span>
      <span>{formatBytes(preview.capturedBytes)} captured of {formatBytes(preview.totalBytes)}</span>
      {preview.decodeError && <span className="text-[var(--color-warning)]">Decode warning</span>}
       {copyLabel && <button type="button" onClick={() => void copyText()} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-hover)]">{copyLabel}</button>}
       {copyFeedback && <span role="status" className={copyFeedback === 'copied' ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}>{copyFeedback === 'copied' ? 'Copied' : 'Copy failed'}</span>}
    </div>}
    {preview.kind === 'text' && preview.truncated && <div className="rounded border border-[var(--color-warning)]/50 bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-warning)]" data-testid="response-truncated">Preview is truncated; only the captured prefix is shown.</div>}
    <ResponsePreviewErrorBoundary>
      {preview.kind === 'empty' && <div className="text-xs text-[var(--color-text-muted)]">Response has no body.</div>}
      {canRenderJsonTree && <JsonTreePreview text={preview.text} />}
      {preview.kind === 'text' && !canRenderJsonTree && <SourcePreview text={preview.text} />}
      {preview.kind === 'image' && <RasterPreview preview={preview} download={response.download} />}
      {(preview.kind === 'binary' || preview.kind === 'download-only') && <DownloadPreview preview={preview} download={response.download} />}
    </ResponsePreviewErrorBoundary>
  </section>;
}
