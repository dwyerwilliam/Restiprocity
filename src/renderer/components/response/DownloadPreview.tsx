import React from 'react';
import type { DownloadMetadataV2, ResponsePreviewV2 } from '@shared/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DownloadPreview({ preview, download }: { preview: Extract<ResponsePreviewV2, { kind: 'binary' | 'download-only' }> | Extract<ResponsePreviewV2, { kind: 'image' }>; download?: DownloadMetadataV2 }) {
  const metadata = download ?? ('download' in preview ? preview.download : undefined);
  const state = metadata?.state ?? 'failed';
  return <section className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs" data-testid="download-progress">
    <div className="font-semibold text-[var(--color-text)]">{preview.kind === 'image' ? 'Image preview unavailable' : 'Download response'}</div>
    <dl className="mt-3 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[var(--color-text-muted)]">
      <dt>Media type</dt><dd className="break-all text-[var(--color-text)]">{preview.mediaType ?? 'Unknown'}</dd>
      <dt>Captured</dt><dd>{formatBytes(preview.capturedBytes)} of {formatBytes(preview.totalBytes)}</dd>
      <dt>Download state</dt><dd>{state}</dd>
      {metadata?.suggestedFileName && <><dt>Suggested name</dt><dd className="break-all">{metadata.suggestedFileName}</dd></>}
      {metadata?.failure && <><dt>Failure</dt><dd className="text-[var(--color-error)]">{metadata.failure.message}</dd></>}
    </dl>
  </section>;
}
