import { expect, test } from '@playwright/test';
import {
  classifyFinalResponse,
  getSaveDialogFilters,
  parseContentDisposition,
  sanitizeResponseBasename,
  selectResponseFilename,
} from '../../src/main/engine/responseClassifier';
import {
  RESPONSE_PREVIEW_MAX_BYTES,
  RESPONSE_TEXT_STAGING_MAX_BYTES,
} from '../../src/shared/responseLimits';
import type { Header, HttpMethod } from '../../src/shared/types';

const NOW = new Date('2024-01-02T03:04:05.006Z');

function headers(values: Record<string, string>): Header[] {
  return Object.entries(values).map(([key, value]) => ({ key, value, enabled: true }));
}

function classify({
  method = 'GET',
  status = 200,
  values = { 'content-type': 'application/json' },
  url = 'https://api.example.test/v1/items',
}: {
  method?: HttpMethod;
  status?: number;
  values?: Record<string, string>;
  url?: string;
} = {}) {
  return classifyFinalResponse({ method, status, headers: headers(values), url, now: NOW });
}

test.describe('Response classifier', () => {
  test('routes final responses by bodyless disposition MIME and size precedence', () => {
    const bodylessCases: Array<[string, Parameters<typeof classify>[0], string]> = [
      ['HEAD', { method: 'HEAD', values: { 'content-disposition': 'attachment', 'content-type': 'application/pdf' } }, 'empty'],
      ['informational', { status: 103, values: { 'content-disposition': 'attachment', 'content-type': 'application/pdf' } }, 'empty'],
      ['204', { status: 204, values: { 'content-disposition': 'attachment', 'content-type': 'application/pdf' } }, 'empty'],
      ['205', { status: 205, values: { 'content-disposition': 'attachment', 'content-type': 'application/pdf' } }, 'empty'],
      ['304', { status: 304, values: { 'content-disposition': 'attachment', 'content-type': 'application/pdf' } }, 'empty'],
    ];

    for (const [label, input, expectedKind] of bodylessCases) {
      expect(classify(input).kind, label).toBe(expectedKind);
    }

    expect(classify({
      values: {
        'content-type': 'text/plain',
        'content-disposition': 'ATTACHMENT',
        'content-length': '1',
      },
    })).toMatchObject({ kind: 'download', reason: 'attachment', mediaType: 'text/plain' });

    expect(classify({
      values: {
        'content-type': 'text/plain',
        'content-disposition': 'inline; filename="report.txt"',
      },
    })).toMatchObject({ kind: 'download', reason: 'attachment', suggestedFileName: 'report.txt' });

    const textCases: Array<[string, string, string]> = [
      ['text subtype', 'text/plain', 'text'],
      ['HTML source', 'Text/HTML; Charset=UTF-8', 'html'],
      ['JSON', 'application/json', 'json'],
      ['vendor JSON', 'application/vnd.api+json; profile="x"', 'json'],
      ['XML', 'application/xml', 'xml'],
      ['vendor XML', 'application/problem+xml', 'xml'],
      ['JavaScript', 'application/javascript', 'text'],
      ['text JavaScript', 'text/javascript', 'text'],
      ['form data', 'application/x-www-form-urlencoded', 'text'],
      ['SVG source', 'image/svg+xml', 'svg'],
    ];

    for (const [label, contentType, format] of textCases) {
      expect(classify({ values: { 'CoNtEnT-TyPe': contentType } }), label).toMatchObject({
        kind: 'text',
        format,
      });
    }

    for (const mediaType of ['image/png', 'IMAGE/JPEG; q=1', 'image/gif', 'image/webp']) {
      expect(classify({ values: { 'content-type': mediaType } }), mediaType).toMatchObject({ kind: 'raster' });
    }

    const downloadTypes = [
      'application/pdf',
      'audio/mpeg',
      'video/mp4',
      'application/zip',
      'application/x-protobuf',
      'multipart/form-data; boundary=x',
      'application/octet-stream',
      'image/bmp',
      'image/jpg',
      'application/x-ndjson',
      'application/json, text/plain',
      'not a media type',
      '',
    ];

    for (const mediaType of downloadTypes) {
      expect(classify({ values: { 'content-type': mediaType } }), mediaType || 'empty MIME').toMatchObject({
        kind: 'download',
        reason: 'unsupported-media-type',
      });
    }
    expect(classify({ values: {} })).toMatchObject({ kind: 'download', reason: 'unsupported-media-type', mediaType: null });

    expect(classify({
      values: { 'content-type': 'image/png', 'content-length': String(RESPONSE_PREVIEW_MAX_BYTES) },
    })).toMatchObject({ kind: 'raster', declaredSize: RESPONSE_PREVIEW_MAX_BYTES });
    expect(classify({
      values: { 'content-type': 'image/png', 'content-length': String(RESPONSE_PREVIEW_MAX_BYTES + 1) },
    })).toMatchObject({ kind: 'download', reason: 'preview-limit', declaredSize: RESPONSE_PREVIEW_MAX_BYTES + 1 });
    expect(classify({
      values: { 'content-type': 'application/json', 'content-length': String(RESPONSE_TEXT_STAGING_MAX_BYTES) },
    })).toMatchObject({ kind: 'text', declaredSize: RESPONSE_TEXT_STAGING_MAX_BYTES });
    expect(classify({
      values: { 'content-type': 'application/json', 'content-length': String(RESPONSE_TEXT_STAGING_MAX_BYTES + 1) },
    })).toMatchObject({ kind: 'download', reason: 'preview-limit', declaredSize: RESPONSE_TEXT_STAGING_MAX_BYTES + 1 });

    for (const malformedLength of ['-1', '1.5', '12px', '1, 2', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(classify({
        values: { 'content-type': 'text/plain', 'content-length': malformedLength },
      }), malformedLength).toMatchObject({ kind: 'text', declaredSize: undefined });
    }
  });

  test('uses only the final response headers after redirects', () => {
    const redirectHeaders = headers({
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="redirect.bin"',
    });
    const finalHeaders = headers({ 'content-type': 'application/json' });

    expect(classifyFinalResponse({
      method: 'GET',
      status: 200,
      headers: finalHeaders,
      url: 'https://api.example.test/final',
      now: NOW,
    })).toMatchObject({ kind: 'text', format: 'json' });
    expect(redirectHeaders).not.toEqual(finalHeaders);
  });

  test('parses filename star only when its RFC 5987 value is valid', () => {
    expect(parseContentDisposition("attachment; filename=legacy.txt; filename*=UTF-8''caf%C3%A9.json")).toEqual({
      attachment: true,
      filename: 'café.json',
    });
    expect(parseContentDisposition("inline; filename=legacy.txt; filename*=ISO-8859-1'en'caf%E9.txt")).toEqual({
      attachment: false,
      filename: 'café.txt',
    });
    expect(parseContentDisposition("inline; filename=legacy.txt; filename*=UTF-8''bad%ZZname")).toEqual({
      attachment: false,
      filename: 'legacy.txt',
    });
    expect(parseContentDisposition("inline; filename=legacy.txt; filename*=UTF-16''%00a")).toEqual({
      attachment: false,
      filename: 'legacy.txt',
    });
    expect(parseContentDisposition("inline; filename=legacy.txt; filename*=UTF-8'en us'report.txt")).toEqual({
      attachment: false,
      filename: 'legacy.txt',
    });
    expect(parseContentDisposition('inline; filename="semi; colon.txt"')).toEqual({
      attachment: false,
      filename: 'semi; colon.txt',
    });
    expect(parseContentDisposition('inline; filename="unterminated')).toEqual({ attachment: false });
    expect(parseContentDisposition('inline; filename=a.txt; filename=b.txt')).toEqual({ attachment: false });
  });

  test('sanitizes malicious filename suggestions', () => {
    const cases: Array<[string, string, string]> = [
      ['relative traversal', '../../etc/passwd', 'passwd'],
      ['Windows absolute path', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
      ['UNC path', '\\\\server\\share\\report.txt', 'report.txt'],
      ['controls', 'report\u0000\u001f.txt', 'report.txt'],
      ['bidi and zero-width controls', 'safe\u202Egnp\u200B.txt', 'safegnp.txt'],
      ['unsafe punctuation', 'sales<q1>:final?.json', 'sales_q1__final_.json'],
      ['trailing dots and spaces', 'report...   ', 'report'],
      ['Unicode separator confusion', 'folder\u2215secret.txt', 'secret.txt'],
    ];

    for (const [label, candidate, expected] of cases) {
      expect(selectResponseFilename({
        contentDisposition: `attachment; filename="${candidate.replaceAll('\\', '\\\\')}"`,
        responseUrl: 'https://api.example.test/url-fallback.json',
        mediaType: 'application/json',
        now: NOW,
      }), label).toBe(expected);
    }

    expect(selectResponseFilename({
      contentDisposition: String.raw`attachment; filename="C:\Windows\System32\drivers\etc\hosts"`,
      responseUrl: 'https://api.example.test/url-fallback.json',
      mediaType: 'application/json',
      now: NOW,
    }), 'unescaped Windows path').toBe('hosts');

    for (const reserved of ['.', '..', 'CON', 'prn.txt', 'AUX', 'nul.log', 'COM1', 'lpt9.txt', 'CLOCK$']) {
      expect(selectResponseFilename({
        contentDisposition: `attachment; filename="${reserved}"`,
        responseUrl: 'https://api.example.test/safe.json',
        mediaType: 'application/json',
        now: NOW,
      }), reserved).toBe('safe.json');
    }

    expect(selectResponseFilename({
      contentDisposition: "inline; filename*=UTF-8''bad%ZZname",
      responseUrl: 'https://api.example.test/caf%C3%A9.json?download=1',
      mediaType: 'application/json',
      now: NOW,
    })).toBe('café.json');

    expect(selectResponseFilename({
      responseUrl: 'not a valid URL',
      mediaType: 'application/json',
      now: NOW,
    })).toBe('response-20240102-030405-006.json');

    const longName = `${'界'.repeat(100)}.json`;
    const bounded = sanitizeResponseBasename(longName);
    expect(bounded).toBeDefined();
    expect(Buffer.byteLength(bounded!, 'utf8')).toBeLessThanOrEqual(180);
    expect(bounded).toMatch(/\.json$/);
    expect(bounded).not.toContain('�');

    const longUnsafeExtension = sanitizeResponseBasename(`${'a'.repeat(200)}.${'z'.repeat(17)}`);
    expect(longUnsafeExtension).toBeDefined();
    expect(Buffer.byteLength(longUnsafeExtension!, 'utf8')).toBeLessThanOrEqual(180);
    expect(longUnsafeExtension).not.toMatch(/\.z{17}$/);
  });

  test('maps exact MIME filters and deterministic fallback extensions', () => {
    const cases: Array<[string | null, string, string[]]> = [
      ['image/png', 'PNG', ['png']],
      ['image/jpeg', 'JPEG', ['jpg', 'jpeg']],
      ['image/gif', 'GIF', ['gif']],
      ['image/webp', 'WebP', ['webp']],
      ['application/json', 'JSON', ['json']],
      ['application/problem+json', 'JSON', ['json']],
      ['application/xml', 'XML / SVG', ['xml', 'svg']],
      ['image/svg+xml', 'XML / SVG', ['xml', 'svg']],
      ['text/html', 'HTML', ['html', 'htm']],
      ['text/plain', 'Text', ['txt']],
      ['application/javascript', 'Text', ['txt']],
      ['application/pdf', 'PDF', ['pdf']],
      ['application/zip', 'ZIP', ['zip']],
      ['application/octet-stream', 'All Files', ['*']],
      [null, 'All Files', ['*']],
    ];

    for (const [mediaType, name, extensions] of cases) {
      expect(getSaveDialogFilters(mediaType), String(mediaType)).toEqual([{ name, extensions }]);
    }

    expect(selectResponseFilename({ responseUrl: '', mediaType: 'image/svg+xml', now: NOW }))
      .toBe('response-20240102-030405-006.svg');
    expect(selectResponseFilename({ responseUrl: '', mediaType: 'application/octet-stream', now: NOW }))
      .toBe('response-20240102-030405-006');
  });

  test('ignores disabled headers and matches header names case-insensitively', () => {
    const result = classifyFinalResponse({
      method: 'GET',
      status: 200,
      headers: [
        { key: 'content-type', value: 'application/octet-stream', enabled: false },
        { key: 'CONTENT-TYPE', value: 'application/json; charset=utf-8', enabled: true },
      ],
      url: 'https://api.example.test/result',
      now: NOW,
    });

    expect(result).toMatchObject({ kind: 'text', format: 'json', mediaType: 'application/json' });
  });

  test('treats missing content types on error responses as text (issue #3)', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      expect(classify({ status, values: {} }), String(status)).toMatchObject({
        kind: 'text',
        format: 'text',
        mediaType: 'text/plain',
      });
    }

    expect(classify({ status: 404, values: { 'content-length': '11' } })).toMatchObject({
      kind: 'text',
      format: 'text',
      mediaType: 'text/plain',
      declaredSize: 11,
    });

    expect(classify({ status: 404, values: { 'content-length': String(RESPONSE_TEXT_STAGING_MAX_BYTES + 1) } })).toMatchObject({
      kind: 'download',
      reason: 'unsupported-media-type',
      mediaType: null,
      declaredSize: RESPONSE_TEXT_STAGING_MAX_BYTES + 1,
    });

    expect(classify({ status: 200, values: {} })).toMatchObject({
      kind: 'download',
      reason: 'unsupported-media-type',
      mediaType: null,
    });

    expect(classify({ status: 404, values: { 'content-type': 'application/octet-stream' } })).toMatchObject({
      kind: 'download',
      reason: 'unsupported-media-type',
      mediaType: 'application/octet-stream',
    });
  });
});
