import React, { useMemo, useState } from 'react';
import type { ImageResponsePreviewV2 } from '@shared/types';
import { DownloadPreview } from './DownloadPreview';

const SAFE_RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function RasterPreview({ preview, download }: { preview: ImageResponsePreviewV2; download?: import('@shared/types').DownloadMetadataV2 }) {
  const [broken, setBroken] = useState(false);
  const source = useMemo(() => {
    if (!SAFE_RASTER_TYPES.has(preview.mediaType)) return null;
    const bytes = new Uint8Array(preview.bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return `data:${preview.mediaType};base64,${btoa(binary)}`;
  }, [preview.bytes, preview.mediaType]);

  if (!source) return <DownloadPreview preview={preview} download={download} />;
  return <figure className="response-image-preview rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3" data-testid="response-image-preview">
    <img src={source} alt={`Response preview (${preview.mediaType})`} className="max-h-[460px] max-w-full object-contain" onError={() => setBroken(true)} />
    <figcaption className="mt-2 text-xs text-[var(--color-text-muted)]">{preview.mediaType} · {preview.dimensions.width}×{preview.dimensions.height} · {preview.capturedBytes} bytes</figcaption>
    {broken && <div className="mt-2 text-xs text-[var(--color-warning)]">Image preview unavailable.</div>}
  </figure>;
}
