import { test, expect } from '@playwright/test';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CollectionImportFileResult, Environment, Request } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');

type Received = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };

async function startCapture(): Promise<{ port: number; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
    response.setHeader('Content-Type', 'text/plain');
    response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, received, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.api?.sendRequest === 'function');
  return { app, page };
}

/** Only dialog.showOpenDialog is intercepted; parsing, conversion, persistence and IPC are the real ones. */
async function importFile(launched: { app: ElectronApplication; page: Page }, filePath: string | null): Promise<CollectionImportFileResult> {
  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = (async () => (selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  }, filePath);
  return launched.page.evaluate(() => window.api.importCollectionFile());
}

async function persisted(userData: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const directory of ['collections', 'environments']) {
    for (const name of await fs.readdir(path.join(userData, directory)).catch(() => [] as string[])) {
      files[directory + '/' + name] = (await fs.readFile(path.join(userData, directory, name))).toString('base64');
    }
  }
  files['settings.json'] = (await fs.readFile(path.join(userData, 'settings.json'))).toString('base64');
  return files;
}

test('rejects bad OpenAPI files over real IPC without network access or persistence changes', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-openapi-reject-'));
  const sources = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-openapi-sources-'));
  const capture = await startCapture();
  let launched: { app: ElectronApplication; page: Page } | undefined;
  const ok = { '200': { description: 'ok' } };
  const write = async (name: string, contents: string | object) => {
    const file = path.join(sources, name);
    await fs.writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  };
  const base = { openapi: '3.0.3', info: { title: 'Rejected', version: '1' } };
  try {
    launched = await launch(userData);
    await launched.page.evaluate(() => window.api.collectionCreate({ nodeType: 'request', name: 'Existing', method: 'GET', url: 'https://existing.example.test', headers: [], parameters: [], body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 30000 }, scripts: {} }));
    const before = await persisted(userData);
    await write('shared.yaml', 'Pet:\n  type: object\n');
    const oversized = path.join(sources, 'oversized.json');
    await fs.writeFile(oversized, '');
    await fs.truncate(oversized, 50 * 1024 * 1024 + 1);
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      [await write('malformed.yaml', 'openapi: 3.0.3\ninfo: [unclosed\n'), 'This file is not valid JSON or YAML.'],
      [await write('version.json', { ...base, openapi: '3.2.0', paths: {} }), 'Only OpenAPI 3.0.x and 3.1.x documents are supported; this document declares version "3.2.0".'],
      [await write('broken.json', { ...base, paths: { '/x': { get: { parameters: [{ $ref: '#/components/parameters/Missing' }], responses: ok } } } }), 'points to a missing component'],
      [await write('remote.json', { ...base, paths: { '/x': { post: { requestBody: { content: { 'application/json': { schema: { $ref: 'http://127.0.0.1:' + capture.port + '/sentinel.yaml#/Pet' } } } }, responses: ok } } } }), 'is external or unsupported'],
      [await write('file-ref.json', { ...base, paths: { '/x': { post: { requestBody: { content: { 'application/json': { schema: { $ref: './shared.yaml#/Pet' } } } }, responses: ok } } } }), '"./shared.yaml#/Pet" is external or unsupported'],
      [oversized, 'This file is too large to be a collection export.'],
      [await write('values.json', { ...base, paths: { '/x': { get: { responses: ok } } }, 'x-values': Array.from({ length: 100_000 }, () => 0) }), 'more than 100,000 values'],
    ];
    for (const [file, message] of cases) {
      const result = await importFile(launched, file);
      if (message === null) expect(result).toEqual({ imported: false, reason: 'cancelled' });
      else {
        expect(result, file ?? 'cancelled').toMatchObject({ imported: false, reason: 'failed' });
        expect(result.imported === false && result.reason === 'failed' ? result.message : '').toContain(message);
      }
      expect(await persisted(userData)).toEqual(before);
    }
    expect(capture.received).toEqual([]);
  } finally {
    if (launched) await launched.app.close().catch(() => {});
    await capture.close();
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rm(sources, { recursive: true, force: true });
  }
});

test('imports OpenAPI 3.0 JSON and 3.1 YAML, sends the stored requests byte for byte, and survives restart', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-openapi-native-'));
  const sources = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-openapi-sources-'));
  const capture = await startCapture();
  let launched: { app: ElectronApplication; page: Page } | undefined;
  try {
    const petsFile = path.join(sources, 'pets.json');
    await fs.writeFile(petsFile, JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Native Pets', version: '1' },
      servers: [{ url: '/v1' }],
      components: { securitySchemes: { jwt: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ jwt: [] }],
      paths: {
        '/pets/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'a/b %' }],
          post: {
            summary: 'Update pet',
            tags: ['Pets'],
            parameters: [
              { name: 'tag', in: 'query', required: true, schema: { type: 'array', items: { type: 'string' } }, example: ['a&b', 'c d'] },
              { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' }, example: 'trace-1' },
            ],
            requestBody: { content: { 'application/json': { example: { name: 'Milo', tags: ['x'] } } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }));
    const formsFile = path.join(sources, 'forms.yaml');
    await fs.writeFile(formsFile, [
      'openapi: 3.1.0',
      'info: {title: Native Forms, version: "1"}',
      'servers: [{url: forms}]',
      'paths:',
      '  /submit:',
      '    post:',
      '      summary: Submit form',
      '      requestBody:',
      '        content:',
      '          application/x-www-form-urlencoded:',
      "            example: {name: x y, tags: ['1', '2']}",
      '      responses: {"200": {description: ok}}',
      '  /upload:',
      '    post:',
      '      summary: Upload file',
      '      requestBody:',
      '        content:',
      '          multipart/form-data:',
      '            schema:',
      '              type: object',
      '              required: [file, note]',
      '              properties:',
      '                file: {type: string, contentMediaType: application/octet-stream}',
      '                note: {type: string, examples: [hello]}',
      '      responses: {"200": {description: ok}}',
      '',
    ].join('\n'));
    const binary = path.join(sources, 'all-bytes.bin');
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256));
    await fs.writeFile(binary, bytes);

    launched = await launch(userData);
    const { page } = launched;
    const activeBefore = (await page.evaluate(() => window.api.settingsGet())).activeEnvironmentId;
    const pets = await importFile(launched, petsFile);
    expect(pets).toMatchObject({ imported: true, requests: 1, groups: 2, environments: 1 });
    expect(pets.imported && pets.warnings).toEqual([
      'Select "Native Pets (OpenAPI)" and review server, parameter, body, and authentication values before sending.',
      'These server variables use the https://example.invalid placeholder because the document has no absolute server URL; set them before sending: openapi_server_1.',
      'Enter bearer tokens: POST /pets/{id}.',
    ]);
    const forms = await importFile(launched, formsFile);
    expect(forms).toMatchObject({ imported: true, requests: 2, groups: 1, environments: 1 });
    expect(forms.imported && forms.warnings).toContain('Multipart file fields start disabled with no file; select a local file and enable them before sending: POST /upload (file).');
    expect(capture.received).toEqual([]);
    expect((await page.evaluate(() => window.api.settingsGet())).activeEnvironmentId).toBe(activeBefore);

    const nodes = await page.evaluate(() => window.api.collectionList());
    const idOf = (name: string) => nodes.find((node: { name: string }) => node.name === name)!.id as string;
    const stored = (id: string) => page.evaluate(requestId => window.api.collectionExport(requestId) as Promise<Request>, id);
    const environments = await page.evaluate(() => window.api.envList());
    const environmentOf = (name: string) => environments.find(environment => environment.name === name)!;
    const petsEnvironment = environmentOf('Native Pets (OpenAPI)');
    const formsEnvironment = environmentOf('Native Forms (OpenAPI)');
    expect(petsEnvironment.variables).toEqual([{ key: 'openapi_server_1', value: 'https://example.invalid/v1', type: 'standard' }]);
    expect(formsEnvironment.variables).toEqual([{ key: 'openapi_server_1', value: 'https://example.invalid/forms', type: 'standard' }]);

    const update = await stored(idOf('Update pet'));
    expect(update).toMatchObject({
      method: 'POST', url: '{{openapi_server_1}}/pets/a%2Fb%20%25',
      parameters: [{ key: 'tag', value: 'a&b', enabled: true }, { key: 'tag', value: 'c d', enabled: true }],
      headers: [{ key: 'X-Trace', value: 'trace-1', enabled: true }, { key: 'Content-Type', value: 'application/json', enabled: true }],
      body: { type: 'raw', raw: { language: 'json', content: '{\n  "name": "Milo",\n  "tags": [\n    "x"\n  ]\n}' } },
      auth: { type: 'bearer', bearer: { token: '', prefix: 'Bearer' } },
    });
    const upload = await stored(idOf('Upload file'));
    expect(upload.body).toEqual({ type: 'multipart', multipart: [{ key: 'file', type: 'file', value: '', filePath: '', enabled: false }, { key: 'note', type: 'text', value: 'hello', enabled: true }] });

    // The user points the imported server variables at the local fixture, selects an environment, and fills in what the import left blank.
    const serverFor = (base: string) => [{ key: 'openapi_server_1', value: 'http://127.0.0.1:' + capture.port + base, type: 'standard' as const }];
    await page.evaluate(({ id, variables }) => window.api.envUpdate(id, { variables }), { id: petsEnvironment.id, variables: serverFor('/v1') });
    await page.evaluate(({ id, variables }) => window.api.envUpdate(id, { variables }), { id: formsEnvironment.id, variables: serverFor('/forms') });
    await page.evaluate(id => window.api.envSwitch(id), petsEnvironment.id);
    await page.evaluate(({ id, auth }) => window.api.collectionUpdate(id, { auth }), { id: update.id, auth: { type: 'bearer', bearer: { token: 'native-token', prefix: 'Bearer' } } });
    const file = upload.body.multipart!.map(row => row.type === 'file' ? { ...row, filePath: binary, enabled: true } : row);
    await page.evaluate(({ id, body }) => window.api.collectionUpdate(id, { body }), { id: upload.id, body: { type: 'multipart', multipart: file } });

    let operation = 0;
    const send = async (id: string, environment: Environment) => {
      const request = await stored(id);
      return page.evaluate(payload => window.api.sendRequest(payload), { operationId: 'openapi-native-' + ++operation, request, environmentId: environment.id });
    };
    expect((await send(update.id, petsEnvironment)).kind).toBe('response');
    expect((await send(idOf('Submit form'), formsEnvironment)).kind).toBe('response');
    expect((await send(upload.id, formsEnvironment)).kind).toBe('response');
    expect(capture.received).toHaveLength(3);
    const [petWire, formWire, uploadWire] = capture.received;
    expect(petWire).toMatchObject({ method: 'POST', url: '/v1/pets/a%2Fb%20%25?tag=a%26b&tag=c%20d' });
    expect(petWire.headers).toMatchObject({ 'x-trace': 'trace-1', 'content-type': 'application/json', authorization: 'Bearer native-token' });
    expect(petWire.body.toString('utf8')).toBe('{\n  "name": "Milo",\n  "tags": [\n    "x"\n  ]\n}');
    expect(formWire).toMatchObject({ method: 'POST', url: '/forms/submit' });
    expect(formWire.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(formWire.body.toString('utf8')).toBe('name=x+y&tags=1&tags=2');
    expect(uploadWire).toMatchObject({ method: 'POST', url: '/forms/upload' });
    const form = await new Response(uploadWire.body, { headers: { 'content-type': String(uploadWire.headers['content-type']) } }).formData();
    expect(form.get('note')).toBe('hello');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);

    await launched.app.close();
    launched = await launch(userData);
    const reopened = await launched.page.evaluate(() => window.api.collectionList());
    expect(reopened.map((node: { name: string }) => node.name)).toEqual(expect.arrayContaining(['Native Pets', 'Pets', 'Update pet', 'Native Forms', 'Submit form', 'Upload file']));
    const reopenedEnvironments = await launched.page.evaluate(() => window.api.envList());
    expect(reopenedEnvironments.find(environment => environment.id === formsEnvironment.id)?.variables).toEqual(serverFor('/forms'));
    expect((await launched.page.evaluate(() => window.api.settingsGet())).activeEnvironmentId).toBe(petsEnvironment.id);
  } finally {
    if (launched) await launched.app.close().catch(() => {});
    await capture.close();
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rm(sources, { recursive: true, force: true });
  }
});
