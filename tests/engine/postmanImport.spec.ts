import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertPostmanExport } from '../../src/main/stores/postmanImport';
import { CollectionStore } from '../../src/main/stores/collectionStore';

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const collection = {
  info: { name: 'Shop', schema },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  variable: [{ key: 'base', value: 'https://example.test' }],
  event: [{ listen: 'prerequest', script: { exec: ['doSomething()'] } }],
  item: [{ name: 'Orders', item: [{ name: 'Create', request: {
    method: 'POST', url: { raw: '{{base}}/orders?q=one', query: [{ key: 'q', value: 'one' }, { key: 'off', value: 'x', disabled: true }] },
    header: [{ key: 'X-Test', value: 'yes' }],
    body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: '/tmp/image.png' }, { key: 'caption', value: 'hello', disabled: true }] },
  } }] }],
};

test('converts hierarchy, inherited auth, query and binary form without duplicating URL query', () => {
  const result = convertPostmanExport(collection)!;
  expect(result.bundle.groups.map(g => g.name)).toEqual(['Shop', 'Orders']);
  const request = result.bundle.requests[0];
  expect(request.url).toBe('{{base}}/orders');
  expect(request.parameters).toEqual([{ key: 'q', value: 'one', enabled: true }, { key: 'off', value: 'x', enabled: false }]);
  expect(request.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}', prefix: 'Bearer' } });
  expect(request.body).toEqual({ type: 'multipart', multipart: [{ key: 'file', type: 'file', value: '/tmp/image.png', filePath: '/tmp/image.png', enabled: true }, { key: 'caption', type: 'text', value: 'hello', enabled: false }] });
  expect(result.environments[0].variables).toEqual([{ key: 'base', value: 'https://example.test', type: 'standard' }]);
  expect(result.warnings.join(' ')).toContain('scripts');
  expect(result.warnings.join(' ')).toContain('select it');
});

test('imports Postman collection and separate environment through the store', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'postman-import-'));
  try {
    const store = new CollectionStore(directory);
    await store.init();
    const result = await store.importBundle(collection);
    expect(result).toMatchObject({ groups: 2, requests: 1, environments: 1 });
    const envResult = await store.importBundle({ name: 'Staging', _postman_variable_scope: 'environment', values: [
      { key: 'token', value: 'secret', type: 'secret', enabled: true }, { key: 'ignored', value: 'x', enabled: false },
    ] });
    expect(envResult).toMatchObject({ groups: 0, requests: 0, environments: 1 });
    expect(envResult.warnings.join(' ')).toContain('Disabled');
    expect((await store.listEnvironments()).find(e => e.name === 'Staging')?.variables).toEqual([{ key: 'token', value: 'secret', type: 'secret' }]);
    expect((await store.listAll()).find(item => item.name === 'Create')).toBeTruthy();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('rejects unsupported schema and malformed exports without mutation', async () => {
  expect(() => convertPostmanExport({ info: { schema: schema.replace('v2.1.0', 'v2.0.0') }, item: [] })).toThrow('v2.1');
  expect(() => convertPostmanExport({ info: { schema }, item: {} })).toThrow('items list');
  expect(() => convertPostmanExport({ _postman_variable_scope: 'environment' })).toThrow('variables list');
  expect(convertPostmanExport({ hello: 'world' })).toBeNull();
});

test('preserves Postman OAuth2 grants, token endpoint, Basic auth, and redirect URI', () => {
  const result = convertPostmanExport({
    info: { name: 'OAuth', schema },
    item: [
      { name: 'Client credentials', request: { method: 'GET', url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'accessTokenUrl', value: 'https://issuer.example.test/token' },
        { key: 'clientId', value: 'client' },
        { key: 'clientSecret', value: 'secret' },
      ] } } },
      { name: 'PKCE', request: { method: 'GET', url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [
        { key: 'grant_type', value: 'authorization_code_with_pkce' },
        { key: 'authUrl', value: 'https://issuer.example.test/authorize' },
        { key: 'accessTokenUrl', value: 'https://issuer.example.test/token' },
        { key: 'clientId', value: 'client' },
        { key: 'clientSecret', value: 'secret' },
        { key: 'scope', value: 'read write' },
        { key: 'client_authentication', value: 'header' },
        { key: 'redirect_uri', value: 'http://127.0.0.1:42813/callback' },
      ] } } },
    ],
  })!;
  expect(result.bundle.requests.map(request => request.auth)).toEqual([
    { type: 'oauth2', oauth2: { grantType: 'client_credentials', authorizationUrl: '', tokenUrl: 'https://issuer.example.test/token', clientId: 'client', clientSecret: 'secret', scope: '', redirectUri: '' } },
    { type: 'oauth2', oauth2: { grantType: 'pkce', authorizationUrl: 'https://issuer.example.test/authorize', tokenUrl: 'https://issuer.example.test/token', clientId: 'client', clientSecret: 'secret', scope: 'read write', redirectUri: 'http://127.0.0.1:42813/callback', clientAuthentication: 'basic' } },
  ]);
});
