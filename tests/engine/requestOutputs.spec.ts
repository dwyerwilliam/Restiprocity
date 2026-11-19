import { expect, test } from '@playwright/test';
import {
  buildOutputLayer,
  computeOutputTtlMs,
  defaultRequestOutputs,
  extractOutputValues,
  OUTPUT_PLACEHOLDER,
  parseJsonPointer,
  readJsonPointer,
  siblingPointer,
  validateRequestOutputs,
  withholdOutputsBody,
} from '../../src/shared/requestOutputs';
import { toPersistedResponseV2, toRendererResponseV2 } from '../../src/shared/responseContracts';
import type { RequestOutputs, ResponseV2 } from '../../src/shared/types';
import { createVariableContext, observeDependencies } from '../../src/shared/variableContext';

const builtIns = { timestamp: 1, randomInt: 2, uuid: 'u' } as const;

function outputs(overrides: Partial<RequestOutputs> = {}): RequestOutputs {
  return { ...defaultRequestOutputs(), ...overrides };
}

function jsonResponse(body: unknown, status = 200) {
  return { status, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], bodyText: JSON.stringify(body) };
}

test.describe('JSON pointers', () => {
  test('parses RFC 6901 tokens and escapes', () => {
    expect(parseJsonPointer('')).toEqual([]);
    expect(parseJsonPointer('/a~1b')).toEqual(['a/b']);
    expect(parseJsonPointer('/a~0b')).toEqual(['a~b']);
    expect(parseJsonPointer('/a~01')).toEqual(['a~1']);
    expect(parseJsonPointer('/data/0/token')).toEqual(['data', '0', 'token']);
    expect(() => parseJsonPointer('access_token')).toThrow(/must start with "\/"/);
    expect(() => parseJsonPointer('/a~2')).toThrow(/invalid "~" escape/);
  });

  test('reads own properties and array indexes only', () => {
    const document = { data: [{ token: 'x' }], 'a/b': 1 };
    expect(readJsonPointer(document, ['data', '0', 'token'])).toBe('x');
    expect(readJsonPointer(document, ['a/b'])).toBe(1);
    expect(readJsonPointer(document, ['data', '01'])).toBeUndefined();
    expect(readJsonPointer(document, ['data', '1'])).toBeUndefined();
    expect(readJsonPointer({}, ['__proto__'])).toBeUndefined();
    expect(readJsonPointer({}, ['constructor'])).toBeUndefined();
    expect(readJsonPointer({ a: 'text' }, ['a', 'length'])).toBeUndefined();
    expect(readJsonPointer('root', [])).toBe('root');
  });

  test('builds the sibling of a field', () => {
    expect(siblingPointer('/data/access_token', 'expires_in')).toBe('/data/expires_in');
    expect(siblingPointer('/access_token', 'expires_in')).toBe('/expires_in');
    expect(siblingPointer('', 'expires_in')).toBe('/expires_in');
  });
});

test.describe('validating definitions', () => {
  test('accepts the default and returns only known fields', () => {
    const result = validateRequestOutputs({ ...defaultRequestOutputs(), extra: true });
    expect(result).toEqual({ ok: true, outputs: defaultRequestOutputs() });
  });

  for (const [label, value, message] of [
    ['a bad name', { values: [{ name: 'api-token', source: { kind: 'body' } }] }, /must start with a letter/],
    ['a built-in name', { values: [{ name: 'uuid', source: { kind: 'body' } }] }, /built-in variable/],
    ['a duplicate name', { values: [{ name: 'a', source: { kind: 'body' } }, { name: 'a', source: { kind: 'body' } }] }, /used twice/],
    ['no values while on', { values: [] }, /at least one output/],
    ['too many values', { values: Array.from({ length: 11 }, (_, index) => ({ name: `v${index}`, source: { kind: 'body' } })) }, /at most 10/],
    ['zero seconds', { refreshAfterSeconds: 0 }, /whole number of seconds/],
    ['fractional seconds', { refreshAfterSeconds: 1.5 }, /whole number of seconds/],
    ['too many seconds', { refreshAfterSeconds: 31_536_001 }, /whole number of seconds/],
    ['a bad pointer', { values: [{ name: 'a', source: { kind: 'json', pointer: 'a' } }] }, /must start with/],
    ['a bad expiry pointer', { expiresInPointer: 'expires_in' }, /must start with/],
    ['a bad header name', { values: [{ name: 'a', source: { kind: 'header', name: 'X Token' } }] }, /valid response header/],
    ['an unknown source', { values: [{ name: 'a', source: { kind: 'cookie' } }] }, /unknown source/],
  ] as const) {
    test(`refuses ${label}`, () => {
      const result = validateRequestOutputs({ ...defaultRequestOutputs(), ...value });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(message);
    });
  }

  test('allows no values while off and keeps rows when turned off', () => {
    expect(validateRequestOutputs({ ...defaultRequestOutputs(), enabled: false, values: [] }).ok).toBe(true);
    const off = validateRequestOutputs({ ...defaultRequestOutputs(), enabled: false });
    expect(off.ok && off.outputs.values).toEqual(defaultRequestOutputs().values);
  });

  test('refuses non-objects', () => {
    expect(validateRequestOutputs(null).ok).toBe(false);
    expect(validateRequestOutputs('outputs').ok).toBe(false);
  });
});

test.describe('extracting values', () => {
  test('reads JSON fields, headers and the whole body', () => {
    const definition = outputs({
      values: [
        { name: 'api_token', source: { kind: 'json', pointer: '/data/access_token' } },
        { name: 'session', source: { kind: 'header', name: 'x-session' } },
      ],
      expiresInPointer: '/data/expires_in',
    });
    const response = {
      status: 201,
      headers: [{ key: 'X-Session', value: ' s-1 ', enabled: true }],
      bodyText: JSON.stringify({ data: { access_token: 'tok-{{x}}', expires_in: '600' } }),
    };
    expect(extractOutputValues(response, definition)).toEqual({ ok: true, values: { api_token: 'tok-{{x}}', session: 's-1' }, expiresInSeconds: 600 });
    expect(extractOutputValues({ status: 200, headers: [], bodyText: '  raw-token \n' }, outputs({ values: [{ name: 't', source: { kind: 'body' } }] })))
      .toEqual({ ok: true, values: { t: 'raw-token' } });
  });

  test('a header-only definition needs no body', () => {
    const definition = outputs({ values: [{ name: 't', source: { kind: 'header', name: 'authorization' } }] });
    expect(extractOutputValues({ status: 204, headers: [{ key: 'Authorization', value: 'abc', enabled: true }], bodyText: null }, definition))
      .toEqual({ ok: true, values: { t: 'abc' } });
  });

  test('ignores an unusable expiry and never fails because of it', () => {
    for (const expires of [0, -5, 1.5, 'soon', null, { seconds: 3 }]) {
      const result = extractOutputValues(jsonResponse({ access_token: 'a', expires_in: expires }), outputs());
      expect(result).toEqual({ ok: true, values: { api_token: 'a' } });
    }
    expect(extractOutputValues(jsonResponse({ access_token: 'a' }), outputs({ expiresInPointer: null }))).toEqual({ ok: true, values: { api_token: 'a' } });
  });

  test('a non-2xx status is TOKEN_SOURCE_HTTP and names the request', () => {
    const result = extractOutputValues(jsonResponse({ access_token: 'secret-value' }, 403), outputs(), 'Get session token');
    expect(result).toEqual({ ok: false, code: 'TOKEN_SOURCE_HTTP', message: 'Couldn\'t get {{api_token}}: "Get session token" returned HTTP 403.' });
  });

  for (const [label, body, message] of [
    ['a missing field', { other: 1 }, /JSON field "\/access_token" is missing/],
    ['a number', { access_token: 5 }, /is a number, not text/],
    ['an object', { access_token: { value: 'x' } }, /is an object, not text/],
    ['an empty string', { access_token: '   ' }, /is empty/],
    ['control characters', { access_token: 'a\r\nInjected: 1' }, /control characters/],
    ['an oversized value', { access_token: 'x'.repeat(65_537) }, /longer than 65,536/],
  ] as const) {
    test(`${label} is TOKEN_EXTRACT_FAILED without the value`, () => {
      const result = extractOutputValues(jsonResponse(body), outputs());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('TOKEN_EXTRACT_FAILED');
        expect(result.message).toMatch(message);
        expect(result.message).not.toContain('Injected');
        expect(result.message.length).toBeLessThan(300);
      }
    });
  }

  test('invalid JSON and a missing body', () => {
    const bad = extractOutputValues({ status: 200, headers: [], bodyText: '<html>' }, outputs());
    expect(bad).toMatchObject({ ok: false, code: 'TOKEN_EXTRACT_FAILED' });
    const none = extractOutputValues({ status: 200, headers: [], bodyText: null }, outputs());
    expect(none).toMatchObject({ ok: false, code: 'TOKEN_SOURCE_NOT_TEXT' });
  });
});

test('freshness interval', () => {
  expect(computeOutputTtlMs(3600)).toBe(3_600_000);
  expect(computeOutputTtlMs(3600, 600)).toBe(570_000);
  expect(computeOutputTtlMs(3600, 7200)).toBe(3_600_000);
  expect(computeOutputTtlMs(3600, 0)).toBe(3_600_000);
  expect(computeOutputTtlMs(3600, 100)).toBe(90_000);
  expect(computeOutputTtlMs(3600, 1)).toBe(1000);
  expect(computeOutputTtlMs(1)).toBe(1000);
});

test.describe('withholding a token response', () => {
  const response: ResponseV2 = {
    version: 2, id: 'r', requestId: 'q', status: 200, statusText: 'OK',
    headers: [{ key: 'X-Session', value: 's', enabled: true }, { key: 'Content-Type', value: 'application/json', enabled: true }],
    preview: { kind: 'text', format: 'json', text: '{"access_token":"tok-secret-1"}', parseState: 'valid', charset: 'utf-8', decodeError: false, capturedBytes: 22, totalBytes: 22, truncated: false, completeness: 'complete' },
    timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 }, timestamp: 1, size: 22, cookies: [],
    outputsNote: { kind: 'updated', names: ['api_token'] },
  };

  test('drops the body and header sources and survives the snapshot converters', () => {
    const definition = outputs({ values: [...defaultRequestOutputs().values, { name: 'session', source: { kind: 'header', name: 'x-session' } }] });
    const withheld = withholdOutputsBody(response, definition);
    expect(withheld.preview.kind).toBe('empty');
    expect(withheld.headers.map(header => header.key)).toEqual(['Content-Type']);
    expect(JSON.stringify(withheld)).not.toContain('tok-secret-1');
    const persisted = toPersistedResponseV2(withheld);
    expect(persisted.bodyWithheld).toBe('outputs');
    expect(persisted.outputsNote).toEqual({ kind: 'updated', names: ['api_token'] });
    expect(toRendererResponseV2(persisted).bodyWithheld).toBe('outputs');
  });

  test('the converters drop malformed notes', () => {
    const persisted = toPersistedResponseV2({ ...response, outputsNote: { kind: 'updated', names: 'api_token' }, bodyWithheld: 'yes' } as never);
    expect(persisted.outputsNote).toBeUndefined();
    expect(persisted.bodyWithheld).toBeUndefined();
    expect(toPersistedResponseV2({ ...response, outputsNote: { kind: 'not-updated', message: 'HTTP 403' } }).outputsNote)
      .toEqual({ kind: 'not-updated', message: 'HTTP 403' });
  });
});

test.describe('outputs as a variable layer', () => {
  test('a literal output value is not expanded, is sensitive, and beats an environment value', () => {
    const context = createVariableContext([], builtIns, new Set(), [
      [{ key: 'api_token', value: 'pasted-by-hand' }, { key: 'x', value: 'expanded' }],
      buildOutputLayer(['api_token'], () => 'tok-{{x}}'),
    ]);
    expect(context.resolve('Bearer {{api_token}}')).toMatchObject({ value: 'Bearer tok-{{x}}', sensitive: true, dependencies: ['api_token'], missing: [] });
  });

  test('observeDependencies reports nested keys', () => {
    const seen = new Set<string>();
    const context = observeDependencies(createVariableContext([], builtIns, new Set(), [
      [{ key: 'auth', value: 'Bearer {{api_token}}' }],
      buildOutputLayer(['api_token', 'unused'], () => OUTPUT_PLACEHOLDER),
    ]), keys => keys.forEach(key => seen.add(key)));
    expect(context.interpolateString('{{auth}}')).toBe(`Bearer ${OUTPUT_PLACEHOLDER}`);
    expect([...seen].sort()).toEqual(['api_token', 'auth']);
  });

  test('the placeholder is non-empty and contains no variable syntax', () => {
    expect(OUTPUT_PLACEHOLDER.trim()).not.toBe('');
    expect(OUTPUT_PLACEHOLDER).not.toContain('{{');
  });
});
