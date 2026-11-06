import { expect, test } from '@playwright/test';
import type { Request } from '../../src/shared/types';
import { createVariableContext } from '../../src/shared/variableContext';

const builtIns = {
  timestamp: 1793000000123,
  randomInt: 999999,
  uuid: '40c80b6a-2cf9-4ca9-899c-7409276639c4',
} as const;
const tokens = '{{uuid}}/{{ timestamp }}/_.randomInt';
const expanded = `${builtIns.uuid}/${builtIns.timestamp}/${builtIns.randomInt}`;

test.describe('shared expansion identity', () => {
  test('expands every request field with one identity when inherited variables include a child override', () => {
    const variables: [string, string][] = [['host', 'parent.test'], ['host', 'child.test']];
    const context = createVariableContext(variables, builtIns);
    const request: Request = {
      id: 'request', name: 'Request', method: 'POST', url: `https://_.host/${tokens}`,
      headers: [{ key: '{{uuid}}', value: tokens, enabled: true }],
      parameters: [{ key: '{{uuid}}', value: tokens, enabled: true }],
      body: {
        type: 'raw', raw: { language: 'text', content: tokens },
        form: [{ key: '{{uuid}}', value: tokens, enabled: true }],
        multipart: [{ key: '{{uuid}}', value: tokens, filePath: tokens, type: 'file', enabled: true }],
      },
      auth: {
        type: 'bearer', bearer: { token: tokens, prefix: '{{uuid}}' },
        basic: { username: tokens, password: tokens },
        api_key: { key: tokens, value: tokens, in: 'query' },
        oauth2: { grantType: 'client_credentials', authorizationUrl: tokens, tokenUrl: tokens,
          clientId: tokens, clientSecret: tokens, scope: tokens, redirectUri: tokens },
        ntlm: { username: tokens, password: tokens, domain: tokens, workstation: tokens },
      },
      settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
      scripts: {}, createdAt: 1, updatedAt: 2,
    };
    const original = structuredClone(request);
    const expected = {
      ...original, url: `https://child.test/${expanded}`,
      headers: [{ key: builtIns.uuid, value: expanded, enabled: true }],
      parameters: [{ key: builtIns.uuid, value: expanded, enabled: true }],
      body: {
        type: 'raw', raw: { language: 'text', content: expanded },
        form: [{ key: builtIns.uuid, value: expanded, enabled: true }],
        multipart: [{ key: builtIns.uuid, value: expanded, filePath: expanded, type: 'file', enabled: true }],
      },
      auth: {
        type: 'bearer', bearer: { token: expanded, prefix: builtIns.uuid },
        basic: { username: expanded, password: expanded },
        api_key: { key: expanded, value: expanded, in: 'query' },
        oauth2: { grantType: 'client_credentials', authorizationUrl: expanded, tokenUrl: expanded,
          clientId: expanded, clientSecret: expanded, scope: expanded, redirectUri: expanded },
        ntlm: { username: expanded, password: expanded, domain: expanded, workstation: expanded },
      },
    };

    const result = context.interpolate(request);

    expect(result).toEqual(expected);
    expect(request).toEqual(original);
    expect(result.body).not.toBe(request.body);
    expect(result.headers).not.toBe(request.headers);
  });

  test('expands built-ins when the environment is empty', () => {
    const context = createVariableContext([], { ...builtIns, randomInt: 0 });

    const result = context.interpolateString('{{uuid}} {{uuid}} {{timestamp}} {{randomInt}}');

    expect(result).toBe(`${builtIns.uuid} ${builtIns.uuid} ${builtIns.timestamp} 0`);
  });

  test('isolates contexts when caller inputs change', () => {
    const variables = new Map([['host', 'original.test']]);
    const injected = { ...builtIns, uuid: 'original' };
    const original = createVariableContext(variables, injected);
    variables.set('host', 'next.test');
    injected.uuid = 'next';
    const next = createVariableContext(variables, injected);

    const results = [original.interpolateString('{{host}}/{{uuid}}'), next.interpolateString('{{host}}/{{uuid}}')];

    expect(results).toEqual(['original.test/original', 'next.test/next']);
  });
});

test.describe('unknown tokens and reserved collisions', () => {
  test('reserves built-ins when inherited variables collide', () => {
    const context = createVariableContext([
      ['timestamp', 'wrong-time'], ['randomInt', 'wrong-random'], ['uuid', 'wrong-uuid'],
    ], builtIns);

    const result = context.interpolateString(tokens);

    expect(result).toBe(expanded);
  });

  test('preserves unknown and malformed tokens when whitespace and shorthand occur', () => {
    const context = createVariableContext([['empty', ''], ['key-with.dots', 'value']], builtIns);

    const result = context.interpolateString('{{ absent }}|{{}}|{{two words}}|{{unfinished|_.absent|{{ empty }}|{{ key-with.dots }}|{{toString}}');

    expect(result).toBe('{{ absent }}|{{}}|{{two words}}|{{unfinished|_.absent||value|{{toString}}');
    expect(context.interpolateString('https://_.absent/_.uuid')).toBe(`https://{{absent}}/${builtIns.uuid}`);
  });

  test('resolves nested variables and shared built-ins with sensitive provenance', () => {
    const context = createVariableContext([
      ['host', 'example.test'], ['base', 'https://{{host}}'], ['path', '{{base}}/{{uuid}}/{{uuid}}'],
      ['secret', 'fixture-value'], ['derived', 'Bearer {{secret}}'],
    ], builtIns, new Set(['secret']));
    expect(context.interpolateString('{{path}}')).toBe('https://example.test/' + builtIns.uuid + '/' + builtIns.uuid);
    expect(context.resolve('{{derived}}')).toMatchObject({ value: 'Bearer fixture-value', sensitive: true });
    expect(context.resolve('{{missing}}').missing).toEqual(['missing']);
  });

  test('reports cycles and limits only when referenced', () => {
    const context = createVariableContext([['first', '{{second}}'], ['second', '{{first}}'], ['ok', 'ok']], builtIns);
    expect(context.interpolateString('{{ok}}')).toBe('ok');
    expect(() => context.interpolateString('{{first}}')).toThrow('Interpolation error: circular');
    expect(context.interpolateString('x'.repeat(1024 * 1024 + 1))).toHaveLength(1024 * 1024 + 1);
    expect(() => context.interpolateString('x'.repeat(1024 * 1024) + '{{ok}}')).toThrow('exceeds 1 MiB');
    expect(context.interpolateString('x'.repeat(1024 * 1024 - 2) + '{{ok}}')).toHaveLength(1024 * 1024);
    expect(() => context.interpolateString('é'.repeat(524288) + '{{ok}}')).toThrow('exceeds 1 MiB');
    const chain: [string, string][] = Array.from({ length: 66 }, (_, i) => ['k' + i, i === 65 ? 'end' : '{{k' + (i + 1) + '}}']);
    expect(() => createVariableContext(chain, builtIns).interpolateString('{{k0}}')).toThrow('64 levels');
  });
});

test('layered self references use nearest parent and preserve secret provenance', () => {
  const layers = [
    [{ key: 'base', value: 'https://{{host}}', type: 'secret' }, { key: 'host', value: 'parent' }],
    [{ key: 'base', value: '{{base}}/staging' }, { key: 'host', value: 'child' }],
    [{ key: 'base', value: '{{base}}/v2' }],
  ];
  const context = createVariableContext([], builtIns, new Set(), layers);
  expect(context.resolve('{{base}}')).toMatchObject({ value: 'https://child/staging/v2', sensitive: true });
  expect(() => createVariableContext([], builtIns, new Set(), [[{ key: 'x', value: '{{x}}' }]]).resolve('{{x}}')).toThrow('circular');
  const cycle = createVariableContext([], builtIns, new Set(), [[{ key: 'a', value: 'parent' }], [{ key: 'a', value: '{{b}}' }, { key: 'b', value: '{{a}}' }]]);
  expect(() => cycle.resolve('{{a}}')).toThrow('circular');
});
