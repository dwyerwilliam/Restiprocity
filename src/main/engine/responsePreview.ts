import {
  RESPONSE_IMAGE_MAX_PIXELS,
  RESPONSE_JSON_MAX_DEPTH,
  RESPONSE_JSON_MAX_NODES,
  RESPONSE_PREVIEW_MAX_BYTES,
} from '@shared/responseLimits';
import type {
  ImageResponsePreviewV2,
  ResponseTextFormatV2,
  ResponseTextParseStateV2,
  TextResponsePreviewV2,
  ValidatedImageDimensionsV2,
} from '@shared/types';

export type SupportedPreviewCharset =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'windows-1252'
  | 'iso-8859-1'
  | 'us-ascii';

export interface BytePrefixCapture {
  bytes: Uint8Array;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface TextPreviewOptions {
  chunks: Iterable<Uint8Array>;
  format: ResponseTextFormatV2;
  complete: boolean;
  declaredCharset?: string;
  totalBytes?: number;
}

export interface JsonBudgetValidation {
  parseState: Extract<ResponseTextParseStateV2, 'unparsed' | 'valid' | 'invalid' | 'over-budget'>;
  treeEligible: boolean;
  nodeCount: number;
  maxDepth: number;
  tree?: unknown;
}

export interface TextPreviewValidation {
  preview: TextResponsePreviewV2;
  presentation: 'json-tree' | 'escaped-source' | 'source';
  tree?: unknown;
}

export type RasterMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface RasterPreviewOptions {
  chunks: Iterable<Uint8Array>;
  mediaType: RasterMediaType;
  complete: boolean;
  totalBytes?: number;
}

export type RasterPreviewValidation =
  | { eligible: true; preview: ImageResponsePreviewV2 }
  | {
      eligible: false;
      reason: 'incomplete' | 'preview-limit' | 'invalid-image';
      capturedBytes: number;
      totalBytes: number;
    };

const SUPPORTED_CHARSETS = new Set<SupportedPreviewCharset>([
  'utf-8',
  'utf-16le',
  'utf-16be',
  'windows-1252',
  'iso-8859-1',
  'us-ascii',
]);

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const DECODER_CHUNK_BYTES = 64 * 1024;

export function captureBytePrefix(chunks: Iterable<Uint8Array>): BytePrefixCapture {
  const prefix = new Uint8Array(RESPONSE_PREVIEW_MAX_BYTES);
  let capturedBytes = 0;
  let totalBytes = 0;

  for (const chunk of chunks) {
    totalBytes += chunk.byteLength;
    if (capturedBytes >= RESPONSE_PREVIEW_MAX_BYTES) continue;

    const retainedBytes = Math.min(chunk.byteLength, RESPONSE_PREVIEW_MAX_BYTES - capturedBytes);
    prefix.set(chunk.subarray(0, retainedBytes), capturedBytes);
    capturedBytes += retainedBytes;
  }

  return {
    bytes: capturedBytes === prefix.byteLength ? prefix : prefix.slice(0, capturedBytes),
    capturedBytes,
    totalBytes,
    truncated: totalBytes > capturedBytes,
  };
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.length <= bytes.byteLength
    && signature.every((value, index) => bytes[index] === value);
}

function declaredCharset(value: string | undefined): {
  charset?: SupportedPreviewCharset;
  unsupported: boolean;
} {
  if (value === undefined || value.trim() === '') {
    return { unsupported: false };
  }

  const trimmed = value.trim();
  const unquoted = trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  const normalized = unquoted.toLowerCase();

  return SUPPORTED_CHARSETS.has(normalized as SupportedPreviewCharset)
    ? { charset: normalized as SupportedPreviewCharset, unsupported: false }
    : { unsupported: true };
}

function bomCharset(bytes: Uint8Array): SupportedPreviewCharset | undefined {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8';
  if (startsWith(bytes, UTF16LE_BOM)) return 'utf-16le';
  if (startsWith(bytes, UTF16BE_BOM)) return 'utf-16be';
  return undefined;
}

function streamDecode(
  bytes: Uint8Array,
  charset: SupportedPreviewCharset,
  flush: boolean,
  fatal: boolean,
): string {
  const decoder = new TextDecoder(charset, { fatal, ignoreBOM: false });
  let text = '';

  for (let offset = 0; offset < bytes.byteLength; offset += DECODER_CHUNK_BYTES) {
    text += decoder.decode(bytes.subarray(offset, offset + DECODER_CHUNK_BYTES), { stream: true });
  }

  if (flush) text += decoder.decode();
  return text;
}

function decodeCapture(
  capture: BytePrefixCapture,
  declaredLabel: string | undefined,
  flush: boolean,
): { text: string; charset: SupportedPreviewCharset; decodeError: boolean } {
  const declared = declaredCharset(declaredLabel);
  const charset = bomCharset(capture.bytes) ?? declared.charset ?? 'utf-8';
  let malformed = false;

  try {
    streamDecode(capture.bytes, charset, flush, true);
  } catch {
    malformed = true;
  }

  return {
    text: streamDecode(capture.bytes, charset, flush, false),
    charset,
    decodeError: declared.unsupported || malformed,
  };
}

export function validateJsonBudget(text: string, complete: boolean): JsonBudgetValidation {
  if (!complete) {
    return { parseState: 'unparsed', treeEligible: false, nodeCount: 0, maxDepth: 0 };
  }

  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return { parseState: 'invalid', treeEligible: false, nodeCount: 0, maxDepth: 0 };
  }

  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodeCount = 0;
  let maxDepth = 0;

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) break;

    nodeCount += 1;
    maxDepth = Math.max(maxDepth, entry.depth);
    if (nodeCount > RESPONSE_JSON_MAX_NODES || entry.depth > RESPONSE_JSON_MAX_DEPTH) {
      return { parseState: 'over-budget', treeEligible: false, nodeCount, maxDepth };
    }

    if (entry.value === null || typeof entry.value !== 'object') continue;

    const childDepth = entry.depth + 1;
    const children = Array.isArray(entry.value)
      ? entry.value
      : Object.values(entry.value as Record<string, unknown>);

    if (children.length > RESPONSE_JSON_MAX_NODES - nodeCount - stack.length) {
      return {
        parseState: 'over-budget',
        treeEligible: false,
        nodeCount: RESPONSE_JSON_MAX_NODES + 1,
        maxDepth: Math.max(maxDepth, childDepth),
      };
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: childDepth });
    }
  }

  return { parseState: 'valid', treeEligible: true, nodeCount, maxDepth, tree: root };
}

export function validateTextPreview(options: TextPreviewOptions): TextPreviewValidation {
  const capture = captureBytePrefix(options.chunks);
  const totalBytes = Math.max(capture.totalBytes, options.totalBytes ?? 0);
  const truncated = capture.truncated || totalBytes > capture.capturedBytes || !options.complete;
  const completePreview = options.complete && !truncated;
  const decoded = decodeCapture(capture, options.declaredCharset, completePreview);

  let parseState: ResponseTextParseStateV2 = 'not-applicable';
  let presentation: TextPreviewValidation['presentation'] = 'source';
  let tree: unknown;

  if (options.format === 'json') {
    const json = validateJsonBudget(decoded.text, completePreview);
    parseState = json.parseState;
    if (json.treeEligible) {
      presentation = 'json-tree';
      tree = json.tree;
    }
  } else if (options.format === 'xml' || options.format === 'html' || options.format === 'svg') {
    presentation = 'escaped-source';
  }

  const preview: TextResponsePreviewV2 = {
    kind: 'text',
    format: options.format,
    text: decoded.text,
    parseState,
    charset: decoded.charset,
    decodeError: decoded.decodeError,
    capturedBytes: capture.capturedBytes,
    totalBytes,
    truncated,
    completeness: completePreview ? 'complete' : 'truncated',
  };

  return tree === undefined ? { preview, presentation } : { preview, presentation, tree };
}

function readUint16BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.byteLength) return undefined;
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.byteLength) return undefined;
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readUint24LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 3 > bytes.byteLength) return undefined;
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x1_0000;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return bytes[offset] * 0x1_000000
    + bytes[offset + 1] * 0x1_0000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3];
}

function readUint32LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  return bytes[offset]
    + bytes[offset + 1] * 0x100
    + bytes[offset + 2] * 0x1_0000
    + bytes[offset + 3] * 0x1_000000;
}

function asciiEquals(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function pngDimensions(bytes: Uint8Array): [number, number] | undefined {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return undefined;
  if (readUint32BE(bytes, 8) !== 13 || !asciiEquals(bytes, 12, 'IHDR')) return undefined;

  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  let offset = 8;
  let foundEnd = false;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = readUint32BE(bytes, offset);
    if (chunkLength === undefined || chunkLength > bytes.byteLength - offset - 12) return undefined;

    const chunkEnd = offset + 12 + chunkLength;
    if (asciiEquals(bytes, offset + 4, 'IEND')) {
      if (chunkLength !== 0 || chunkEnd !== bytes.byteLength) return undefined;
      foundEnd = true;
      break;
    }
    offset = chunkEnd;
  }

  return foundEnd && width !== undefined && height !== undefined ? [width, height] : undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpegDimensions(bytes: Uint8Array): [number, number] | undefined {
  if (!startsWith(bytes, [0xff, 0xd8]) || bytes.byteLength < 6) return undefined;
  if (bytes[bytes.byteLength - 2] !== 0xff || bytes[bytes.byteLength - 1] !== 0xd9) return undefined;

  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return undefined;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength === undefined || segmentLength < 2 || segmentLength > bytes.byteLength - offset) {
      return undefined;
    }

    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return undefined;
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      return width !== undefined && height !== undefined ? [width, height] : undefined;
    }

    if (marker === 0xda) return undefined;
    offset += segmentLength;
  }

  return undefined;
}

function gifDimensions(bytes: Uint8Array): [number, number] | undefined {
  const validSignature = asciiEquals(bytes, 0, 'GIF87a') || asciiEquals(bytes, 0, 'GIF89a');
  if (!validSignature || bytes.byteLength < 14 || bytes[bytes.byteLength - 1] !== 0x3b) return undefined;

  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  return width !== undefined && height !== undefined ? [width, height] : undefined;
}

function vp8Dimensions(bytes: Uint8Array, offset: number, length: number): [number, number] | undefined {
  if (length < 10 || offset + 10 > bytes.byteLength) return undefined;
  if (bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a) {
    return undefined;
  }

  const rawWidth = readUint16LE(bytes, offset + 6);
  const rawHeight = readUint16LE(bytes, offset + 8);
  return rawWidth !== undefined && rawHeight !== undefined
    ? [rawWidth & 0x3fff, rawHeight & 0x3fff]
    : undefined;
}

function vp8lDimensions(bytes: Uint8Array, offset: number, length: number): [number, number] | undefined {
  if (length < 5 || offset + 5 > bytes.byteLength || bytes[offset] !== 0x2f) return undefined;
  const width = 1 + bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8);
  const height = 1
    + ((bytes[offset + 2] & 0xc0) >>> 6)
    + (bytes[offset + 3] << 2)
    + ((bytes[offset + 4] & 0x0f) << 10);
  return [width, height];
}

function vp8xDimensions(bytes: Uint8Array, offset: number, length: number): [number, number] | undefined {
  if (length < 10 || offset + 10 > bytes.byteLength) return undefined;
  const storedWidth = readUint24LE(bytes, offset + 4);
  const storedHeight = readUint24LE(bytes, offset + 7);
  return storedWidth !== undefined && storedHeight !== undefined
    ? [storedWidth + 1, storedHeight + 1]
    : undefined;
}

function webpDimensions(bytes: Uint8Array): [number, number] | undefined {
  if (bytes.byteLength < 20 || !asciiEquals(bytes, 0, 'RIFF') || !asciiEquals(bytes, 8, 'WEBP')) {
    return undefined;
  }
  const riffSize = readUint32LE(bytes, 4);
  if (riffSize === undefined || riffSize + 8 !== bytes.byteLength) return undefined;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = readUint32LE(bytes, offset + 4);
    if (chunkLength === undefined) return undefined;
    const dataOffset = offset + 8;
    const paddedLength = chunkLength + (chunkLength & 1);
    if (paddedLength > bytes.byteLength - dataOffset) return undefined;

    if (asciiEquals(bytes, offset, 'VP8 ')) return vp8Dimensions(bytes, dataOffset, chunkLength);
    if (asciiEquals(bytes, offset, 'VP8L')) return vp8lDimensions(bytes, dataOffset, chunkLength);
    if (asciiEquals(bytes, offset, 'VP8X')) return vp8xDimensions(bytes, dataOffset, chunkLength);
    offset = dataOffset + paddedLength;
  }

  return undefined;
}

function rasterDimensions(bytes: Uint8Array, mediaType: RasterMediaType): ValidatedImageDimensionsV2 | undefined {
  let rawDimensions: [number, number] | undefined;
  if (mediaType === 'image/png') rawDimensions = pngDimensions(bytes);
  if (mediaType === 'image/jpeg') rawDimensions = jpegDimensions(bytes);
  if (mediaType === 'image/gif') rawDimensions = gifDimensions(bytes);
  if (mediaType === 'image/webp') rawDimensions = webpDimensions(bytes);
  if (!rawDimensions) return undefined;

  const [width, height] = rawDimensions;
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || !Number.isSafeInteger(pixels)
    || pixels > RESPONSE_IMAGE_MAX_PIXELS) {
    return undefined;
  }

  return { width, height, pixels, validated: true };
}

export function validateRasterPreview(options: RasterPreviewOptions): RasterPreviewValidation {
  const capture = captureBytePrefix(options.chunks);
  const totalBytes = Math.max(capture.totalBytes, options.totalBytes ?? 0);
  const failureMetadata = { capturedBytes: capture.capturedBytes, totalBytes };

  if (capture.truncated || totalBytes > RESPONSE_PREVIEW_MAX_BYTES) {
    return { eligible: false, reason: 'preview-limit', ...failureMetadata };
  }
  if (!options.complete || totalBytes !== capture.totalBytes) {
    return { eligible: false, reason: 'incomplete', ...failureMetadata };
  }

  const dimensions = rasterDimensions(capture.bytes, options.mediaType);
  if (!dimensions) {
    return { eligible: false, reason: 'invalid-image', ...failureMetadata };
  }

  return {
    eligible: true,
    preview: {
      kind: 'image',
      mediaType: options.mediaType,
      bytes: capture.bytes,
      dimensions,
      capturedBytes: capture.capturedBytes,
      totalBytes,
      truncated: false,
    },
  };
}
