import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { CollectionImportError } from '../../src/main/stores/collectionExport';
import type { CollectionFileOperations } from '../../src/main/stores/collectionMutation';
import { convertInsomniaExport, type InsomniaConversion } from '../../src/main/stores/insomniaImport';
import { parseCollectionFile } from '../../src/main/ipc/collectionFileActions';
import type { Environment, Request, RequestGroupNode } from '../../src/shared/types';

const fixtures = path.join(__dirname, 'fixtures');

async function load(name: string): Promise<unknown> {
  return parseCollectionFile(await fs.readFile(path.join(fixtures, name), 'utf8'));
}

async function convert(name: string): Promise<InsomniaConversion> {
  const conversion = convertInsomniaExport(await load(name));
  expect(conversion).not.toBeNull();
  return conversion!;
}

function request(conversion: InsomniaConversion, name: string) {
  const found = conversion.bundle.requests.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

/** Names-only tree, so generated and remapped IDs don't matter. */
function tree(conversion: InsomniaConversion): unknown[] {
  const groups = new Map(conversion.bundle.groups.map((group) => [group.id, group]));
  const requests = new Map(conversion.bundle.requests.map((item) => [item.id, item]));
  const describe = (id: string): unknown => {
    const group = groups.get(id);
    return group ? { [group.name]: group.children.map(describe) } : requests.get(id)!.name;
  };
  return conversion.bundle.roots.map(describe);
}

test('v5 YAML: folders become one top-level folder per collection, ordered by sort key, with non-HTTP requests skipped', async () => {
  const conversion = await convert('insomnia-v5-collection.yaml');
  expect(tree(conversion)).toEqual([{
    'Shop API': [
      { Orders: ['Create order', 'Get order', { Archive: ['Upload receipt', 'Digest login'] }] },
      'Form login',
      'Search products',
    ],
  }]);
  expect(conversion.warnings.join('\n')).toContain('were skipped: "Live stock"');
});

test('v5 YAML: folder headers and auth are copied onto requests; request values win', async () => {
  const conversion = await convert('insomnia-v5-collection.yaml');
  const getOrder = request(conversion, 'Get order');
  // The request's own X-Tenant replaces the folder's; the disabled folder header is not inherited.
  expect(getOrder.headers).toEqual([
    { key: 'X-Tenant', value: 'override', enabled: true },
    { key: 'X-Request-Id', value: '{{uuid}}', enabled: true },
  ]);
  expect(getOrder.auth).toEqual({ type: 'bearer', bearer: { token: '{{token}}', prefix: 'Bearer' } });

  const createOrder = request(conversion, 'Create order');
  expect(createOrder.headers).toEqual([
    { key: 'X-Tenant', value: '{{tenant}}', enabled: true },
    { key: 'Content-Type', value: 'application/json', enabled: true },
  ]);
  expect(createOrder.auth).toEqual({ type: 'basic', basic: { username: 'admin', password: '{{password}}' } });

  // "No auth" on the Archive folder stops the bearer token from reaching its requests.
  expect(request(conversion, 'Upload receipt').auth).toEqual({ type: 'none' });
  expect(request(conversion, 'Upload receipt').headers).toEqual([{ key: 'X-Tenant', value: '{{tenant}}', enabled: true }]);
});

test('v5 YAML: URLs, path and query parameters, settings, and scripts carry over', async () => {
  const conversion = await convert('insomnia-v5-collection.yaml');
  const getOrder = request(conversion, 'Get order');
  expect(getOrder.method).toBe('GET');
  expect(getOrder.url).toBe('{{base_url}}/orders/{{order-id}}');
  expect(getOrder.parameters).toEqual([
    { key: 'expand', value: 'items', enabled: true },
    { key: 'debug', value: '1', enabled: false },
  ]);
  expect(getOrder.settings).toEqual({ followRedirect: false, timeout: 30000, cookiesEnabled: false });
  expect(getOrder.scripts).toEqual({ preRequest: 'insomnia.environment.set("ts", Date.now());' });
  expect(conversion.warnings.join('\n')).toContain('Scripts were kept on "Get order" but won\'t run');
  expect(request(conversion, 'Create order').settings.followRedirect).toBe(true);
});

test('v5 YAML: bodies map to raw, form, and multipart with the headers the engine needs', async () => {
  const conversion = await convert('insomnia-v5-collection.yaml');
  expect(request(conversion, 'Create order').body).toEqual({
    type: 'raw',
    raw: { language: 'json', content: '{"sku": "{{sku}}", "at": {{timestamp}}, "who": "{% response \'body\', \'req_x\', \'b64::JC5pZA==::46b\', \'never\', 60 %}"}' },
  });

  const form = request(conversion, 'Form login');
  expect(form.body).toEqual({ type: 'form-urlencoded', form: [
    { key: 'user', value: '{{user}}', enabled: true },
    { key: 'pass', value: '{{ _.password | upper }}', enabled: true },
  ] });
  expect(form.headers).toEqual([{ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }]);

  const upload = request(conversion, 'Upload receipt');
  expect(upload.body).toEqual({ type: 'multipart', multipart: [
    { key: 'note', type: 'text', value: '{{note}}', enabled: true },
    { key: 'receipt', type: 'file', value: 'C:\\receipts\\r1.pdf', filePath: 'C:\\receipts\\r1.pdf', enabled: true },
    { key: 'skipped', type: 'text', value: 'x', enabled: false },
  ] });
  // A boundary-less multipart Content-Type would stop the engine from adding its own boundary.
  expect(upload.headers.some((header) => header.key.toLowerCase() === 'content-type')).toBe(false);

  const graphql = request(conversion, 'Search products');
  expect(graphql.body).toEqual({ type: 'raw', raw: { language: 'json', content: '{"query":"{ products { id } }"}' } });
  expect(graphql.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
  expect(graphql.auth).toEqual({ type: 'api_key', api_key: { key: 'api_key', value: '{{api_key}}', in: 'query' } });
});

test('v5 YAML: everything that could not be carried over is reported once per kind', async () => {
  const { warnings } = await convert('insomnia-v5-collection.yaml');
  expect(warnings).toEqual(expect.arrayContaining([
    'Folder variables in "Orders" weren\'t imported; Restiprocity only has environment variables. Add them to an environment if requests use them.',
    'Insomnia template tags or expressions in "Create order", "Form login" were kept as written and won\'t be evaluated.',
    'Digest authentication isn\'t supported; it was not imported for "Digest login".',
    'gRPC, WebSocket, Socket.IO, and MCP requests aren\'t supported and were skipped: "Live stock".',
  ]));
  expect(new Set(warnings).size).toBe(warnings.length);
});

test('v5 YAML: environments keep Insomnia\'s base → sub-environment shape, with nested keys flattened', async () => {
  const { environments } = await convert('insomnia-v5-collection.yaml');
  expect(environments.map(({ name, parentSourceId }) => ({ name, parent: parentSourceId ?? null }))).toEqual([
    { name: 'Shop API', parent: null },
    { name: 'Production', parent: environments[0].sourceId },
    { name: 'Staging', parent: environments[0].sourceId },
  ]);
  expect(environments[0].variables).toEqual([
    { key: 'base_url', value: 'https://shop.test', type: 'standard' },
    { key: 'tenant', value: 'acme', type: 'secret' },
    { key: 'order-id', value: '42', type: 'standard' },
    // YAML dates and numbers stay as written rather than becoming Date objects.
    { key: 'since', value: '2024-01-01', type: 'standard' },
    { key: 'retries', value: '3', type: 'standard' },
    { key: 'api.host', value: 'api.shop.test', type: 'standard' },
    { key: 'api.ports', value: '[80,443]', type: 'standard' },
  ]);
  expect(environments[1].variables).toEqual([
    { key: 'base_url', value: 'https://prod.shop.test', type: 'standard' },
    { key: 'token', value: 'prod-token', type: 'secret' },
  ]);
  expect(environments[2].variables).toEqual([{ key: 'base_url', value: '{{base_url}}/staging', type: 'standard' }]);
});

test('v4 JSON: workspaces, folders, NTLM domains, disabled auth, and unsupported items', async () => {
  const conversion = await convert('insomnia-v4-export.json');
  // The empty "Scratch" workspace (and its empty base environment) adds nothing.
  expect(tree(conversion)).toEqual([{ 'Users API': [{ Users: ['Create user', 'List users'] }, 'Upload avatar'] }]);

  const list = request(conversion, 'List users');
  expect(list.url).toBe('{{base_url}}/users');
  expect(list.parameters).toEqual([{ key: 'page', value: '1', enabled: true }]);
  expect(list.auth).toEqual({ type: 'ntlm', ntlm: { useCurrentAuthContext: false, username: 'alice', password: '{{ntlm_password}}', domain: 'CORP' } });

  const create = request(conversion, 'Create user');
  expect(create.method).toBe('PUT');
  expect(create.auth).toEqual({ type: 'none' });
  expect(create.body).toEqual({ type: 'raw', raw: { language: 'xml', content: '<user name="{{name}}"/>' } });
  expect(create.headers).toEqual([{ key: 'Content-Type', value: 'application/xml', enabled: true }]);

  expect(request(conversion, 'Upload avatar').body).toEqual({ type: 'none' });
  expect(conversion.warnings).toEqual(expect.arrayContaining([
    'Requests with methods Restiprocity doesn\'t support were skipped: "Purge cache".',
    'Binary file bodies aren\'t supported; the body was not imported for "Upload avatar".',
    'gRPC, WebSocket, Socket.IO, and MCP requests aren\'t supported and were skipped: "Ping".',
  ]));

  expect(conversion.environments.map(({ name, variables }) => ({ name, keys: variables.map((variable) => variable.key) }))).toEqual([
    { name: 'Users API', keys: ['base_url', 'ntlm_password'] },
    { name: 'Local', keys: ['base_url'] },
  ]);
});

test('non-Insomnia files are left alone, and unusable Insomnia files get a specific message', async () => {
  expect(convertInsomniaExport({ format: 'restiprocity.collection' })).toBeNull();
  expect(convertInsomniaExport({ info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' } })).toBeNull();
  const cases: [unknown, string][] = [
    [{ _type: 'export', __export_format: 3, resources: [] }, 'uses format 3'],
    [{ _type: 'export', __export_format: 4, resources: [] }, 'contains no workspaces'],
    [[{ _type: 'request', url: 'x' }], 'in a format Restiprocity can\'t read'],
    [{ type: 'mock.insomnia.rest/5.0', name: 'Mocks' }, 'mock server export'],
    [{ type: 'collection.insomnia.rest/5.0', name: 'Empty', collection: [] }, 'no requests or environments'],
    [{ type: 'collection.insomnia.rest/5.0', name: 'Sockets', collection: [{ name: 'ws', url: 'wss://x', meta: { id: 'ws_1' } }] }, 'Nothing in this Insomnia export could be imported'],
  ];
  for (const [data, message] of cases) {
    let failure: unknown;
    try { convertInsomniaExport(data); } catch (error) { failure = error; }
    expect(failure, message).toBeInstanceOf(CollectionImportError);
    expect((failure as Error).message).toContain(message);
  }
});

test('parseCollectionFile reads JSON, YAML, and BOM-prefixed files, and rejects plain text', () => {
  expect(parseCollectionFile('\uFEFF{"a":1}')).toEqual({ a: 1 });
  expect(parseCollectionFile('type: collection.insomnia.rest/5.0\nname: X\n')).toEqual({ type: 'collection.insomnia.rest/5.0', name: 'X' });
  expect(parseCollectionFile('just some words')).toBeUndefined();
  expect(parseCollectionFile('a: [unclosed')).toBeUndefined();
});

// ─── Through the store ────────────────────────────────────────

async function freshStore(files?: CollectionFileOperations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'insomnia-import-'));
  const store = new CollectionStore(directory, files);
  await store.init();
  return { directory, store };
}

test('importing an Insomnia export writes requests, folders, and environments, and keeps the active environment', async () => {
  const { store } = await freshStore();
  const existing = await store.createRequest({
    name: 'Existing', method: 'GET', url: '', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true }, scripts: {},
  });

  const summary = await store.importBundle(await load('insomnia-v5-collection.yaml'));
  expect(summary).toMatchObject({ requests: 6, groups: 3, environments: 3 });
  expect(summary.warnings.length).toBeGreaterThan(0);

  const items = await store.listAll();
  const roots = items.filter((item) => !items.some((other) => 'children' in other && (other as RequestGroupNode).children.includes(item.id)));
  expect(roots.map((item) => item.name)).toEqual([existing.name, 'Shop API']);
  const orders = items.find((item) => item.name === 'Orders') as RequestGroupNode;
  const getOrder = items.find((item) => item.name === 'Get order') as Request;
  expect(getOrder.parentId).toBe(orders.id);
  expect(orders.children).toContain(getOrder.id);
  expect(getOrder.id).not.toBe('req_get_order');

  const environments = await store.listEnvironments();
  const shop = environments.find((environment) => environment.name === 'Shop API') as Environment;
  expect(shop.parentId).toBe('core');
  expect(environments.filter((environment) => environment.parentId === shop.id).map((environment) => environment.name).sort()).toEqual(['Production', 'Staging']);
  expect((await store.getSettings()).activeEnvironmentId).toBe('core');
});

test('a failed Insomnia import leaves no requests or environments behind', async () => {
  // Fail while moving the first environment into place, after the collection files have landed.
  let failed = false;
  const files: CollectionFileOperations = {
    readFile: fs.readFile,
    writeFile: fs.writeFile,
    rename: async (from, to) => {
      if (!failed && path.basename(path.dirname(String(to))) === 'environments') {
        failed = true;
        throw new Error('disk full');
      }
      return fs.rename(from, to);
    },
    unlink: fs.unlink,
  };
  const { directory, store } = await freshStore(files);
  const environmentsBefore = await fs.readdir(path.join(directory, 'environments'));

  await expect(store.importBundle(await load('insomnia-v5-collection.yaml'))).rejects.toThrow('original collection files were restored');
  expect(await fs.readdir(path.join(directory, 'collections'))).toEqual([]);
  expect(await fs.readdir(path.join(directory, 'environments'))).toEqual(environmentsBefore);
});
