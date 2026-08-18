import { expect, test } from '@playwright/test';
import {
  normalizeResponseSnapshotV2,
  toRendererResponseV2,
  toPersistedResponseV2,
} from '../../src/shared/responseContracts';
import {
  RESPONSE_IMAGE_MAX_PIXELS,
  RESPONSE_JSON_MAX_DEPTH,
  RESPONSE_JSON_MAX_NODES,
  RESPONSE_PREVIEW_MAX_BYTES,
  RESPONSE_PROGRESS_MAX_HZ,
  RESPONSE_TEXT_STAGING_MAX_BYTES,
} from '../../src/shared/responseLimits';
import { ResponseV2 } from '../../src/shared/types';

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectKeys);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    key,
    ...collectKeys(entry),
  ]);
}

test.describe('Versioned response contracts', () => {
  test('rejects legacy response snapshots instead of translating them', () => {
    expect(() => normalizeResponseSnapshotV2({ version: 1, body: '{"message":"ok"}' })).toThrow(/unsupported response snapshot version/i);
  });

  test('normalizes a versioned JSON response into bounded V2', () => {
    const body = '{"message":"ok"}';
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'response-1',
      requestId: 'request-1',
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'content-type', value: 'application/json; charset=utf-8', enabled: true }],
      preview: {
        kind: 'text',
        format: 'json',
        text: body,
        parseState: 'valid',
        charset: 'utf-8',
        decodeError: false,
        capturedBytes: new TextEncoder().encode(body).byteLength,
        totalBytes: new TextEncoder().encode(body).byteLength,
        truncated: false,
        completeness: 'complete',
      },
      timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
      timestamp: 123,
      size: 1_234,
      declaredSize: 2_048,
      cookies: [{
        name: 'session',
        value: 'value',
        domain: 'example.test',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      }],
    });

    expect(normalized).toMatchObject({
      version: 2,
      id: 'response-1',
      requestId: 'request-1',
      status: 200,
      statusText: 'OK',
      size: 1_234,
      declaredSize: 2_048,
      preview: {
        kind: 'text',
        format: 'json',
        text: body,
        parseState: 'valid',
        charset: 'utf-8',
        decodeError: false,
        capturedBytes: new TextEncoder().encode(body).byteLength,
        totalBytes: new TextEncoder().encode(body).byteLength,
        truncated: false,
        completeness: 'complete',
      },
    });
    expect(normalized.timings.total).toBe(15);
    expect(normalized.cookies).toHaveLength(1);
    expect(collectKeys(normalized)).not.toContain('body');
  });

  test('excludes unsafe download fields from persisted V2', () => {
    const runtimeResponse = {
      version: 2,
      id: 'response-image',
      requestId: 'request-image',
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'content-type', value: 'image/png', enabled: true }],
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 2, total: 3 },
      timestamp: 456,
      size: 4,
      declaredSize: 4,
      cookies: [],
      preview: {
        kind: 'image',
        mediaType: 'image/png',
        bytes: new Uint8Array([1, 2, 3, 4]),
        downloadedBytes: new Uint8Array([5, 6, 7, 8]),
        dimensions: { width: 2, height: 2, pixels: 4, validated: true },
        capturedBytes: 4,
        totalBytes: 4,
        truncated: false,
      },
      download: {
        state: 'saved',
        reason: 'attachment',
        mediaType: 'image/png',
        suggestedFileName: 'pixel.png',
        receivedBytes: 4,
        destinationPath: 'C:\\Users\\person\\pixel.png',
        partPath: 'C:\\Users\\person\\pixel.png.part',
        backupPath: 'C:\\Users\\person\\pixel.png.backup',
        filePath: 'C:\\Users\\person\\pixel.png',
      },
      destinationPath: 'C:\\Users\\person\\pixel.png',
    } satisfies ResponseV2 & {
      destinationPath: string;
      preview: ResponseV2['preview'] & { downloadedBytes: Uint8Array };
      download: NonNullable<ResponseV2['download']> & {
        destinationPath: string;
        partPath: string;
        backupPath: string;
        filePath: string;
      };
    };

    const persisted = toPersistedResponseV2(runtimeResponse);
    const keys = collectKeys(persisted);

    expect(keys).not.toEqual(expect.arrayContaining([
      'filePath',
      'destinationPath',
      'partPath',
      'backupPath',
      'bytes',
      'downloadedBytes',
    ]));
    expect(persisted.preview).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      dimensions: { width: 2, height: 2, pixels: 4, validated: true },
    });
    expect(JSON.stringify(persisted)).not.toContain('C:\\\\Users');
  });

  test('uses the exact immutable response bounds', () => {
    expect(RESPONSE_PREVIEW_MAX_BYTES).toBe(5_242_880);
    expect(RESPONSE_TEXT_STAGING_MAX_BYTES).toBe(5_242_880);
    expect(RESPONSE_JSON_MAX_NODES).toBe(5_000);
    expect(RESPONSE_JSON_MAX_DEPTH).toBe(64);
    expect(RESPONSE_IMAGE_MAX_PIXELS).toBe(16_000_000);
    expect(RESPONSE_PROGRESS_MAX_HZ).toBe(10);
  });

  test('does not synthesize a replacement character when UTF-8 truncation splits a code point', () => {
    const body = `${'a'.repeat(RESPONSE_PREVIEW_MAX_BYTES - 1)}€`;
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'response-truncated',
      requestId: 'request-truncated',
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
      preview: {
        kind: 'text',
        format: 'json',
        text: body,
        parseState: 'unparsed',
        charset: 'utf-8',
        decodeError: false,
        truncated: true,
        completeness: 'truncated',
      },
      timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
      timestamp: 123,
      size: 1_234,
      cookies: [],
    });

    expect(normalized.preview.kind).toBe('text');
    if (normalized.preview.kind !== 'text') {
      return;
    }

    expect(normalized.preview.capturedBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES - 1);
    expect(normalized.preview.totalBytes).toBe(RESPONSE_PREVIEW_MAX_BYTES + 2);
    expect(normalized.preview.text.endsWith('�')).toBe(false);
    expect(normalized.preview.text.endsWith('€')).toBe(false);
    expect(normalized.preview.truncated).toBe(true);
    expect(normalized.preview.completeness).toBe('truncated');
  });

  test('tolerates missing and malformed optional v2 fields', () => {
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'response-missing',
      requestId: 'request-missing',
      status: 'not-a-number',
      headers: [{ key: 4, value: null }],
      statusText: 'OK',
      timings: { total: 'slow' },
      cookies: 'invalid',
      size: -1,
      timestamp: 0,
    });

    expect(normalized).toEqual({
      version: 2,
      id: 'response-missing',
      requestId: 'request-missing',
      status: 0,
      statusText: 'OK',
      headers: [],
      preview: {
        kind: 'empty',
        capturedBytes: 0,
        totalBytes: 0,
        truncated: false,
        completeness: 'unknown',
      },
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: 0 },
      timestamp: 0,
      size: 0,
      cookies: [],
    });
  });

  test('accepts and reprojects already-versioned snapshots', () => {
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'existing-v2',
      requestId: 'request-v2',
      status: 204,
      statusText: 'No Content',
      headers: [],
      preview: {
        kind: 'empty',
        capturedBytes: 0,
        totalBytes: 0,
        truncated: false,
        completeness: 'complete',
      },
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 0, total: 1 },
      timestamp: 789,
      size: 0,
      cookies: [],
      destinationPath: '/unsafe/path',
    });

    expect(normalized).toMatchObject({
      version: 2,
      id: 'existing-v2',
      preview: { kind: 'empty', completeness: 'complete' },
    });
    expect(collectKeys(normalized)).not.toContain('destinationPath');
  });

  test('preserves persisted non-UTF-8 text byte and truncation metadata', () => {
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'non-utf8',
      requestId: 'request-non-utf8',
      status: 200,
      statusText: 'OK',
      headers: [],
      preview: {
        kind: 'text',
        format: 'text',
        text: 'é',
        parseState: 'not-applicable',
        charset: 'windows-1252',
        decodeError: false,
        capturedBytes: 1,
        totalBytes: 4,
        truncated: true,
        completeness: 'truncated',
      },
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: 0 },
      timestamp: 1,
      size: 4,
      cookies: [],
    });

    expect(normalized.preview).toMatchObject({
      kind: 'text',
      text: 'é',
      charset: 'windows-1252',
      capturedBytes: 1,
      totalBytes: 4,
      truncated: true,
      completeness: 'truncated',
    });
  });

  test('does not re-truncate complete non-UTF-8 previews using UTF-8 byte counts', () => {
    const text = 'é'.repeat(RESPONSE_PREVIEW_MAX_BYTES);
    const normalized = normalizeResponseSnapshotV2({
      version: 2,
      id: 'non-utf8-complete',
      requestId: 'request-non-utf8-complete',
      status: 200,
      statusText: 'OK',
      headers: [],
      preview: {
        kind: 'text',
        format: 'text',
        text,
        parseState: 'not-applicable',
        charset: 'windows-1252',
        decodeError: false,
        capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
        totalBytes: RESPONSE_PREVIEW_MAX_BYTES,
        truncated: false,
        completeness: 'complete',
      },
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: 0 },
      timestamp: 1,
      size: RESPONSE_PREVIEW_MAX_BYTES,
      cookies: [],
    });

    expect(normalized.preview).toMatchObject({
      kind: 'text',
      text,
      charset: 'windows-1252',
      capturedBytes: RESPONSE_PREVIEW_MAX_BYTES,
      totalBytes: RESPONSE_PREVIEW_MAX_BYTES,
      truncated: false,
      completeness: 'complete',
    });
  });

  test('rehydrates persisted images as download metadata without inventing bytes', () => {
    const imageResponse: ResponseV2 = {
      version: 2,
      id: 'image',
      requestId: 'request',
      status: 200,
      statusText: 'OK',
      headers: [],
      preview: {
        kind: 'image',
        mediaType: 'image/png',
        bytes: new Uint8Array([10, 20, 30]),
        dimensions: { width: 1, height: 1, pixels: 1, validated: true },
        capturedBytes: 3,
        totalBytes: 3,
        truncated: false,
      },
      timings: { dns: 0, tcp: 0, tls: 0, ttfb: 0, download: 0, total: 0 },
      timestamp: 1,
      size: 3,
      cookies: [],
    };

    const restored = toRendererResponseV2(toPersistedResponseV2(imageResponse));

    expect(restored.preview).toMatchObject({ kind: 'download-only', mediaType: 'image/png' });
    expect(collectKeys(restored)).not.toContain('bytes');
  });
});
