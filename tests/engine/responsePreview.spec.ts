import { expect, test } from '@playwright/test';
import {
  captureBytePrefix,
  validateJsonBudget,
  validateRasterPreview,
  validateTextPreview,
} from '../../src/main/engine/responsePreview';
import {
  RESPONSE_IMAGE_MAX_PIXELS,
  RESPONSE_JSON_MAX_DEPTH,
  RESPONSE_JSON_MAX_NODES,
  RESPONSE_PREVIEW_MAX_BYTES,
} from '../../src/shared/responseLimits';

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const offset of offsets) {
    chunks.push(bytes.subarray(start, offset));
    start = offset;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

function randomizedChunks(bytes: Uint8Array, seed: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let state = seed >>> 0;
  let offset = 0;
  while (offset < bytes.byteLength) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const size = 1 + (state % 65_537);
    const end = Math.min(offset + size, bytes.byteLength);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

function utf16Bytes(value: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = littleEndian ? codeUnit & 0xff : codeUnit >>> 8;
    bytes[index * 2 + 1] = littleEndian ? codeUnit >>> 8 : codeUnit & 0xff;
  }
  return bytes;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value & 0xff;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >>> 8;
}

function writeUint24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = value >>> 16;
  bytes[offset + 2] = value >>> 8;
  bytes[offset + 3] = value;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value;
  bytes[offset + 1] = value >>> 8;
  bytes[offset + 2] = value >>> 16;
  bytes[offset + 3] = value >>> 24;
}

function pngFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeUint32BE(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  writeUint32BE(bytes, 33, 0);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 37);
  return bytes;
}

function jpegFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(23);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  writeUint16BE(bytes, 7, height);
  writeUint16BE(bytes, 9, width);
  bytes.set([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9], 11);
  return bytes;
}

function gifFixture(width: number, height: number, totalBytes = 14): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(new TextEncoder().encode('GIF89a'));
  writeUint16LE(bytes, 6, width);
  writeUint16LE(bytes, 8, height);
  bytes[10] = 0;
  bytes[11] = 0;
  bytes[12] = 0;
  bytes[bytes.byteLength - 1] = 0x3b;
  return bytes;
}

function webpFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'));
  writeUint32LE(bytes, 4, bytes.byteLength - 8);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  writeUint32LE(bytes, 16, 10);
  writeUint24LE(bytes, 24, width - 1);
  writeUint24LE(bytes, 27, height - 1);
  return bytes;
}

function webpVp8Fixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'));
  writeUint32LE(bytes, 4, bytes.byteLength - 8);
  bytes.set(new TextEncoder().encode('WEBPVP8 '), 8);
  writeUint32LE(bytes, 16, 10);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  writeUint16LE(bytes, 26, width);
  writeUint16LE(bytes, 28, height);
  return bytes;
}

function webpVp8lFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  const storedWidth = width - 1;
  const storedHeight = height - 1;
  bytes.set(new TextEncoder().encode('RIFF'));
  writeUint32LE(bytes, 4, bytes.byteLength - 8);
  bytes.set(new TextEncoder().encode('WEBPVP8L'), 8);
  writeUint32LE(bytes, 16, 5);
  bytes[20] = 0x2f;
  bytes[21] = storedWidth & 0xff;
  bytes[22] = ((storedWidth >>> 8) & 0x3f) | ((storedHeight & 0x03) << 6);
  bytes[23] = (storedHeight >>> 2) & 0xff;
  bytes[24] = (storedHeight >>> 10) & 0x0f;
  return bytes;
}

test.describe('Bounded response preview helpers', () => {
  test('captures the exact byte prefix for single split and randomized chunks', () => {
    const exact = new Uint8Array(RESPONSE_PREVIEW_MAX_BYTES).fill(0x61);
    const oversized = new Uint8Array(RESPONSE_PREVIEW_MAX_BYTES + 1).fill(0x62);
    const exactLayouts = [
      [exact],
      splitAt(exact, [1, RESPONSE_PREVIEW_MAX_BYTES - 1]),
      randomizedChunks(exact, 0x1ee7),
    ];
    const oversizedLayouts = [
      [oversized],
      splitAt(oversized, [1, RESPONSE_PREVIEW_MAX_BYTES - 1]),
      randomizedChunks(oversized, 0x5eed),
    ];

    for (const chunks of exactLayouts) {
      expect(captureBytePrefix(chunks)).toMatchObject({
        capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
        totalBytes: RESPONSE_PREVIEW_MAX_BYTES,
        truncated: false,
      });
    }

    for (const chunks of oversizedLayouts) {
      const capture = captureBytePrefix(chunks);
      expect(capture.capturedBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES);
      expect(capture.totalBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES + 1);
      expect(capture.truncated).toBe(true);
      expect(capture.bytes.byteLength).toBe(RESPONSE_PREVIEW_MAX_BYTES);
      expect(capture.bytes[0]).toBe(0x62);
      expect(capture.bytes.at(-1)).toBe(0x62);
    }
  });

  test('preserves multibyte boundaries at the preview cap', () => {
    const encoded = new TextEncoder().encode(`${'a'.repeat(RESPONSE_PREVIEW_MAX_BYTES - 1)}€`);
    const layouts = [
      [encoded],
      splitAt(encoded, [RESPONSE_PREVIEW_MAX_BYTES - 1, RESPONSE_PREVIEW_MAX_BYTES]),
      randomizedChunks(encoded, 0xc0ffee),
    ];

    for (const chunks of layouts) {
      const result = validateTextPreview({ chunks, format: 'text', complete: true });
      expect(result.preview.capturedBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES);
      expect(result.preview.totalBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES + 2);
      expect(result.preview.truncated).toBe(true);
      expect(result.preview.text).toBe('a'.repeat(RESPONSE_PREVIEW_MAX_BYTES - 1));
      expect(result.preview.text.endsWith('�')).toBe(false);
      expect(result.preview.decodeError).toBe(false);
    }
  });

  test('resolves BOM declared charset fallback and decode errors deterministically', () => {
    const cases = [
      {
        name: 'UTF-8 BOM overrides declaration',
        bytes: concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode('snowman ☃')),
        declaredCharset: 'windows-1252',
        charset: 'utf-8',
        text: 'snowman ☃',
        decodeError: false,
      },
      {
        name: 'UTF-16LE BOM overrides declaration',
        bytes: concatBytes(new Uint8Array([0xff, 0xfe]), utf16Bytes('little', true)),
        declaredCharset: 'utf-8',
        charset: 'utf-16le',
        text: 'little',
        decodeError: false,
      },
      {
        name: 'UTF-16BE BOM is selected',
        bytes: concatBytes(new Uint8Array([0xfe, 0xff]), utf16Bytes('big', false)),
        declaredCharset: undefined,
        charset: 'utf-16be',
        text: 'big',
        decodeError: false,
      },
      {
        name: 'declared UTF-16LE is decoded without a BOM',
        bytes: utf16Bytes('declared little', true),
        declaredCharset: 'utf-16le',
        charset: 'utf-16le',
        text: 'declared little',
        decodeError: false,
      },
      {
        name: 'declared UTF-16BE is decoded without a BOM',
        bytes: utf16Bytes('declared big', false),
        declaredCharset: 'UTF-16BE',
        charset: 'utf-16be',
        text: 'declared big',
        decodeError: false,
      },
      {
        name: 'Windows-1252 is decoded',
        bytes: new Uint8Array([0x80, 0x20, 0x41]),
        declaredCharset: 'WINDOWS-1252',
        charset: 'windows-1252',
        text: '€ A',
        decodeError: false,
      },
      {
        name: 'ISO-8859-1 is accepted',
        bytes: new Uint8Array([0xa3]),
        declaredCharset: 'iso-8859-1',
        charset: 'iso-8859-1',
        text: '£',
        decodeError: false,
      },
      {
        name: 'US-ASCII is accepted',
        bytes: new Uint8Array([0x41, 0x53, 0x43, 0x49, 0x49]),
        declaredCharset: 'us-ascii',
        charset: 'us-ascii',
        text: 'ASCII',
        decodeError: false,
      },
      {
        name: 'unsupported labels fall back to UTF-8 and are flagged',
        bytes: new TextEncoder().encode('fallback'),
        declaredCharset: 'shift_jis',
        charset: 'utf-8',
        text: 'fallback',
        decodeError: true,
      },
      {
        name: 'unsupported aliases are not silently accepted',
        bytes: new TextEncoder().encode('alias fallback'),
        declaredCharset: 'utf8',
        charset: 'utf-8',
        text: 'alias fallback',
        decodeError: true,
      },
      {
        name: 'unsupported labels remain flagged when a BOM wins',
        bytes: concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode('BOM fallback')),
        declaredCharset: 'latin1',
        charset: 'utf-8',
        text: 'BOM fallback',
        decodeError: true,
      },
      {
        name: 'malformed UTF-8 is replaced and flagged',
        bytes: new Uint8Array([0x61, 0xc3, 0x28]),
        declaredCharset: 'utf-8',
        charset: 'utf-8',
        text: 'a�(',
        decodeError: true,
      },
      {
        name: 'incomplete complete UTF-8 is replaced and flagged',
        bytes: new Uint8Array([0xe2, 0x82]),
        declaredCharset: undefined,
        charset: 'utf-8',
        text: '�',
        decodeError: true,
      },
      {
        name: 'incomplete complete UTF-16 is replaced and flagged',
        bytes: new Uint8Array([0x41]),
        declaredCharset: 'utf-16le',
        charset: 'utf-16le',
        text: '�',
        decodeError: true,
      },
    ];

    for (const entry of cases) {
      const result = validateTextPreview({
        chunks: randomizedChunks(entry.bytes, entry.bytes.byteLength + 7),
        format: 'text',
        complete: true,
        declaredCharset: entry.declaredCharset,
      });
      expect(result.preview.charset, entry.name).toBe(entry.charset);
      expect(result.preview.text, entry.name).toBe(entry.text);
      expect(result.preview.decodeError, entry.name).toBe(entry.decodeError);
    }
  });

  test('accepts JSON at the inclusive node and depth limits', () => {
    const exactNodes = `[${new Array(RESPONSE_JSON_MAX_NODES - 1).fill('0').join(',')}]`;
    const exactDepth = `${'['.repeat(RESPONSE_JSON_MAX_DEPTH)}0${']'.repeat(RESPONSE_JSON_MAX_DEPTH)}`;
    const propertyNamesExcluded = `{${Array.from(
      { length: RESPONSE_JSON_MAX_NODES - 1 },
      (_, index) => `"key-${index}":0`,
    ).join(',')}}`;

    expect(validateJsonBudget(exactNodes, true)).toMatchObject({
      parseState: 'valid',
      nodeCount: RESPONSE_JSON_MAX_NODES,
      maxDepth: 1,
      treeEligible: true,
    });
    expect(validateJsonBudget(exactDepth, true)).toMatchObject({
      parseState: 'valid',
      nodeCount: RESPONSE_JSON_MAX_DEPTH + 1,
      maxDepth: RESPONSE_JSON_MAX_DEPTH,
      treeEligible: true,
    });
    expect(validateJsonBudget(propertyNamesExcluded, true)).toMatchObject({
      parseState: 'valid',
      nodeCount: RESPONSE_JSON_MAX_NODES,
      treeEligible: true,
    });
  });

  test('rejects previews beyond JSON and raster budgets', () => {
    const tooManyNodes = `[${new Array(RESPONSE_JSON_MAX_NODES).fill('0').join(',')}]`;
    const tooDeep = `${'['.repeat(RESPONSE_JSON_MAX_DEPTH + 1)}0${']'.repeat(RESPONSE_JSON_MAX_DEPTH + 1)}`;
    const hostileDepth = `${'['.repeat(20_000)}0${']'.repeat(20_000)}`;

    expect(validateJsonBudget(tooManyNodes, true)).toMatchObject({
      parseState: 'over-budget',
      nodeCount: RESPONSE_JSON_MAX_NODES + 1,
      treeEligible: false,
    });
    expect(validateJsonBudget(tooDeep, true)).toMatchObject({
      parseState: 'over-budget',
      maxDepth: RESPONSE_JSON_MAX_DEPTH + 1,
      treeEligible: false,
    });
    expect(validateJsonBudget(hostileDepth, true)).toMatchObject({
      parseState: 'over-budget',
      treeEligible: false,
    });

    for (const entry of [
      { mediaType: 'image/png' as const, bytes: pngFixture(4_000, 4_001) },
      { mediaType: 'image/jpeg' as const, bytes: jpegFixture(4_000, 4_001) },
      { mediaType: 'image/gif' as const, bytes: gifFixture(4_000, 4_001) },
      { mediaType: 'image/webp' as const, bytes: webpFixture(4_000, 4_001) },
    ]) {
      expect(validateRasterPreview({
        chunks: [entry.bytes],
        mediaType: entry.mediaType,
        complete: true,
      })).toMatchObject({ eligible: false, reason: 'invalid-image' });
    }

    const oversized = validateRasterPreview({
      chunks: [gifFixture(1, 1, RESPONSE_PREVIEW_MAX_BYTES + 1)],
      mediaType: 'image/gif',
      complete: true,
    });
    expect(oversized).toMatchObject({
      eligible: false,
      reason: 'preview-limit',
      capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
      totalBytes: RESPONSE_PREVIEW_MAX_BYTES + 1,
    });
  });

  test('returns bounded source metadata for invalid truncated JSON and markup', () => {
    const invalid = validateTextPreview({
      chunks: [new TextEncoder().encode('{"open":]')],
      format: 'json',
      complete: true,
    });
    expect(invalid).toMatchObject({
      presentation: 'source',
      preview: { parseState: 'invalid', text: '{"open":]', completeness: 'complete' },
    });
    expect(invalid).not.toHaveProperty('tree');

    const truncated = validateTextPreview({
      chunks: [new TextEncoder().encode('{"open":')],
      format: 'json',
      complete: false,
      totalBytes: 20,
    });
    expect(truncated).toMatchObject({
      presentation: 'source',
      preview: { parseState: 'unparsed', text: '{"open":', completeness: 'truncated', truncated: true },
    });
    expect(truncated.preview.text).not.toContain('}');

    for (const format of ['xml', 'html', 'svg'] as const) {
      const source = `<root format="${format}">& text</root>`;
      const markup = validateTextPreview({
        chunks: [new TextEncoder().encode(source)],
        format,
        complete: true,
      });
      expect(markup.presentation).toBe('escaped-source');
      expect(markup.preview.text).toBe(source);
      expect(markup.preview.parseState).toBe('not-applicable');
    }
  });

  test('parses bounded PNG JPEG GIF and WebP dimensions at the pixel limit', () => {
    const cases = [
      { mediaType: 'image/png' as const, bytes: pngFixture(4_000, 4_000) },
      { mediaType: 'image/jpeg' as const, bytes: jpegFixture(4_000, 4_000) },
      { mediaType: 'image/gif' as const, bytes: gifFixture(4_000, 4_000) },
      { mediaType: 'image/webp' as const, bytes: webpFixture(4_000, 4_000) },
    ];

    for (const entry of cases) {
      const result = validateRasterPreview({
        chunks: randomizedChunks(entry.bytes, 17),
        mediaType: entry.mediaType,
        complete: true,
      });
      expect(result).toMatchObject({
        eligible: true,
        preview: {
          kind: 'image',
          mediaType: entry.mediaType,
          dimensions: {
            width: 4_000,
            height: 4_000,
            pixels: RESPONSE_IMAGE_MAX_PIXELS,
            validated: true,
          },
          totalBytes: entry.bytes.byteLength,
          truncated: false,
        },
      });
      if (result.eligible) {
        expect(result.preview.bytes).toEqual(entry.bytes);
      }
    }
  });

  test('parses lossy lossless and extended WebP dimension headers', () => {
    for (const bytes of [webpVp8Fixture(321, 123), webpVp8lFixture(321, 123), webpFixture(321, 123)]) {
      expect(validateRasterPreview({
        chunks: randomizedChunks(bytes, 91),
        mediaType: 'image/webp',
        complete: true,
      })).toMatchObject({
        eligible: true,
        preview: { dimensions: { width: 321, height: 123, pixels: 39_483 } },
      });
    }
  });

  test('requires complete raster payloads and rejects corrupt truncated and nonpositive headers', () => {
    const validPng = pngFixture(2, 3);
    const corruptPng = validPng.slice();
    corruptPng[0] = 0;
    const zeroGif = gifFixture(0, 1);
    const corruptJpeg = jpegFixture(2, 3);
    corruptJpeg[corruptJpeg.byteLength - 1] = 0;
    const corruptWebp = webpFixture(2, 3);
    writeUint32LE(corruptWebp, 4, 2);

    const cases = [
      { mediaType: 'image/png' as const, bytes: validPng, complete: false, reason: 'incomplete' },
      { mediaType: 'image/png' as const, bytes: corruptPng, complete: true, reason: 'invalid-image' },
      { mediaType: 'image/png' as const, bytes: validPng.subarray(0, 23), complete: true, reason: 'invalid-image' },
      { mediaType: 'image/jpeg' as const, bytes: corruptJpeg, complete: true, reason: 'invalid-image' },
      { mediaType: 'image/jpeg' as const, bytes: jpegFixture(2, 3).subarray(0, 10), complete: true, reason: 'invalid-image' },
      { mediaType: 'image/gif' as const, bytes: zeroGif, complete: true, reason: 'invalid-image' },
      { mediaType: 'image/gif' as const, bytes: gifFixture(2, 3).subarray(0, 10), complete: true, reason: 'invalid-image' },
      { mediaType: 'image/webp' as const, bytes: corruptWebp, complete: true, reason: 'invalid-image' },
      { mediaType: 'image/webp' as const, bytes: webpFixture(2, 3).subarray(0, 19), complete: true, reason: 'invalid-image' },
    ];

    for (const entry of cases) {
      expect(validateRasterPreview({
        chunks: [entry.bytes],
        mediaType: entry.mediaType,
        complete: entry.complete,
      })).toMatchObject({ eligible: false, reason: entry.reason });
    }
  });

  test('allows an exact one MiB complete raster across chunk boundaries', () => {
    const exact = gifFixture(1, 1, RESPONSE_PREVIEW_MAX_BYTES);
    const result = validateRasterPreview({
      chunks: randomizedChunks(exact, 42),
      mediaType: 'image/gif',
      complete: true,
    });

    expect(result).toMatchObject({
      eligible: true,
      preview: {
        capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
        totalBytes: RESPONSE_PREVIEW_MAX_BYTES,
        truncated: false,
        dimensions: { width: 1, height: 1, pixels: 1 },
      },
    });
  });
});
