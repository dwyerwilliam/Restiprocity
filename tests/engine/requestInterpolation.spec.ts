import { test, expect } from '@playwright/test';
import { createVariableContext } from '../../src/shared/variableContext';
import { resolveRequestFields, resolveUrlFields } from '../../src/shared/requestInterpolation';
import { buildCurlCommand } from '../../src/shared/curlExport';
import { composeRequestUrl } from '../../src/shared/urlVariables';
import type { Request } from '../../src/shared/types';

const request = (patch: Partial<Request> = {}): Request => ({
  id: 'id', name: '{{bad}}', method: 'POST', url: 'https://example.test', headers: [], parameters: [],
  body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 1000 },
  scripts: { preRequest: '{{bad}}' }, createdAt: 0, updatedAt: 0, ...patch,
});
const context = () => createVariableContext([['bad', '{{bad}}'], ['empty', ''], ['path', 'fixture.txt'], ['secret', 'private']],
  { timestamp: 0, randomInt: 0, uuid: 'id' }, new Set(['secret']));
const bad = { key: 'x', value: '{{bad}}', enabled: true };

test('unused fields remain in the authored request and cannot block transport', () => {
  const input = request({ method: 'GET', headers: [{ ...bad, enabled: false }], parameters: [{ ...bad, enabled: false }],
    body: { type: 'raw', raw: { language: 'text', content: '{{bad}}' } }, auth: { type: 'none', bearer: { token: '{{bad}}', prefix: '' } } });
  const original = structuredClone(input);
  expect(resolveRequestFields(input, context()).headers).toEqual([]);
  expect(input).toEqual(original);
  expect(() => resolveRequestFields({ ...input, headers: [bad] }, context())).toThrow('circular');
});

test('header precedence excludes replaced values before interpolation', () => {
  const input = request({ headers: [{ ...bad, key: 'User-Agent' }, bad, { key: 'X', value: 'winner', enabled: true }, { ...bad, key: 'Authorization' }], auth: { type: 'bearer', bearer: { token: 'token', prefix: 'Bearer' } } });
  const resolved = resolveRequestFields(input, context());
  expect(resolved.headers).toEqual([{ key: 'X', value: 'winner', enabled: true }]);
  expect(buildCurlCommand(resolved, { url: resolved.url }).command).toContain('Bearer token');
});

test('query keys are trimmed after resolution; form empty keys still consume values', () => {
  const input = request({ parameters: [{ ...bad, key: ' ' }, { ...bad, key: '{{empty}}' }] });
  const resolved = resolveRequestFields(input, context());
  expect(composeRequestUrl(resolved.url, resolved.parameters)).toBe(input.url);
  expect(() => resolveRequestFields(request({ body: { type: 'form-urlencoded', form: [{ ...bad, key: '' }] } }), context())).toThrow('circular');
});

test('auth resolves only fields consumed by the selected mode', () => {
  for (const auth of [
    { type: 'bearer' as const, bearer: { token: '', prefix: '{{bad}}' } },
    { type: 'basic' as const, basic: { username: '', password: '{{bad}}' } },
    { type: 'api_key' as const, api_key: { key: '', value: '{{bad}}', in: 'header' as const } },
    { type: 'ntlm' as const, ntlm: { useCurrentAuthContext: false, username: 'user', password: 'pass', workstation: '{{bad}}' } },
  ]) expect(() => resolveRequestFields(request({ auth }), context())).not.toThrow();
  const input = request({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: false, username: '', password: '{{bad}}' } } });
  expect(() => resolveRequestFields(input, context())).not.toThrow();
  expect(() => resolveRequestFields(input, context(), { operation: 'curl' })).toThrow('circular');
});

test('OAuth cURL header precedence depends on cached token availability', () => {
  const input = request({ headers: [{ ...bad, key: 'Authorization' }], auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials', tokenUrl: 'https://example.test/token', clientId: 'id', clientSecret: 'secret', scope: '', authorizationUrl: '{{bad}}', redirectUri: '{{bad}}' } } });
  expect(() => resolveRequestFields(input, context())).not.toThrow();
  expect(() => resolveRequestFields(input, context(), { operation: 'curl', hasOAuthToken: () => true })).not.toThrow();
  expect(() => resolveRequestFields(input, context(), { operation: 'curl', hasOAuthToken: () => false })).toThrow('circular');
});

test('multipart resolves fallback only when the preferred path resolves empty', () => {
  const input = request({ body: { type: 'multipart', multipart: [{ key: 'upload', type: 'file', enabled: true, filePath: '{{empty}}', value: '{{path}}' }] } });
  const resolved = resolveRequestFields(input, context());
  expect(resolved.body.multipart?.[0].value).toBe('fixture.txt');
  expect(buildCurlCommand(resolved, { url: resolved.url }).command).toContain('@"fixture.txt"');
  input.body.multipart![0] = { ...input.body.multipart![0], filePath: '{{path}}', value: '{{bad}}' };
  expect(() => resolveRequestFields(input, context())).not.toThrow();
});

test('URL preview excludes inactive auth errors and secrets, but masks consumed secrets', () => {
  const input = request({ parameters: [{ ...bad, key: '{{empty}}' }], auth: { type: 'api_key', api_key: { key: 'key', value: 'ok', in: 'query' }, bearer: { token: '{{bad}}', prefix: '{{secret}}' } } });
  const resolved = resolveUrlFields(input, context());
  expect(resolved.sensitive).toBe(false);
  expect(composeRequestUrl(resolved.url, resolved.parameters, resolved.auth)).toBe(input.url + '?key=ok');
  input.auth.api_key!.value = '{{secret}}';
  expect(resolveUrlFields(input, context()).sensitive).toBe(true);
});


test('multipart managed headers do not resolve discarded values', () => {
  const input = request({ body: { type: 'multipart', multipart: [] }, headers: [
    { key: 'Content-Type', value: '{{bad}}', enabled: true },
    { key: 'CONTENT-LENGTH', value: '{{bad}}', enabled: true },
    { key: 'Transfer-Encoding', value: '{{bad}}', enabled: true },
    { key: 'X-Keep', value: 'ok', enabled: true },
  ], auth: { type: 'api_key', api_key: { key: 'content-type', value: '{{bad}}', in: 'header' } } });
  const original = structuredClone(input);
  for (const operation of ['send', 'curl'] as const) {
    const result = resolveRequestFields(input, context(), { operation });
    expect(result.headers).toEqual([{ key: 'X-Keep', value: 'ok', enabled: true }]);
    expect(result.auth.api_key?.value).toBe('');
  }
  expect(input).toEqual(original);
  expect(() => resolveRequestFields({ ...input, method: 'GET' }, context())).toThrow('circular');
});
