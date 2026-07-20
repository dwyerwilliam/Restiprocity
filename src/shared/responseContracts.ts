import { RESPONSE_IMAGE_MAX_PIXELS, RESPONSE_PREVIEW_MAX_BYTES } from './responseLimits';
import type {
  DownloadMetadataV2,
  DownloadReasonV2,
  DownloadStateV2,
  Header,
  PersistedResponsePreviewV2,
  PersistedResponseV2,
  ResponseCompletenessV2,
  ResponseCookie,
  ResponseTextFormatV2,
  ResponseTextParseStateV2,
  ResponseTiming,
  ResponseV2,
  ValidatedImageDimensionsV2,
} from './types';

export interface LegacyResponseV1 {
  version?: 1;
  id?: unknown;
  requestId?: unknown;
  status?: unknown;
  statusText?: unknown;
  headers?: unknown;
  body?: unknown;
  timings?: unknown;
  timestamp?: unknown;
  size?: unknown;
  declaredSize?: unknown;
  cookies?: unknown;
  [key: string]: unknown;
}

type UnknownRecord = Record<string, unknown>;

const RESPONSE_TEXT_FORMATS = new Set<ResponseTextFormatV2>(['json', 'xml', 'html', 'svg', 'text']);
const RESPONSE_PARSE_STATES = new Set<ResponseTextParseStateV2>([
  'not-applicable',
  'unparsed',
  'valid',
  'invalid',
  'over-budget',
]);
const RESPONSE_COMPLETENESS_STATES = new Set<ResponseCompletenessV2>(['complete', 'truncated', 'unknown']);
const DOWNLOAD_REASONS = new Set<DownloadReasonV2>([
  'attachment',
  'binary',
  'unsupported-media-type',
  'preview-limit',
  'invalid-image',
]);
const DOWNLOAD_STATES = new Set<DownloadStateV2>([
  'awaiting-destination',
  'downloading',
  'publishing',
  'saved',
  'cancelled',
  'failed',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedUtf8Prefix(value: string): {
  text: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
} {
  let capturedBytes = 0;
  let totalBytes = 0;
  let prefixEnd = 0;
  let prefixOpen = true;

  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0xfffd;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const byteCount = utf8CodePointBytes(codePoint);
    totalBytes += byteCount;

    if (prefixOpen && capturedBytes + byteCount <= RESPONSE_PREVIEW_MAX_BYTES) {
      capturedBytes += byteCount;
      prefixEnd = index + codeUnits;
    } else {
      prefixOpen = false;
    }

    index += codeUnits;
  }

  return {
    text: value.slice(0, prefixEnd),
    capturedBytes,
    totalBytes,
    truncated: capturedBytes < totalBytes,
  };
}

function sanitizeHeaders(value: unknown): Header[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): Header[] => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      return [];
    }
    return [{ key: entry.key, value: entry.value, enabled: entry.enabled !== false }];
  });
}

function sanitizeTimings(value: unknown): ResponseTiming {
  const source = isRecord(value) ? value : {};
  return {
    dns: nonNegativeNumber(source.dns),
    tcp: nonNegativeNumber(source.tcp),
    tls: nonNegativeNumber(source.tls),
    ttfb: nonNegativeNumber(source.ttfb),
    download: nonNegativeNumber(source.download),
    total: nonNegativeNumber(source.total),
  };
}

function sanitizeCookies(value: unknown): ResponseCookie[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): ResponseCookie[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      return [];
    }

    const sameSite = entry.sameSite === 'strict' || entry.sameSite === 'none' ? entry.sameSite : 'lax';
    const expires = nonNegativeNumber(entry.expires);
    return [{
      name: entry.name,
      value: entry.value,
      domain: stringValue(entry.domain),
      path: stringValue(entry.path),
      ...(expires > 0 ? { expires } : {}),
      httpOnly: entry.httpOnly === true,
      secure: entry.secure === true,
      sameSite,
    }];
  });
}

function responseTextFormat(headers: Header[]): ResponseTextFormatV2 {
  const contentType = headers.find((header) => header.enabled && header.key.toLowerCase() === 'content-type')
    ?.value.toLowerCase() ?? '';

  if (contentType.includes('json')) return 'json';
  if (contentType.includes('svg')) return 'svg';
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('xml')) return 'xml';
  return 'text';
}

function legacyParseState(format: ResponseTextFormatV2, text: string, truncated: boolean): ResponseTextParseStateV2 {
  if (format !== 'json') return 'not-applicable';
  if (truncated) return 'unparsed';

  try {
    JSON.parse(text);
    return 'valid';
  } catch {
    return 'invalid';
  }
}

function safeSuggestedFileName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || /[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    return undefined;
  }
  return value;
}

function sanitizeDownloadMetadata(
  value: unknown,
  fallbackReason: DownloadReasonV2 = 'binary',
  fallbackMediaType: string | null = null,
): DownloadMetadataV2 {
  const source = isRecord(value) ? value : {};
  const state = typeof source.state === 'string' && DOWNLOAD_STATES.has(source.state as DownloadStateV2)
    ? source.state as DownloadStateV2
    : 'failed';
  const reason = typeof source.reason === 'string' && DOWNLOAD_REASONS.has(source.reason as DownloadReasonV2)
    ? source.reason as DownloadReasonV2
    : fallbackReason;
  const mediaType = typeof source.mediaType === 'string' ? source.mediaType : fallbackMediaType;
  const suggestedFileName = safeSuggestedFileName(source.suggestedFileName);
  const declaredSize = nonNegativeInteger(source.declaredSize);
  const failureSource = isRecord(source.failure) ? source.failure : undefined;
  const failure = failureSource && typeof failureSource.message === 'string'
    ? {
        code: typeof failureSource.code === 'string' ? failureSource.code : null,
        message: failureSource.message,
      }
    : undefined;

  return {
    state,
    reason,
    mediaType,
    ...(suggestedFileName ? { suggestedFileName } : {}),
    receivedBytes: nonNegativeInteger(source.receivedBytes) ?? 0,
    ...(declaredSize !== undefined ? { declaredSize } : {}),
    ...(failure ? { failure } : {}),
  };
}

function validImageDimensions(value: unknown): ValidatedImageDimensionsV2 | undefined {
  if (!isRecord(value) || value.validated !== true) return undefined;

  const width = nonNegativeInteger(value.width);
  const height = nonNegativeInteger(value.height);
  const pixels = nonNegativeInteger(value.pixels);
  if (!width || !height || pixels !== width * height || pixels > RESPONSE_IMAGE_MAX_PIXELS) {
    return undefined;
  }

  return { width, height, pixels, validated: true };
}

function normalizeVersionedPreview(value: unknown, responseDownload: unknown): PersistedResponsePreviewV2 {
  if (!isRecord(value)) {
    return { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'unknown' };
  }

  if (value.kind === 'empty') {
    const completeness = typeof value.completeness === 'string'
      && RESPONSE_COMPLETENESS_STATES.has(value.completeness as ResponseCompletenessV2)
      ? value.completeness as ResponseCompletenessV2
      : 'unknown';
    return { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness };
  }

  if (value.kind === 'text') {
    const text = stringValue(value.text);
    const sourceCapturedBytes = nonNegativeInteger(value.capturedBytes);
    const bounded = sourceCapturedBytes === undefined ? boundedUtf8Prefix(text) : undefined;
    const capturedBytes = sourceCapturedBytes === undefined
      ? bounded!.capturedBytes
      : Math.min(sourceCapturedBytes, RESPONSE_PREVIEW_MAX_BYTES);
    const sourceTotalBytes = nonNegativeInteger(value.totalBytes)
      ?? (bounded ? Math.max(capturedBytes, bounded.totalBytes) : capturedBytes);
    const totalBytes = Math.max(sourceTotalBytes, capturedBytes);
    const truncated = value.truncated === true || bounded?.truncated === true || totalBytes > capturedBytes;
    const sourceCompleteness = typeof value.completeness === 'string'
      && RESPONSE_COMPLETENESS_STATES.has(value.completeness as ResponseCompletenessV2)
      ? value.completeness as ResponseCompletenessV2
      : 'unknown';
    const format = typeof value.format === 'string' && RESPONSE_TEXT_FORMATS.has(value.format as ResponseTextFormatV2)
      ? value.format as ResponseTextFormatV2
      : 'text';
    const parseState = typeof value.parseState === 'string'
      && RESPONSE_PARSE_STATES.has(value.parseState as ResponseTextParseStateV2)
      ? value.parseState as ResponseTextParseStateV2
      : 'unparsed';

    return {
      kind: 'text',
      format,
      text: bounded?.text ?? text,
      parseState,
      charset: stringValue(value.charset, 'utf-8'),
      decodeError: value.decodeError === true,
      capturedBytes,
      totalBytes,
      truncated,
      completeness: truncated ? 'truncated' : sourceCompleteness,
    };
  }

  const mediaType = typeof value.mediaType === 'string' ? value.mediaType : null;
  const capturedBytes = nonNegativeInteger(value.capturedBytes) ?? 0;
  const totalBytes = Math.max(nonNegativeInteger(value.totalBytes) ?? capturedBytes, capturedBytes);
  const truncated = value.truncated === true || totalBytes > capturedBytes;

  if (value.kind === 'image') {
    const dimensions = validImageDimensions(value.dimensions);
    if (dimensions && mediaType) {
      return { kind: 'image', mediaType, dimensions, capturedBytes, totalBytes, truncated };
    }

    const download = sanitizeDownloadMetadata(responseDownload, 'invalid-image', mediaType);
    return { kind: 'download-only', mediaType, capturedBytes: 0, totalBytes, truncated: totalBytes > 0, download };
  }

  if (value.kind === 'binary' || value.kind === 'download-only') {
    const download = sanitizeDownloadMetadata(value.download ?? responseDownload, 'binary', mediaType);
    return { kind: value.kind, mediaType, capturedBytes, totalBytes, truncated, download };
  }

  return { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'unknown' };
}

function basePersistedResponse(source: UnknownRecord, preview: PersistedResponsePreviewV2): PersistedResponseV2 {
  const declaredSize = nonNegativeInteger(source.declaredSize);
  const download = isRecord(source.download) ? sanitizeDownloadMetadata(source.download) : undefined;

  return {
    version: 2,
    id: stringValue(source.id),
    requestId: stringValue(source.requestId),
    status: nonNegativeInteger(source.status) ?? 0,
    statusText: stringValue(source.statusText),
    headers: sanitizeHeaders(source.headers),
    preview,
    timings: sanitizeTimings(source.timings),
    timestamp: nonNegativeInteger(source.timestamp) ?? 0,
    size: nonNegativeInteger(source.size) ?? preview.totalBytes,
    ...(declaredSize !== undefined ? { declaredSize } : {}),
    cookies: sanitizeCookies(source.cookies),
    ...(download ? { download } : {}),
  };
}

function normalizeVersionedResponse(source: UnknownRecord): PersistedResponseV2 {
  return basePersistedResponse(source, normalizeVersionedPreview(source.preview, source.download));
}

function normalizeLegacyResponseRecord(source: UnknownRecord): PersistedResponseV2 {
  const headers = sanitizeHeaders(source.headers);
  const body = typeof source.body === 'string' ? source.body : '';
  const bounded = boundedUtf8Prefix(body);
  const preview: PersistedResponsePreviewV2 = body.length === 0
    ? { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'unknown' }
    : {
        kind: 'text',
        format: responseTextFormat(headers),
        text: bounded.text,
        parseState: legacyParseState(responseTextFormat(headers), bounded.text, bounded.truncated),
        charset: 'utf-8',
        decodeError: false,
        capturedBytes: bounded.capturedBytes,
        totalBytes: bounded.totalBytes,
        truncated: bounded.truncated,
        completeness: bounded.truncated ? 'truncated' : 'unknown',
      };

  return basePersistedResponse({ ...source, headers, size: nonNegativeInteger(source.size) ?? bounded.totalBytes }, preview);
}

export function normalizeLegacyResponse(input: unknown): PersistedResponseV2 {
  const source = isRecord(input) ? input : {};
  return source.version === 2
    ? normalizeVersionedResponse(source)
    : normalizeLegacyResponseRecord(source);
}

export const normalizeResponseSnapshotV2 = normalizeLegacyResponse;

export function toPersistedResponseV2(response: ResponseV2): PersistedResponseV2 {
  return normalizeVersionedResponse({ ...response });
}

export function toRendererResponseV2(input: unknown): ResponseV2 {
  const snapshot = normalizeResponseSnapshotV2(input);
  if (snapshot.preview.kind !== 'image') return snapshot as ResponseV2;

  const download = snapshot.download ?? {
    state: 'failed' as const,
    reason: 'invalid-image' as const,
    mediaType: snapshot.preview.mediaType,
    receivedBytes: snapshot.preview.totalBytes,
  };
  return {
    ...snapshot,
    preview: {
      kind: 'download-only',
      mediaType: snapshot.preview.mediaType,
      capturedBytes: snapshot.preview.capturedBytes,
      totalBytes: snapshot.preview.totalBytes,
      truncated: snapshot.preview.truncated,
      download,
    },
    download,
  };
}
