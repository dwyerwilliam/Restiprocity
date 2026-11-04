import { expect, test } from '@playwright/test';
import type { Session } from 'electron';
import { buildCurlCommand, shellQuote } from '../../src/shared/curlExport';
import { buildRequestFromCurl } from '../../src/shared/curlImport';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import type { CollectionStore } from '../../src/main/stores/collectionStore';
import type { Environment, Request } from '../../src/shared/types';

const now = 1_700_000_000_000;

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'curl-request', name: 'cURL request', method: 'GET', url: 'https://api.example.test/items',
    headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
    settings: { followRedirect: false, timeout: 0, cookiesEnabled: true }, scripts: {}, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

test('shellQuote survives single quotes, newlines and shell metacharacters', () => {
  expect(shellQuote(`it's $HOME `)).toBe(`'it'\\''s $HOME '`);
  expect(shellQuote('a\nb')).toBe(`'a\nb'`);
});

test('a GET carries the URL, the engine User-Agent and enabled headers only', () => {
  const { command, warnings } = buildCurlCommand(makeRequest({
    headers: [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Disabled', value: 'no', enabled: false },
      { key: 'User-Agent', value: 'overwritten-by-engine', enabled: true },
    ],
  }), { url: 'https://api.example.test/items?page=2' });

  expect(command).toBe([
    `curl 'https://api.example.test/items?page=2'`,
    `-A 'Restiprocity'`,
    `-H 'Accept: application/json'`,
  ].join(' \\\n  '));
  expect(warnings).toEqual([]);
});

test('settings map to -X, -L, -k, -m and --head; GET and HEAD never carry a body', () => {
  const post = buildCurlCommand(makeRequest({
    method: 'POST',
    settings: { followRedirect: true, timeout: 2500, allowInsecureCertificates: true, userAgent: ' custom/1 ' },
  }), { url: 'https://x.test/' }).command;
  expect(post.startsWith(`curl -X POST 'https://x.test/'`)).toBe(true);
  expect(post).toContain(`-A 'custom/1'`);
  expect(post).toContain('-L');
  expect(post).toContain('-k');
  expect(post).toContain('-m 2.5');

  const head = buildCurlCommand(makeRequest({ method: 'HEAD', body: { type: 'raw', raw: { language: 'text', content: 'x' } } }), { url: 'https://x.test/' }).command;
  expect(head.startsWith(`curl --head 'https://x.test/'`)).toBe(true);
  expect(head).not.toContain('--data');
});

test('auth headers overwrite authored ones the way the engine does', () => {
  const authored = [{ key: 'authorization', value: 'stale', enabled: true }];
  const bearer = buildCurlCommand(makeRequest({ headers: authored, auth: { type: 'bearer', bearer: { token: 'tok', prefix: '' } } }), { url: 'u' }).command;
  expect(bearer).toContain(`-H 'Authorization: Bearer tok'`);
  expect(bearer).not.toContain('stale');

  const basic = buildCurlCommand(makeRequest({ auth: { type: 'basic', basic: { username: 'ü', password: 'p:w' } } }), { url: 'u' }).command;
  expect(basic).toContain(`-H 'Authorization: Basic ${Buffer.from('ü:p:w').toString('base64')}'`);

  const apiKey = buildCurlCommand(makeRequest({ auth: { type: 'api_key', api_key: { key: 'X-Key', value: 'k', in: 'header' } } }), { url: 'u' }).command;
  expect(apiKey).toContain(`-H 'X-Key: k'`);

  expect(buildCurlCommand(makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } } }), { url: 'u' }).command)
    .toContain(`--ntlm \\\n  -u ':'`);
  expect(buildCurlCommand(makeRequest({ auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: false, domain: 'CORP', username: 'me', password: 'pw' } } }), { url: 'u' }).command)
    .toContain(`-u 'CORP\\me:pw'`);
});

test('OAuth 2.0 uses only a cached token and says so when there is none', () => {
  const oauth2 = { grantType: 'client_credentials', authorizationUrl: '', tokenUrl: 'https://t', clientId: 'c', clientSecret: 's', scope: '', redirectUri: '' } as const;
  const withToken = buildCurlCommand(makeRequest({ auth: { type: 'oauth2', oauth2 } }), { url: 'u', oauth2AccessToken: 'cached' });
  expect(withToken.command).toContain(`-H 'Authorization: Bearer cached'`);
  expect(withToken.warnings).toEqual([]);

  const without = buildCurlCommand(makeRequest({ auth: { type: 'oauth2', oauth2 } }), { url: 'u' });
  expect(without.command).not.toContain('Authorization');
  expect(without.warnings[0]).toContain('No cached OAuth 2.0 token');

  const pkce = buildCurlCommand(makeRequest({ auth: { type: 'oauth2', oauth2: { ...oauth2, grantType: 'pkce' } } }), { url: 'u' });
  expect(pkce.warnings[0]).toContain('other than Client Credentials');
});

test('bodies serialize like the engine: raw verbatim, form as URLSearchParams, multipart literal text and files', () => {
  const raw = buildCurlCommand(makeRequest({ method: 'POST', body: { type: 'raw', raw: { language: 'json', content: `{"name":"O'Brien"}` } } }), { url: 'u' });
  expect(raw.command).toContain(`--data-raw '{"name":"O'\\''Brien"}'`);
  expect(raw.warnings[0]).toContain('No Content-Type header');
  const typed = buildCurlCommand(makeRequest({ method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: { type: 'raw', raw: { language: 'json', content: '{}' } } }), { url: 'u' });
  expect(typed.warnings).toEqual([]);

  const form = buildCurlCommand(makeRequest({ method: 'POST', body: { type: 'form-urlencoded', form: [
    { key: 'q', value: 'a b&c', enabled: true }, { key: 'skip', value: '1', enabled: false },
  ] } }), { url: 'u' }).command;
  expect(form).toContain(`--data-raw 'q=a+b%26c'`);

  const multipart = buildCurlCommand(makeRequest({ method: 'POST', body: { type: 'multipart', multipart: [
    { key: 'note', type: 'text', value: '@not-a-file', enabled: true },
    { key: 'upload', type: 'file', value: '', filePath: 'C:\\data\\a "b".bin', enabled: true },
  ] } }), { url: 'u' }).command;
  expect(multipart).toContain(`--form-string 'note=@not-a-file'`);
  expect(multipart).toContain(`-F 'upload=@"C:\\\\data\\\\a \\"b\\".bin";type=application/octet-stream'`);
});

test('the exported command imports back to the same request', () => {
  const original = makeRequest({
    method: 'PUT', url: 'https://api.example.test/items/7',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: { type: 'raw', raw: { language: 'json', content: '{"done":true}' } },
    settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true, allowInsecureCertificates: true },
  });
  const imported = buildRequestFromCurl(buildCurlCommand(original, { url: original.url }).command, () => 'id');
  expect(imported).toMatchObject({
    method: 'PUT', url: original.url, body: original.body,
    settings: { followRedirect: true, timeout: 5000, allowInsecureCertificates: true },
  });
  expect(imported.headers).toEqual(expect.arrayContaining([{ key: 'Content-Type', value: 'application/json', enabled: true }]));
});

test('RequestEngine.exportCurl interpolates environment variables and merges query parameters without sending', async () => {
  const environment: Environment = { id: 'dev', name: 'Dev', variables: [{ key: 'host', value: 'dev.test', type: 'standard' }, { key: 'token', value: 'sekret', type: 'secret' }], createdAt: now, updatedAt: now };
  let fetches = 0;
  const engine = new RequestEngine({} as Session, {
    getActiveEnvironmentId: () => 'dev',
    getEnvironment: async (id: string) => (id === 'dev' ? environment : null),
  } as unknown as CollectionStore, {
    fetch: async () => { fetches += 1; throw new Error('no network'); },
    netRequest: () => { fetches += 1; throw new Error('no network'); },
  });

  const { command } = await engine.exportCurl({ request: makeRequest({
    url: 'https://{{host}}/items',
    parameters: [{ key: 'q', value: '{{token}}', enabled: true }],
    auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials', authorizationUrl: '', tokenUrl: 'https://t', clientId: 'c', clientSecret: 's', scope: '', redirectUri: '' } },
  }) });

  expect(command).toContain(`'https://dev.test/items?q=sekret'`);
  expect(fetches).toBe(0);
});
