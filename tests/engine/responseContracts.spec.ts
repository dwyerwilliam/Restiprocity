import { expect, test } from '@playwright/test';
import {
  normalizeLegacyResponse,
  toLegacyBoundedRendererResponse,
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
  test('normalizes a legacy JSON response into bounded V2', () => {
    const body = '{"message":"ok"}';
    const normalized = normalizeLegacyResponse({
      id: 'response-1',
      requestId: 'request-1',
      status: 200,
      statusText: 'OK',
      headers: [{ key: 'content-type', value: 'application/json; charset=utf-8', enabled: true }],
      body,
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
        completeness: 'unknown',
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
    expect(RESPONSE_PREVIEW_MAX_BYTES).toBe(1_048_576);
    expect(RESPONSE_TEXT_STAGING_MAX_BYTES).toBe(5_242_880);
    expect(RESPONSE_JSON_MAX_NODES).toBe(5_000);
    expect(RESPONSE_JSON_MAX_DEPTH).toBe(64);
    expect(RESPONSE_IMAGE_MAX_PIXELS).toBe(16_000_000);
    expect(RESPONSE_PROGRESS_MAX_HZ).toBe(10);
  });

  test('does not synthesize a replacement character when UTF-8 truncation splits a code point', () => {
    const body = `${'a'.repeat(RESPONSE_PREVIEW_MAX_BYTES - 1)}€`;
    const normalized = normalizeLegacyResponse({ body });

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

  test('tolerates missing and malformed legacy optional fields', () => {
    const normalized = normalizeLegacyResponse({
      status: 'not-a-number',
      headers: [{ key: 4, value: null }],
      timings: { total: 'slow' },
      cookies: 'invalid',
      body: null,
      size: -1,
    });

    expect(normalized).toEqual({
      version: 2,
      id: '',
      requestId: '',
      status: 0,
      statusText: '',
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
    const normalized = normalizeLegacyResponse({
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

  test('adapts only bounded text and safe metadata to the legacy renderer shape', () => {
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

    const legacy = toLegacyBoundedRendererResponse(imageResponse);

    expect(legacy.body).toBe('[Image response: image/png, 1×1, 3 bytes]');
    expect(legacy.body).not.toContain('10,20,30');
    expect(new TextEncoder().encode(legacy.body).byteLength).toBeLessThanOrEqual(RESPONSE_PREVIEW_MAX_BYTES);
  });
});
