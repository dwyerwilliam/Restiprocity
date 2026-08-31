import {
  RESPONSE_PREVIEW_MAX_BYTES,
  RESPONSE_TEXT_STAGING_MAX_BYTES,
} from '@shared/responseLimits';
import type { Header, HttpMethod, ResponseTextFormatV2 } from '@shared/types';

const BASENAME_MAX_BYTES = 180;
const TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MEDIA_TYPE_PATTERN = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/;
const SAFE_EXTENSION_PATTERN = /(\.[A-Za-z0-9]{1,16})$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PATH_SEPARATOR_CONFUSABLES = /[\u2044\u2215\u29f8\uff0f\uff3c]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const DIRECTIONAL_AND_INVISIBLE_FORMATTING = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g;

export interface SaveDialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface ParsedContentDisposition {
  readonly attachment: boolean;
  readonly filename?: string;
}

interface ClassificationBase {
  readonly mediaType: string | null;
  readonly declaredSize: number | undefined;
}

export interface EmptyResponseClassification extends ClassificationBase {
  readonly kind: 'empty';
  readonly mediaType: null;
}

export interface TextResponseClassification extends ClassificationBase {
  readonly kind: 'text';
  readonly mediaType: string;
  readonly format: ResponseTextFormatV2;
  readonly suggestedFileName: string;
  readonly filters: readonly SaveDialogFilter[];
}

export interface RasterResponseClassification extends ClassificationBase {
  readonly kind: 'raster';
  readonly mediaType: string;
  readonly suggestedFileName: string;
  readonly filters: readonly SaveDialogFilter[];
}

export interface DownloadResponseClassification extends ClassificationBase {
  readonly kind: 'download';
  readonly reason: 'attachment' | 'unsupported-media-type' | 'preview-limit';
  readonly suggestedFileName: string;
  readonly filters: readonly SaveDialogFilter[];
}

export type ResponseClassification =
  | EmptyResponseClassification
  | TextResponseClassification
  | RasterResponseClassification
  | DownloadResponseClassification;

export interface FinalResponseClassificationInput {
  readonly method: HttpMethod;
  readonly status: number;
  readonly headers: readonly Header[];
  readonly url: string;
  readonly now: Date | number;
}

export interface ResponseFilenameInput {
  readonly contentDisposition?: string;
  readonly responseUrl: string;
  readonly mediaType: string | null;
  readonly now: Date | number;
}

function getHeaderValue(headers: readonly Header[], name: string): string | undefined {
  const values = headers
    .filter((header) => header.enabled && header.key.toLowerCase() === name)
    .map((header) => header.value);
  return values.length === 0 ? undefined : values.join(', ');
}

export function parseMediaType(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;

  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  return MEDIA_TYPE_PATTERN.test(mediaType) ? mediaType : null;
}

function parseDeclaredSize(contentLength: string | undefined): number | undefined {
  if (contentLength === undefined || !/^\d+$/.test(contentLength.trim())) return undefined;

  const value = Number(contentLength.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

function splitDispositionParameters(value: string): string[] | null {
  const parameters: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ';' && !quoted) {
      parameters.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) return null;
  parameters.push(value.slice(start));
  return parameters;
}

function parseDispositionParameterValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) return undefined;

    let result = '';
    const inner = trimmed.slice(1, -1);
    for (let index = 0; index < inner.length; index += 1) {
      if (inner[index] === '\\') {
        const next = inner[index + 1];
        if (next === undefined) return undefined;
        if (next === '"' || next === '\\') {
          result += next;
          index += 1;
          continue;
        }
      }
      result += inner[index];
    }
    return result || undefined;
  }

  return TOKEN_PATTERN.test(trimmed) ? trimmed : undefined;
}

function decodeExtendedFilename(value: string): string | undefined {
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote < 0 ? -1 : value.indexOf("'", firstQuote + 1);
  if (firstQuote <= 0 || secondQuote < 0) return undefined;

  const charset = value.slice(0, firstQuote).toLowerCase();
  const language = value.slice(firstQuote + 1, secondQuote);
  if (charset !== 'utf-8' && charset !== 'iso-8859-1') return undefined;
  if (language !== '' && !/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) return undefined;

  const encoded = value.slice(secondQuote + 1);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '%') {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (!/^[!#$&+\-.^_`|~0-9A-Za-z]$/.test(character)) return undefined;
    bytes.push(character.charCodeAt(0));
  }

  try {
    const decoded = charset === 'utf-8'
      ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
      : String.fromCodePoint(...bytes);
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

export function parseContentDisposition(value: string | undefined): ParsedContentDisposition {
  if (value === undefined) return { attachment: false };

  const parts = splitDispositionParameters(value);
  const disposition = (parts?.[0] ?? value.split(';', 1)[0]).trim().toLowerCase();
  const attachment = TOKEN_PATTERN.test(disposition) && disposition === 'attachment';
  if (!parts) return { attachment };

  const parameters = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=');
    if (equals <= 0) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    if (!TOKEN_PATTERN.test(name)) continue;
    if (parameters.has(name)) duplicates.add(name);
    parameters.set(name, part.slice(equals + 1));
  }

  const extended = !duplicates.has('filename*') && parameters.has('filename*')
    ? decodeExtendedFilename(parameters.get('filename*')!.trim())
    : undefined;
  const legacy = !duplicates.has('filename') && parameters.has('filename')
    ? parseDispositionParameterValue(parameters.get('filename')!)
    : undefined;

  return { attachment, ...(extended ?? legacy ? { filename: extended ?? legacy } : {}) };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function isForbiddenBasename(value: string): boolean {
  return value === '' || value === '.' || value === '..' || WINDOWS_DEVICE_PATTERN.test(value);
}

export function sanitizeResponseBasename(value: string): string | undefined {
  const normalized = value.normalize('NFKC').replace(PATH_SEPARATOR_CONFUSABLES, '/');
  const basename = normalized.split(/[\\/]/).at(-1) ?? '';
  let sanitized = basename
    .replace(CONTROL_CHARACTERS, '')
    .replace(DIRECTIONAL_AND_INVISIBLE_FORMATTING, '')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(UNSAFE_FILENAME_CHARACTERS, '_')
    .trim()
    .replace(/[. ]+$/g, '');

  if (isForbiddenBasename(sanitized)) return undefined;
  if (utf8Bytes(sanitized) <= BASENAME_MAX_BYTES) return sanitized;

  const extension = sanitized.match(SAFE_EXTENSION_PATTERN)?.[1] ?? '';
  if (extension) {
    const stem = sanitized.slice(0, -extension.length);
    sanitized = `${truncateUtf8(stem, BASENAME_MAX_BYTES - utf8Bytes(extension)).replace(/[. ]+$/g, '')}${extension}`;
  } else {
    sanitized = truncateUtf8(sanitized, BASENAME_MAX_BYTES).replace(/[. ]+$/g, '');
  }

  return isForbiddenBasename(sanitized) ? undefined : sanitized;
}

function textFormat(mediaType: string): ResponseTextFormatV2 | undefined {
  if (mediaType === 'image/svg+xml') return 'svg';
  if (mediaType === 'text/html') return 'html';
  if (mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json') && mediaType !== 'application/+json')) {
    return 'json';
  }
  if (
    mediaType === 'application/xml'
    || mediaType === 'text/xml'
    || (mediaType.startsWith('application/') && mediaType.endsWith('+xml') && mediaType !== 'application/+xml')
  ) {
    return 'xml';
  }
  if (
    mediaType.startsWith('text/')
    || mediaType === 'application/javascript'
    || mediaType === 'application/x-www-form-urlencoded'
  ) {
    return 'text';
  }
  return undefined;
}

function isRasterMediaType(mediaType: string): boolean {
  return mediaType === 'image/png'
    || mediaType === 'image/jpeg'
    || mediaType === 'image/gif'
    || mediaType === 'image/webp';
}

export function safeExtensionForMediaType(contentType: string | null): string {
  const mediaType = parseMediaType(contentType ?? undefined);
  if (mediaType === 'image/png') return '.png';
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/gif') return '.gif';
  if (mediaType === 'image/webp') return '.webp';
  if (mediaType === 'image/svg+xml') return '.svg';
  if (mediaType === 'application/pdf') return '.pdf';
  if (mediaType === 'application/zip') return '.zip';

  const format = mediaType ? textFormat(mediaType) : undefined;
  if (format === 'json') return '.json';
  if (format === 'xml') return '.xml';
  if (format === 'html') return '.html';
  if (format === 'text') return '.txt';
  return '';
}

export function getSaveDialogFilters(contentType: string | null): readonly SaveDialogFilter[] {
  const mediaType = parseMediaType(contentType ?? undefined);
  if (mediaType === 'image/png') return [{ name: 'PNG', extensions: ['png'] }];
  if (mediaType === 'image/jpeg') return [{ name: 'JPEG', extensions: ['jpg', 'jpeg'] }];
  if (mediaType === 'image/gif') return [{ name: 'GIF', extensions: ['gif'] }];
  if (mediaType === 'image/webp') return [{ name: 'WebP', extensions: ['webp'] }];
  if (mediaType === 'application/pdf') return [{ name: 'PDF', extensions: ['pdf'] }];
  if (mediaType === 'application/zip') return [{ name: 'ZIP', extensions: ['zip'] }];

  const format = mediaType ? textFormat(mediaType) : undefined;
  if (format === 'json') return [{ name: 'JSON', extensions: ['json'] }];
  if (format === 'xml' || format === 'svg') return [{ name: 'XML / SVG', extensions: ['xml', 'svg'] }];
  if (format === 'html') return [{ name: 'HTML', extensions: ['html', 'htm'] }];
  if (format === 'text') return [{ name: 'Text', extensions: ['txt'] }];
  return [{ name: 'All Files', extensions: ['*'] }];
}

function urlBasename(responseUrl: string): string | undefined {
  try {
    const pathname = new URL(responseUrl).pathname;
    const encodedBasename = pathname.split('/').at(-1) ?? '';
    if (!encodedBasename) return undefined;
    try {
      return decodeURIComponent(encodedBasename);
    } catch {
      return encodedBasename;
    }
  } catch {
    return undefined;
  }
}

function generatedResponseBasename(now: Date | number, mediaType: string | null): string {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(date.getTime())) throw new RangeError('Response filename time must be valid');

  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `response-${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`
    + `-${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}`
    + `-${pad(date.getUTCMilliseconds(), 3)}${safeExtensionForMediaType(mediaType)}`;
}

export function selectResponseFilename(input: ResponseFilenameInput): string {
  const dispositionFilename = parseContentDisposition(input.contentDisposition).filename;
  const candidates = [dispositionFilename, urlBasename(input.responseUrl)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const sanitized = sanitizeResponseBasename(candidate);
    if (sanitized !== undefined) return sanitized;
  }
  return generatedResponseBasename(input.now, input.mediaType);
}

export function classifyFinalResponse(input: FinalResponseClassificationInput): ResponseClassification {
  if (input.method === 'HEAD' || (input.status >= 100 && input.status < 200) || [204, 205, 304].includes(input.status)) {
    return { kind: 'empty', mediaType: null, declaredSize: undefined };
  }

  const contentType = getHeaderValue(input.headers, 'content-type');
  const contentDisposition = getHeaderValue(input.headers, 'content-disposition');
  const mediaType = parseMediaType(contentType);
  const declaredSize = parseDeclaredSize(getHeaderValue(input.headers, 'content-length'));
  const disposition = parseContentDisposition(contentDisposition);
  const suggestedFileName = selectResponseFilename({
    contentDisposition,
    responseUrl: input.url,
    mediaType,
    now: input.now,
  });
  const filters = getSaveDialogFilters(mediaType);

  if (disposition.attachment || disposition.filename !== undefined) {
    return { kind: 'download', reason: 'attachment', mediaType, declaredSize, suggestedFileName, filters };
  }

  if (mediaType === null) {
    // Error responses commonly omit content-type; show their bodies inline
    // (status + message) instead of offering a file save.
    if (input.status >= 400 && (declaredSize === undefined || declaredSize <= RESPONSE_TEXT_STAGING_MAX_BYTES)) {
      return { kind: 'text', mediaType: 'text/plain', format: 'text', declaredSize, suggestedFileName, filters };
    }
    return { kind: 'download', reason: 'unsupported-media-type', mediaType, declaredSize, suggestedFileName, filters };
  }

  if (isRasterMediaType(mediaType)) {
    if (declaredSize !== undefined && declaredSize > RESPONSE_PREVIEW_MAX_BYTES) {
      return { kind: 'download', reason: 'preview-limit', mediaType, declaredSize, suggestedFileName, filters };
    }
    return { kind: 'raster', mediaType, declaredSize, suggestedFileName, filters };
  }

  const format = textFormat(mediaType);
  if (format !== undefined) {
    if (declaredSize !== undefined && declaredSize > RESPONSE_TEXT_STAGING_MAX_BYTES) {
      return { kind: 'download', reason: 'preview-limit', mediaType, declaredSize, suggestedFileName, filters };
    }
    return { kind: 'text', mediaType, format, declaredSize, suggestedFileName, filters };
  }

  return { kind: 'download', reason: 'unsupported-media-type', mediaType, declaredSize, suggestedFileName, filters };
}
