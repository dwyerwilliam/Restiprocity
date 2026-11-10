import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCollectionFile } from '../../src/main/ipc/collectionFileActions';
import { parseCollectionExportBundle } from '../../src/main/stores/collectionExport';
import { convertOpenApiDocument, type OpenApiConversion } from '../../src/main/stores/openapiImport';
import { composeRequestUrl } from '../../src/shared/urlVariables';

const fixtures = path.join(__dirname, 'fixtures', 'openapi');
const ok = { '200': { description: 'ok' } };
const doc = (extra: Record<string, unknown>, version = '3.0.3') => ({ openapi: version, info: { title: 'Probe', version: '1' }, servers: [{ url: 'https://api.example.test/v1' }], ...extra });
const post = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ post: { requestBody: { content }, responses: ok, ...extra } });
const convert = (input: unknown): OpenApiConversion => {
  const result = convertOpenApiDocument(input);
  if (!result) throw new Error('not recognized as OpenAPI');
  parseCollectionExportBundle(result.bundle);
  return result;
};
const only = (input: unknown) => convert(input).bundle.requests[0];
const notes = (input: unknown) => convert(input).warnings;
const load = async (name: string) => parseCollectionFile(await fs.readFile(path.join(fixtures, name), 'utf8'));

test('the plan worked example maps to the independently expected request and URL', () => {
  const result = convert({
    openapi: '3.0.3',
    info: { title: 'Pet API', version: '1' },
    servers: [{ url: 'https://api.example.test/v1' }],
    paths: {
      '/pets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'a/b' }],
        get: {
          summary: 'Find pet',
          tags: ['Pets'],
          parameters: [{ name: 'tag', in: 'query', required: true, schema: { type: 'array', items: { type: 'string' } }, example: ['a&b', 'c d'] }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });
  expect(result.bundle.roots).toEqual(['openapi-root']);
  expect(result.bundle.groups).toEqual([
    { id: 'openapi-root', name: 'Pet API', children: ['openapi-group-1'], createdAt: 0, updatedAt: 0 },
    { id: 'openapi-group-1', name: 'Pets', children: ['openapi-request-1'], createdAt: 0, updatedAt: 0 },
  ]);
  expect(result.bundle.requests).toEqual([{
    id: 'openapi-request-1', name: 'Find pet', method: 'GET', url: '{{openapi_server_1}}/pets/a%2Fb',
    headers: [], parameters: [{ key: 'tag', value: 'a&b', enabled: true }, { key: 'tag', value: 'c d', enabled: true }],
    body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 30000 }, scripts: {}, createdAt: 0, updatedAt: 0,
  }]);
  expect(result.environments).toEqual([{ sourceId: 'openapi-environment', name: 'Pet API (OpenAPI)', variables: [{ key: 'openapi_server_1', value: 'https://api.example.test/v1', type: 'standard' }] }]);
  const request = result.bundle.requests[0];
  expect(composeRequestUrl(request.url.replace('{{openapi_server_1}}', 'https://api.example.test/v1'), request.parameters))
    .toBe('https://api.example.test/v1/pets/a%2Fb?tag=a%26b&tag=c%20d');
  expect(result.warnings[0]).toBe('Select "Pet API (OpenAPI)" and review server, parameter, body, and authentication values before sending.');
});

test('project fixtures pass native validation with direct expected values', async () => {
  const basic = convert(await load('basic-3.0.json'));
  expect(basic.bundle.groups.map(group => group.name)).toEqual(['Basic OpenAPI', 'Items']);
  expect(basic.bundle.requests[0]).toMatchObject({ name: 'GET /items/{id}', method: 'GET', url: '{{openapi_server_1}}/items/one' });
  expect(basic.environments[0].variables).toEqual([{ key: 'openapi_server_1', value: 'https://example.invalid/v1', type: 'standard' }]);
  const bodies = convert(await load('bodies-3.1.yaml'));
  expect(bodies.bundle.requests[0]).toMatchObject({ method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], body: { type: 'raw', raw: { language: 'json', content: '{\n  "name": "item"\n}' } } });
  const references = convert(await load('references.json'));
  expect(references.bundle.requests[0].url).toBe('{{openapi_server_1}}/items/x');
  expect(references.environments[0].variables).toEqual([{ key: 'openapi_server_1', value: 'https://example.invalid', type: 'standard' }]);
  const security = convert(await load('security.json'));
  expect(security.bundle.requests[0].auth).toEqual({ type: 'bearer', bearer: { token: '', prefix: 'Bearer' } });
});

test('recognition returns null for other formats and rejects unsupported OpenAPI versions', async () => {
  for (const input of [null, [], 'openapi: 3.0.0', { info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' } }, { _type: 'export' }, Object.create({ openapi: '3.0.0' })]) {
    expect(convertOpenApiDocument(input)).toBeNull();
  }
  expect(() => convertOpenApiDocument({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} })).toThrow('Swagger 2.0 documents are not supported');
  expect(() => convertOpenApiDocument(doc({ paths: {} }, '3.2.0'))).toThrow('this document declares version "3.2.0"');
  expect(() => convertOpenApiDocument({ ...doc({ paths: {} }), openapi: 3 })).toThrow('declares no string version');
  expect(() => convertOpenApiDocument({ openapi: '3.0.3', info: { title: ' ', version: '1' }, paths: {} })).toThrow('string info.title and info.version');
  expect(() => convertOpenApiDocument({ openapi: '3.0.3', info: { title: 'T', version: '1' } })).toThrow('missing its paths object');
  expect(() => convertOpenApiDocument({ openapi: '3.1.0', info: { title: 'Hooks', version: '1' }, webhooks: { ping: { post: { responses: ok } } } })).toThrow('No supported HTTP operations were found');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { trace: { responses: ok } } } }))).toThrow('No supported HTTP operations were found');
  const yaml = parseCollectionFile('\uFEFFopenapi: 3.1.0\ninfo: {title: YAML, version: "1"}\npaths:\n  /a: {get: {responses: {"200": {description: ok}}}}\n');
  expect(convert(yaml).bundle.requests[0].url).toBe('{{openapi_server_1}}/a');
  const json = parseCollectionFile('\uFEFF' + JSON.stringify(doc({ paths: { '/b': { get: { responses: ok } } } })));
  expect(convert(json).bundle.requests[0].url).toBe('{{openapi_server_1}}/b');
  const aliases = parseCollectionFile('openapi: 3.0.3\ninfo: {title: Aliases, version: "1"}\npaths:\n  /a:\n    get: &op\n      summary: Shared\n      responses: {"200": {description: ok}}\n  /b:\n    get: *op\n');
  expect(convert(aliases).bundle.requests.map(request => [request.name, request.url])).toEqual([['Shared', '{{openapi_server_1}}/a'], ['Shared', '{{openapi_server_1}}/b']]);
});

test('folders, names, ordering and IDs are deterministic', () => {
  const result = convert(doc({ paths: {
    '/b': { delete: { tags: ['Zoo', 'Other'], responses: ok }, get: { summary: '  Same  ', tags: ['Zoo'], responses: ok } },
    '/a': { post: { operationId: 'same', responses: ok }, patch: { summary: 'Same', tags: [' '], responses: ok }, 'x-internal': { get: {} } },
  } }));
  expect(result.bundle.requests.map(request => [request.id, request.method, request.name])).toEqual([
    ['openapi-request-1', 'GET', 'Same'], ['openapi-request-2', 'DELETE', 'DELETE /b'], ['openapi-request-3', 'POST', 'same'], ['openapi-request-4', 'PATCH', 'Same'],
  ]);
  expect(result.bundle.groups.map(group => [group.name, group.children])).toEqual([
    ['Probe', ['openapi-group-1', 'openapi-request-3', 'openapi-request-4']],
    ['Zoo', ['openapi-request-1', 'openapi-request-2']],
  ]);
  expect(result.warnings).toContain("Requests with several tags were placed only in their first tag's folder: DELETE /b.");
});

test('paths reject unsafe shapes, dot segments and malformed templates', () => {
  for (const bad of ['pets', '/pets?x=1', '/pets#frag', '/pets\\x', '/pets\u0001', '/pets/..', '/pets/.', '/..', '/a/.%2e', '/a/%2E.', '/a/%2e%2e/b', '/a/../b']) {
    expect(() => convertOpenApiDocument(doc({ paths: { [bad]: { get: { responses: ok } } } })), bad).toThrow('is invalid for import');
  }
  for (const bad of ['/a/{}', '/a/{b', '/a/b}', '/a/{b{c}}']) {
    expect(() => convertOpenApiDocument(doc({ paths: { [bad]: { get: { responses: ok } } } })), bad).toThrow('has an invalid template');
  }
  expect(only(doc({ paths: { '/a/.well-known/%41..b': { get: { responses: ok } } } })).url).toBe('{{openapi_server_1}}/a/.well-known/%41..b');
});

test('path parameters are encoded once or become REPLACE_ME placeholders', () => {
  const parameter = (name: string, extra: Record<string, unknown>) => ({ name, in: 'path', required: true, schema: { type: 'string' }, ...extra });
  const result = convert(doc({ paths: { '/v/{a}/{b}/{c}/{d}/{e}/{f}': { get: { parameters: [
    parameter('a', { example: 'a/b %' }), parameter('b', { example: '%2F' }), parameter('c', { example: 7 }),
    parameter('d', {}), parameter('e', { example: '..' }), parameter('f', { example: 'x/{{tenant}}' }),
  ], responses: ok } } } }));
  expect(result.bundle.requests[0].url).toBe('{{openapi_server_1}}/v/a%2Fb%20%25/%252F/7/{{openapi_path_1_4}}/{{openapi_path_1_5}}/x%2F{{tenant}}');
  expect(result.environments[0].variables.slice(1)).toEqual([{ key: 'openapi_path_1_4', value: 'REPLACE_ME', type: 'standard' }, { key: 'openapi_path_1_5', value: 'REPLACE_ME', type: 'standard' }]);
  expect(result.warnings).toContain('Path parameters without a usable example use REPLACE_ME environment variables; enter URL-encoded values before sending: GET /v/{a}/{b}/{c}/{d}/{e}/{f} (d), GET /v/{a}/{b}/{c}/{d}/{e}/{f} (e).');
  expect(result.warnings).toContain('Some imported values contain {{...}} expressions, which resolve from the selected environment when sending: GET /v/{a}/{b}/{c}/{d}/{e}/{f}.');
  const styled = only(doc({ paths: { '/m/{id}': { get: { parameters: [parameter('id', { style: 'matrix', example: 'x' })], responses: ok } } } }));
  expect(styled.url).toBe('{{openapi_server_1}}/m/{{openapi_path_1_1}}');
  expect(() => convertOpenApiDocument(doc({ paths: { '/m/{id}': { get: { parameters: [parameter('id', { required: false })], responses: ok } } } }))).toThrow('has no required path parameter');
  expect(() => convertOpenApiDocument(doc({ paths: { '/m': { get: { parameters: [parameter('id', {})], responses: ok } } } }))).toThrow('without a matching template');
});

test('servers follow nearest-present precedence, variables, placeholders and base paths', () => {
  const result = convert(doc({
    servers: [{ url: 'https://{host}.example.test:{port}/{base}/', variables: { host: { default: 'API', enum: ['API', 'eu'] }, port: { default: '443' }, base: { default: 'v$&1' }, unused: { enum: [] } } }, { url: 'https://second.example.test' }],
    paths: {
      '/doc': { get: { responses: ok } },
      '/path': { servers: [], get: { responses: ok }, post: { servers: [{ url: 'v2' }], responses: ok } },
      '/op': { get: { servers: [{ url: '/v1' }, { url: 'https://ignored.example.test' }], responses: ok } },
      '/same': { servers: [{ url: 'https://API.example.test/v$&1' }], get: { responses: ok } },
    },
  }));
  expect(result.environments[0].variables).toEqual([
    { key: 'openapi_server_1', value: 'https://api.example.test/v$&1', type: 'standard' },
    { key: 'openapi_server_2', value: 'https://example.invalid', type: 'standard' },
    { key: 'openapi_server_3', value: 'https://example.invalid/v2', type: 'standard' },
    { key: 'openapi_server_4', value: 'https://example.invalid/v1', type: 'standard' },
  ]);
  expect(result.bundle.requests.map(request => request.url)).toEqual(['{{openapi_server_1}}/doc', '{{openapi_server_2}}/path', '{{openapi_server_3}}/path', '{{openapi_server_4}}/op', '{{openapi_server_1}}/same']);
  expect(result.warnings).toContain('Only the first of several OpenAPI servers was imported: GET /doc, GET /op.');
  expect(result.warnings).toContain('These server variables use the https://example.invalid placeholder because the document has no absolute server URL; set them before sending: openapi_server_2, openapi_server_3, openapi_server_4.');
  const bad = (server: Record<string, unknown>) => () => convertOpenApiDocument(doc({ servers: [server], paths: { '/x': { get: { responses: ok } } } }));
  expect(bad({ url: '//host.example.test' })).toThrow('Protocol-relative');
  expect(bad({ url: 'ftp://host.example.test' })).toThrow('must use HTTP or HTTPS');
  expect(bad({ url: 'https://user:pass@host.example.test' })).toThrow('must not contain credentials');
  expect(bad({ url: 'https://host.example.test/?a=1' })).toThrow('query, or a fragment');
  expect(bad({ url: 'https://host.example.test/a/../b' })).toThrow('dot segment');
  expect(bad({ url: '/a/.%2e/b' })).toThrow('dot segment');
  expect(bad({ url: 'https://{missing}.example.test' })).toThrow('"missing" is used but not defined');
  expect(bad({ url: 'https://{env}.example.test', variables: { env: { default: 'qa', enum: ['prod'] } } })).toThrow('not in its enum');
  expect(bad({ url: 'https://{env}.example.test', variables: { env: { enum: ['prod'] } } })).toThrow('has no string default');
  expect(bad({})).toThrow('missing its URL');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { servers: {}, get: { responses: ok } } } }))).toThrow('servers must be an array');
});

test('parameters merge by location and name with case-insensitive headers', () => {
  const request = only(doc({ paths: { '/x': {
    parameters: [
      { name: 'a', in: 'query', schema: { type: 'string' }, example: 'path-level' },
      { name: 'X-Trace', in: 'header', schema: { type: 'string' }, example: 'path-level' },
      { name: 'b', in: 'query', required: true, schema: { type: 'string' }, example: 'kept' },
    ],
    get: { parameters: [
      { name: 'a', in: 'query', required: true, schema: { type: 'string' }, example: 'operation' },
      { name: 'x-trace', in: 'header', required: true, schema: { type: 'string' }, example: 'operation' },
      { name: 'c', in: 'query', schema: { type: 'integer' }, example: 0 },
      { name: 'Accept', in: 'header', schema: { type: 'string' }, example: 'text/plain' },
      { name: 'content-type', in: 'header', schema: { type: 'string' } },
      { name: 'Authorization', in: 'header', schema: { type: 'string' } },
    ], responses: ok },
  } } }));
  expect(request.parameters).toEqual([{ key: 'a', value: 'operation', enabled: true }, { key: 'b', value: 'kept', enabled: true }, { key: 'c', value: '0', enabled: false }]);
  expect(request.headers).toEqual([{ key: 'x-trace', value: 'operation', enabled: true }]);
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'X', in: 'header' }, { name: 'x', in: 'header' }], responses: ok } } } }))).toThrow('duplicate header parameter');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'x', in: 'body' }], responses: ok } } } }))).toThrow('invalid name or location');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'x', in: 'query', required: 'yes' }], responses: ok } } } }))).toThrow('invalid required flag');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'x', in: 'header', example: 'a\r\nInjected: 1' }], responses: ok } } } }))).toThrow('line breaks or NUL');
});

test('query and header values follow the supported serialization subset', () => {
  const result = convert(doc({ paths: { '/x': { get: { parameters: [
    { name: 'tags', in: 'query', required: true, schema: { type: 'array', items: { type: 'string' } }, example: ['a', null, 2, true] },
    { name: 'empty', in: 'query', schema: { type: 'array' }, example: [] },
    { name: 'later', in: 'query', schema: { type: ['array', 'null'], items: { type: 'string' } } },
    { name: 'need', in: 'query', required: true, schema: { type: 'string' } },
    { name: 'nullish', in: 'query', schema: { type: 'string' }, example: null },
    { name: 'packed', in: 'query', explode: false, schema: { type: 'array' }, example: ['a', 'b'] },
    { name: 'deep', in: 'query', style: 'deepObject', schema: { type: 'object' }, example: { a: 1 } },
    { name: 'object', in: 'query', schema: { type: 'object' }, example: { a: 1 } },
    { name: 'reserved', in: 'query', allowReserved: true, schema: { type: 'string' }, example: 'a/b' },
    { name: 'spaced', in: 'query', style: 'spaceDelimited', schema: { type: 'array' }, example: ['a'] },
    { name: 'json', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
    { name: 'session', in: 'cookie', schema: { type: 'string' }, example: 'secret-cookie-value' },
    { name: 'X-Optional', in: 'header', schema: { type: 'string' }, example: 'o' },
    { name: 'X-List', in: 'header', schema: { type: 'array' }, example: ['a', 'b'] },
    { name: 'X-Need', in: 'header', required: true, schema: { type: 'string' } },
  ], responses: ok } } } }));
  const request = result.bundle.requests[0];
  expect(request.parameters).toEqual([
    { key: 'tags', value: 'a', enabled: true }, { key: 'tags', value: '', enabled: true }, { key: 'tags', value: '2', enabled: true }, { key: 'tags', value: 'true', enabled: true },
    { key: 'later', value: '', enabled: false }, { key: 'need', value: '', enabled: true }, { key: 'nullish', value: '', enabled: false },
  ]);
  expect(request.headers).toEqual([{ key: 'X-Optional', value: 'o', enabled: false }, { key: 'X-Need', value: '', enabled: true }]);
  expect(result.warnings).toEqual([
    'Select "Probe (OpenAPI)" and review server, parameter, body, and authentication values before sending.',
    'Empty array examples produced no rows: GET /x (empty).',
    'Array query parameters without an example start as one disabled empty row; add values before sending: GET /x (later).',
    'Required parameters without an example need values: GET /x (need), GET /x (X-Need).',
    'Query parameters with objects, non-exploded arrays, allowReserved, or non-form styles were not imported: GET /x (packed), GET /x (deep), GET /x (object), GET /x (reserved), GET /x (spaced).',
    'Parameters serialized with content were not imported: GET /x (json).',
    'Cookie parameters were not imported; add a Cookie header manually: GET /x (session).',
    'Header parameters with arrays, objects, or non-simple styles were not imported: GET /x (X-List).',
  ]);
  expect(result.warnings.join(' ')).not.toContain('secret-cookie-value');
});

test('parameter values use parameter examples before schema values', () => {
  const document = { components: { examples: { Remote: { externalValue: 'https://examples.example.test/x' }, Local: { value: 'from-ref' } } } };
  const request = only(doc({ ...document, paths: { '/x': { get: { parameters: [
    { name: 'a', in: 'query', example: 'parameter', schema: { type: 'string', example: 'schema' } },
    { name: 'b', in: 'query', examples: { remote: { $ref: '#/components/examples/Remote' }, local: { $ref: '#/components/examples/Local' } }, schema: { example: 'schema' } },
    { name: 'c', in: 'query', schema: { type: 'string', example: 'schema', default: 'default' } },
    { name: 'd', in: 'query', schema: { type: 'string', default: 'default', enum: ['enum'] } },
    { name: 'e', in: 'query', schema: { type: 'string', enum: ['first', 'second'] } },
    { name: 'f', in: 'query', schema: { type: 'string', const: 'const-ignored-in-3.0' } },
  ], responses: ok } } } }));
  expect(request.parameters.map(row => [row.key, row.value])).toEqual([['a', 'parameter'], ['b', 'from-ref'], ['c', 'schema'], ['d', 'default'], ['e', 'first'], ['f', '']]);
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'a', in: 'query', example: 1, examples: {} }], responses: ok } } } }))).toThrow('cannot define both example and examples');
});

test('notes are grouped by category, bounded, and keep important categories visible', () => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 60; index += 1) paths['/r' + index] = { get: { parameters: [{ name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } } };
  paths['/trace'] = { trace: { responses: ok }, get: { responses: ok } };
  paths['/combined'] = { get: { security: [{ basic: [], key: [] }], responses: ok } };
  const warnings = notes(doc({ components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, basic: { type: 'http', scheme: 'basic' }, key: { type: 'apiKey', in: 'header', name: 'k' } } }, security: [{ jwt: [] }], paths }));
  expect(warnings).toEqual([
    'Select "Probe (OpenAPI)" and review server, parameter, body, and authentication values before sending.',
    'Query parameters with objects, non-exploded arrays, allowReserved, or non-form styles were not imported: GET /r0 (filter), GET /r1 (filter), GET /r2 (filter), GET /r3 (filter), GET /r4 (filter) and 55 more.',
    'Enter bearer tokens: GET /r0, GET /r1, GET /r2, GET /r3, GET /r4 and 56 more.',
    'TRACE operations were not imported: TRACE /trace.',
    'Security requirements that combine several schemes were skipped because a request has one authentication method: GET /combined.',
    'Authentication could not be imported for these requests; configure it manually: GET /combined.',
    'Response definitions, examples, links, callbacks, and webhooks are not imported.',
  ]);
  expect(warnings.every(line => line.length <= 1000)).toBe(true);
});

test('request bodies pick one supported media type in tier and source order', () => {
  const pick = (content: Record<string, unknown>) => { const request = only(doc({ paths: { '/x': post(content) } })); return [request.headers.find(header => header.key === 'Content-Type')?.value, request.body.type]; };
  expect(pick({ 'application/vnd.api+json': { example: {} }, 'application/json': { example: {} } })).toEqual(['application/json', 'raw']);
  expect(pick({ 'text/plain': { example: 'x' }, 'application/problem+json': { example: {} }, 'application/ld+json': { example: {} } })).toEqual(['application/problem+json', 'raw']);
  expect(pick({ 'multipart/form-data': {}, 'application/x-www-form-urlencoded': {} })).toEqual(['application/x-www-form-urlencoded', 'form-urlencoded']);
  expect(pick({ 'text/csv': { example: 'a' }, 'multipart/form-data': {} })).toEqual([undefined, 'multipart']);
  expect(pick({ 'Application/JSON; charset=utf-8': { example: {} } })).toEqual(['Application/JSON; charset=utf-8', 'raw']);
  for (const content of [{ 'text/*': { example: 'x' } }, { 'application/*+json': { example: {} } }, { '*/*': {} }, { 'application/octet-stream': {} }, { 'image/png': {} }]) {
    const result = convert(doc({ paths: { '/x': post(content) } }));
    expect(result.bundle.requests[0].body).toEqual({ type: 'none' });
    expect(result.bundle.requests[0].headers).toEqual([]);
    expect(result.warnings).toContain('Request bodies offering only unsupported media types, such as binary or wildcard types, were not imported: POST /x.');
  }
  const choice = notes(doc({ paths: { '/x': post({ 'application/xml': { example: '<a/>' }, 'application/json': { example: {} } }) } }));
  expect(choice).toContain('Only one request body media type was imported where several were offered: POST /x (application/json).');
  const bodyOnGet = convert(doc({ paths: { '/x': { get: { requestBody: { content: { 'application/json': { example: {} } } }, responses: ok }, head: { requestBody: { content: {} }, responses: ok } } } }));
  expect(bodyOnGet.bundle.requests.map(request => request.body)).toEqual([{ type: 'none' }, { type: 'none' }]);
  expect(bodyOnGet.warnings).toContain('Request bodies on GET and HEAD operations were left out because they are not sent: GET /x, HEAD /x.');
});

test('JSON bodies keep explicit values and mark generated or empty drafts', () => {
  const document = { components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string', example: 'Milo' }, age: { type: 'integer' } } } }, examples: { Described: { summary: 'No inline value' } } } };
  const result = convert(doc({ ...document, paths: {
    '/string': post({ 'application/json': { example: 'text' } }),
    '/false': post({ 'application/json': { example: false } }),
    '/null': post({ 'application/json': { example: null } }),
    '/generated': post({ 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } }),
    '/described': post({ 'application/json': { examples: { described: { $ref: '#/components/examples/Described' } }, schema: { type: 'object', properties: { name: { type: 'string' } } } } }),
    '/composed': post({ 'application/json': { schema: { anyOf: [{ type: 'string' }] } } }),
    '/readonly': post({ 'application/json': { example: { id: 1, name: 'Copied' }, schema: { $ref: '#/components/schemas/Pet' } } }),
  } }));
  expect(result.bundle.requests.map(request => request.body.raw?.content)).toEqual(['"text"', 'false', 'null', '{\n  "name": "Milo",\n  "age": 0\n}', '{\n  "name": ""\n}', '', '{\n  "id": 1,\n  "name": "Copied"\n}']);
  expect(result.warnings).toEqual(expect.arrayContaining([
    'Generated request bodies are drafts that are not schema-validated; review them before sending: POST /generated, POST /described.',
    'Request bodies without a usable example were left empty; enter them manually: POST /composed (schema composition is not generated).',
    'Request examples were copied without validation and include read-only fields: POST /readonly.',
  ]));
});

test('text and XML bodies use authored scalars only', () => {
  const result = convert(doc({ paths: {
    '/xml-schema': post({ 'application/xml': { schema: { type: 'object', properties: { name: { type: 'string' } } } } }),
    '/text-object': post({ 'text/plain': { example: { a: 1 } } }),
    '/text-xml': post({ 'text/xml': { example: '<a/>' } }),
    '/html': post({ 'text/html': { schema: { type: 'string', default: '<p>hi</p>' } } }),
    '/script': post({ 'application/javascript': { example: 42 } }),
  } }));
  expect(result.bundle.requests.map(request => [request.body.raw?.language, request.body.raw?.content, request.headers[0]?.value])).toEqual([
    ['xml', '', 'application/xml'], ['text', '', 'text/plain'], ['xml', '<a/>', 'text/xml'], ['html', '<p>hi</p>', 'text/html'], ['javascript', '42', 'application/javascript'],
  ]);
  expect(result.warnings).toContain('Request bodies without a usable example were left empty; enter them manually: POST /xml-schema, POST /text-object (the example is not text).');
});

test('form bodies map rows from examples or schema properties', () => {
  const document = { components: { schemas: { Hidden: { type: 'string', readOnly: true } } } };
  const result = convert(doc({ ...document, paths: {
    '/schema': post({ 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['a', 'list'], properties: {
      a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'boolean', default: false }, hidden: { $ref: '#/components/schemas/Hidden' },
      list: { type: 'array', items: { type: 'string' }, example: ['x', 'y'] }, nested: { type: 'object', example: { deep: 1 } }, upload: { type: 'string', format: 'binary' },
    } } } }),
    '/example': post({ 'application/x-www-form-urlencoded': { example: { a: 'x y', hidden: 'shown', list: ['1', '2'], nested: { no: true } }, schema: { type: 'object', properties: { hidden: { $ref: '#/components/schemas/Hidden' } } } } }),
    '/encoded': post({ 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { plain: { type: 'string' }, packed: { type: 'array', example: ['a'] }, style: { type: 'string' } } }, encoding: { packed: { explode: false }, style: { style: 'spaceDelimited' }, plain: { contentType: 'text/plain' } } } }),
    '/not-object': post({ 'application/x-www-form-urlencoded': { example: 'a=1' } }),
  } }));
  const [schema, example, encoded, notObject] = result.bundle.requests;
  expect(schema.body).toEqual({ type: 'form-urlencoded', form: [
    { key: 'a', value: '', enabled: true }, { key: 'b', value: '', enabled: false }, { key: 'c', value: 'false', enabled: false },
    { key: 'list', value: 'x', enabled: true }, { key: 'list', value: 'y', enabled: true },
  ] });
  expect(schema.headers).toEqual([{ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }]);
  expect(example.body.form).toEqual([{ key: 'a', value: 'x y', enabled: true }, { key: 'hidden', value: 'shown', enabled: true }, { key: 'list', value: '1', enabled: true }, { key: 'list', value: '2', enabled: true }]);
  expect(encoded.body.form).toEqual([{ key: 'plain', value: '', enabled: false }]);
  expect(notObject.body).toEqual({ type: 'form-urlencoded', form: [] });
  expect(result.warnings).toEqual(expect.arrayContaining([
    'Required form fields without an example need values: POST /schema (a).',
    'Form fields with nested values, file arrays, files in URL-encoded forms, or custom encodings were not imported: POST /schema (nested), POST /schema (upload), POST /example (nested), POST /encoded (packed), POST /encoded (style).',
    'Form examples that are not objects were ignored: POST /not-object.',
    'Form bodies with no importable fields are empty; add fields manually: POST /not-object.',
  ]));
});

test('multipart file fields always start disabled and empty', () => {
  const document = { components: { schemas: { Binary: { type: 'string', format: 'binary' } } } };
  const v30 = convert(doc({ ...document, paths: {
    '/upload': post({ 'multipart/form-data': { schema: { type: 'object', required: ['file', 'note'], properties: {
      file: { $ref: '#/components/schemas/Binary' }, note: { type: 'string', example: 'hello' }, tags: { type: 'array', items: { type: 'string' } },
      many: { type: 'array', items: { type: 'string', format: 'binary' } }, typed: { type: 'string', format: 'binary' }, headed: { type: 'string' }, json: { type: 'string' },
    } }, encoding: { typed: { contentType: 'image/png' }, headed: { headers: { 'X-Part': { schema: { type: 'string' } } } }, json: { contentType: 'application/json' }, note: { contentType: 'text/plain; charset=utf-8' }, file: { contentType: 'application/octet-stream' } } } }),
    '/example': post({ 'multipart/form-data': { example: { file: 'C:\\Users\\someone\\secret.txt', tags: ['a', 'b'] }, schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, attachment: { type: 'string', format: 'binary' }, tags: { type: 'array', items: { type: 'string' } } } } } }),
  } }));
  expect(v30.bundle.requests[0].body).toEqual({ type: 'multipart', multipart: [
    { key: 'file', type: 'file', value: '', filePath: '', enabled: false }, { key: 'note', type: 'text', value: 'hello', enabled: true }, { key: 'tags', type: 'text', value: '', enabled: false },
  ] });
  expect(v30.bundle.requests[0].headers).toEqual([]);
  expect(v30.bundle.requests[1].body.multipart).toEqual([
    { key: 'file', type: 'file', value: '', filePath: '', enabled: false }, { key: 'tags', type: 'text', value: 'a', enabled: true }, { key: 'tags', type: 'text', value: 'b', enabled: true },
    { key: 'attachment', type: 'file', value: '', filePath: '', enabled: false },
  ]);
  expect(JSON.stringify(v30)).not.toContain('secret.txt');
  expect(v30.warnings).toEqual(expect.arrayContaining([
    'Multipart file fields start disabled with no file; select a local file and enable them before sending: POST /upload (file), POST /example (file), POST /example (attachment).',
    'Form fields with nested values, file arrays, files in URL-encoded forms, or custom encodings were not imported: POST /upload (many), POST /upload (typed), POST /upload (headed), POST /upload (json).',
  ]));
  const v31 = only(doc({ paths: { '/upload': post({ 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', contentMediaType: 'application/octet-stream' }, encoded: { type: 'string', contentMediaType: 'image/png', contentEncoding: 'base64' } } } } }) } }, '3.1.0'));
  expect(v31.body.multipart).toEqual([{ key: 'file', type: 'file', value: '', filePath: '', enabled: false }, { key: 'encoded', type: 'text', value: '', enabled: false }]);
});

test('authentication picks the first fully representable alternative', () => {
  const schemes = {
    basic: { type: 'http', scheme: 'Basic' }, jwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, digest: { type: 'http', scheme: 'digest' },
    headerKey: { type: 'apiKey', in: 'header', name: 'X-Key' }, queryKey: { type: 'apiKey', in: 'query', name: 'key' }, cookieKey: { type: 'apiKey', in: 'cookie', name: 'session' },
    oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example.test/.well-known/openid-configuration' }, mtls: { type: 'mutualTLS' },
    oauth: { type: 'oauth2', flows: {
      authorizationCode: { authorizationUrl: 'https://id.example.test/authorize', tokenUrl: 'https://id.example.test/token', refreshUrl: 'https://id.example.test/refresh', scopes: { read: '', write: '' } },
      clientCredentials: { tokenUrl: 'https://id.example.test/token', scopes: {} },
    } },
    relative: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: '/authorize', tokenUrl: '/token', scopes: {} }, clientCredentials: { tokenUrl: 'https://id.example.test/cc', scopes: {} } } },
    implicit: { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://id.example.test/authorize', scopes: {} } } },
    plainHttp: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'http://id.example.test/token', scopes: {} } } },
  };
  const result = convert(doc({ components: { securitySchemes: schemes }, security: [{ jwt: [] }], paths: {
    '/default': { get: { responses: ok } },
    '/cleared': { get: { security: [], responses: ok } },
    '/anonymous': { get: { security: [{ digest: [] }, {}, { basic: [] }], responses: ok } },
    '/fallback': { get: { security: [{ cookieKey: [] }, { oidc: [] }, { mtls: [] }, { basic: [], headerKey: [] }, { queryKey: ['admin'] }], responses: ok } },
    '/oauth': { get: { security: [{ oauth: ['read'] }], responses: ok } },
    '/relative': { get: { security: [{ relative: ['a', 'b'] }], responses: ok } },
    '/none': { get: { security: [{ implicit: [] }, { plainHttp: [] }, { digest: [] }], responses: ok } },
    '/header': { get: { security: [{ headerKey: [] }, { basic: [] }], responses: ok } },
  } }));
  expect(result.bundle.requests.map(request => request.auth)).toEqual([
    { type: 'bearer', bearer: { token: '', prefix: 'Bearer' } },
    { type: 'none' },
    { type: 'none' },
    { type: 'api_key', api_key: { key: 'key', value: '', in: 'query' } },
    { type: 'oauth2', oauth2: { grantType: 'authorization_code', authorizationUrl: 'https://id.example.test/authorize', tokenUrl: 'https://id.example.test/token', clientId: '', clientSecret: '', scope: 'read', redirectUri: '', clientAuthentication: 'none' } },
    { type: 'oauth2', oauth2: { grantType: 'client_credentials', authorizationUrl: '', tokenUrl: 'https://id.example.test/cc', clientId: '', clientSecret: '', scope: 'a b', redirectUri: '', clientAuthentication: 'basic' } },
    { type: 'none' },
    { type: 'api_key', api_key: { key: 'X-Key', value: '', in: 'header' } },
  ]);
  expect(result.warnings).toEqual(expect.arrayContaining([
    'Several security options were offered; the first supported one was imported: GET /anonymous, GET /fallback, GET /none, GET /header.',
    'Unsupported security schemes were skipped: GET /anonymous (digest: HTTP digest), GET /fallback (cookieKey: API key in a cookie), GET /fallback (oidc: OpenID Connect), GET /fallback (mtls: mutual TLS), GET /none (implicit: OAuth without authorization code or client credentials) and 1 more.',
    'Security requirements that combine several schemes were skipped because a request has one authentication method: GET /fallback.',
    'Role lists on non-OAuth security requirements are not sent: GET /fallback.',
    'OAuth refresh URLs that differ from the token URL were not imported: GET /oauth.',
    'OAuth schemes offering several flows use the first supported one (authorization code before client credentials): GET /oauth, GET /relative.',
    'OAuth flows with missing, relative, or non-HTTPS endpoints were skipped: GET /relative (relative), GET /none (plainHttp).',
    'Authentication could not be imported for these requests; configure it manually: GET /none.',
  ]));
  expect(() => convertOpenApiDocument(doc({ security: [{ missing: [] }], paths: { '/x': { get: { responses: ok } } } }))).toThrow('GET /x uses security scheme "missing", which is not defined in components.securitySchemes.');
  expect(() => convertOpenApiDocument(doc({ components: { securitySchemes: schemes }, security: [{ jwt: 'read' }], paths: { '/x': { get: { responses: ok } } } }))).toThrow('invalid scopes list');
  expect(() => convertOpenApiDocument(doc({ components: { securitySchemes: schemes }, security: {}, paths: { '/x': { get: { responses: ok } } } }))).toThrow('security must be an array');
});

test('operation and output budgets accept their limits and fail one step past them', () => {
  const manyPaths = (count: number) => { const paths: Record<string, unknown> = {}; for (let index = 0; index < count; index += 1) paths['/r' + index] = { get: {} }; return paths; };
  expect(convert(doc({ paths: manyPaths(10_000) })).bundle.requests).toHaveLength(10_000);
  expect(() => convertOpenApiDocument(doc({ paths: manyPaths(10_001) }))).toThrow('more than 10,000 operations');
  const shared = (count: number) => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) paths['/r' + index] = post({ 'text/plain': { examples: { big: { $ref: '#/components/examples/big' } } } });
    return doc({ components: { examples: { big: { value: 'x'.repeat(1_000_000) } } }, paths });
  };
  expect(convert(shared(15)).bundle.requests).toHaveLength(15);
  expect(() => convertOpenApiDocument(shared(17))).toThrow('The converted OpenAPI collection would be larger than the 16 MiB import limit.');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': post({ 'application/json': { example: 'x'.repeat(1024 * 1024) } }) } }))).toThrow('The request body example for POST /x is larger than the 1 MiB import limit.');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ name: 'q', in: 'query', example: 'x'.repeat(1024 * 1024 + 1) }], responses: ok } } } }))).toThrow('larger than the 1 MiB import limit');
});

test('YAML alias expansion is bounded by the body limit', () => {
  const lines = ['openapi: 3.0.3', 'info: {title: Aliases, version: "1"}', 'x-lol:', '  a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
  for (let level = 1; level <= 9; level += 1) lines.push('  a' + level + ': &a' + level + ' [' + Array.from({ length: 10 }, () => '*a' + (level - 1)).join(',') + ']');
  lines.push('paths:', '  /bomb:', '    post:', '      requestBody: {content: {application/json: {example: *a9}}}', '      responses: {"200": {description: ok}}');
  const input = parseCollectionFile(lines.join('\n'));
  const started = Date.now();
  expect(() => convertOpenApiDocument(input)).toThrow('The request body example for POST /bomb is larger than the 1 MiB import limit.');
  expect(Date.now() - started).toBeLessThan(2000);
});

test('conversion is pure and deterministic for frozen input', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
    return value;
  };
  const input = deepFreeze(doc({ components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } }, securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'k' } } }, security: [{ key: [] }], paths: {
    '/pets/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], ...post({ 'application/json': { schema: { $ref: '#/components/schemas/Pet' } }, 'multipart/form-data': {} }) },
  } }));
  const first = JSON.stringify(convertOpenApiDocument(input));
  expect(JSON.stringify(convertOpenApiDocument(input))).toBe(first);
});

test('unused unsupported references do not block import, consumed ones fail with context', () => {
  expect(convert(doc({ components: { schemas: { Unused: { $ref: 'https://specs.example.test/other.yaml#/X' } } }, paths: { '/x': { get: { responses: ok } } } })).bundle.requests).toHaveLength(1);
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': post({ 'application/json': { schema: { $ref: './shared.yaml#/Pet' } } }) } }))).toThrow('"./shared.yaml#/Pet" is external or unsupported');
  expect(() => convertOpenApiDocument(doc({ paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Missing' }], responses: ok } } } }))).toThrow('GET /x parameter "#/components/parameters/Missing" points to a missing component');
  expect(() => convertOpenApiDocument(doc({ components: { requestBodies: { Loop: { $ref: '#/components/requestBodies/Loop' } } }, paths: { '/x': post({}, { requestBody: { $ref: '#/components/requestBodies/Loop' } }) } }))).toThrow('circular reference');
  expect(() => convertOpenApiDocument(doc({ components: { pathItems: { P: { get: { responses: ok } } } }, paths: { '/x': { $ref: '#/components/pathItems/P', post: { responses: ok } } } }, '3.1.0'))).toThrow('cannot combine $ref with operations');
  const siblings = convert(doc({ components: { parameters: { Q: { name: 'q', in: 'query', schema: { type: 'string' } } } }, paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Q', required: true, description: 'fine' }], responses: ok } } } }));
  expect(siblings.warnings).toContain('Fields written next to $ref were ignored: GET /x (required).');
  expect(siblings.bundle.requests[0].parameters).toEqual([{ key: 'q', value: '', enabled: false }]);
});
