import { test, expect } from '@playwright/test';
import { _electron, type ElectronApplication } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import type { Request } from '../../src/shared/types';

const root = path.resolve(__dirname, '../..');
test('multipart bytes, errors, empty forms, redirects and Electron fetch use real transports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-multipart-'));
  const harness = path.join(root, `.multipart-harness-${process.pid}.cjs`);
  let app: ElectronApplication | undefined;
  const received: { url: string; bytes: Buffer; type: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ url: req.url!, bytes: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? '') });
    if (req.url === '/redirect') { res.writeHead(307, { location: '/upload' }); res.end(); }
    else { res.setHeader('Content-Type', 'text/plain'); res.end('ok'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const file = path.join(dir, 'all-bytes.bin');
  const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  await fs.writeFile(file, bytes);
  const req: Request = { id: 'multipart-native', name: 'Multipart', method: 'POST', url: url + '/upload', parameters: [],
    headers: [{ key: 'Content-Type', value: 'multipart/form-data; boundary=wrong', enabled: true }, { key: 'Content-Length', value: '1', enabled: true }],
    body: { type: 'multipart', multipart: [{ key: 'note', value: '😀', type: 'text', enabled: true }, { key: 'file', value: file, type: 'file', enabled: true }] },
    auth: { type: 'none' }, settings: { timeout: 5000, followRedirect: true }, scripts: {}, createdAt: 0, updatedAt: 0 };
  const inspect = async (item: typeof received[number]) => {
    const form = await new Response(item.bytes, { headers: { 'content-type': item.type } }).formData();
    expect(form.get('note')).toBe('😀');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
  };
  try {
    app = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof window.api?.sendRequest === 'function');
    let op = 0;
    const send = (request: Request) => page.evaluate(payload => window.api.sendRequest(payload), { operationId: `multipart-${++op}`, request });
    expect((await send(req)).kind).toBe('response'); await inspect(received[0]);
    const history = await page.evaluate(() => window.api.historyList());
    const count = received.length;
    const invalid = structuredClone(req); invalid.body.multipart![1].value = path.join(dir, 'secret-missing');
    invalid.auth = { type: 'oauth2', oauth2: { grantType: 'client_credentials', tokenUrl: url + '/token', clientId: 'id', clientSecret: 'secret', scope: '' } };
    const failed = await send(invalid);
    expect(failed).toMatchObject({ kind: 'failed', error: { kind: 'body', code: 'MULTIPART_FILE_NOT_FOUND' } });
    expect(JSON.stringify(failed)).not.toContain('secret-missing');
    expect(received).toHaveLength(count);
    expect((await page.evaluate(() => window.api.historyList())).length).toBe(history.length);
    expect((await send({ ...req, body: { type: 'multipart' } })).kind).toBe('response');
    expect(received.at(-1)!.bytes.toString()).toMatch(/^--.*--\r\n$/);
    expect((await send({ ...req, url: url + '/redirect' })).kind).toBe('response');
    await inspect(received.at(-1)!); await inspect(received.at(-2)!);
    const importFile = path.join(dir, 'insomnia.json');
    await fs.writeFile(importFile, JSON.stringify({ _type: 'export', __export_format: 4, resources: [
      { _id: 'wrk_upload', _type: 'workspace', name: 'Uploads' },
      { _id: 'req_upload', _type: 'request', parentId: 'wrk_upload', name: 'Imported upload', url: req.url, method: 'POST',
        headers: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=stale' }],
        body: { mimeType: 'multipart/form-data', params: [{ name: 'note', value: '😀' }, { name: 'file', type: 'file', fileName: file }] } },
    ] }));
    await app.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog; }, importFile);
    expect(await page.evaluate(() => window.api.importCollectionFile())).toMatchObject({ imported: true });
    const imported = await page.evaluate(async () => {
      const nodes = await window.api.collectionList();
      const node = nodes.find(item => item.name === 'Imported upload')!;
      return await window.api.collectionExport(node.id) as Request;
    });
    expect((await send(imported)).kind).toBe('response'); await inspect(received.at(-1)!);
    // A test-owned bundle exercises the fallback with real Electron session.fetch;
    // production IPC remains unchanged.
    await build({ stdin: { contents: "export { RequestEngine } from './src/main/engine/requestEngine';", resolveDir: root }, outfile: harness,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', tsconfig: path.join(root, 'tsconfig.json') });
    const result = await app.evaluate(async ({ session, app }, data) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
      const { RequestEngine } = load(data.harness);
      const engine = new RequestEngine(session.defaultSession, undefined, { responseTransport: 'fetch' });
      return (await engine.executeV2({ request: data.req })).status;
    }, { harness, req });
    expect(result).toBe(200); await inspect(received.at(-1)!);
    // Observe the real IPC handler's clipboard boundary without depending on
    // ownership of the machine's shared desktop clipboard.
    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText.bind(clipboard);
      (globalThis as any).__multipartClipboardWrites = 0;
      clipboard.writeText = (...args) => { (globalThis as any).__multipartClipboardWrites++; original(...args); };
    });
    const copied = await page.evaluate(request => window.api.copyRequestAsCurl({ request }), { ...req, body: { type: 'multipart', multipart: [{ key: 'bad=name', value: 'v', type: 'text', enabled: true }] } } as Request);
    expect(copied.copied).toBe(false);
    expect(await app.evaluate(() => (globalThis as any).__multipartClipboardWrites)).toBe(0);
  } finally {
    if (app) await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(harness, { force: true }); await fs.rm(dir, { recursive: true, force: true });
  }
});
