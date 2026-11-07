import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { uploadFileSystem } from '../../src/main/engine/multipartBody';
import { createNetResponseFixture, DeterministicTimers } from './fixtures/httpResponseFixture';
import type { Request } from '../../src/shared/types';

const request = (patch: Partial<Request> = {}): Request => ({ id: 'upload', name: 'Upload', method: 'POST', url: 'http://example.test/upload',
  headers: [{ key: 'Content-Type', value: '{{cycle}}', enabled: true }], parameters: [], body: { type: 'multipart', multipart: [{ key: 'note', type: 'text', value: 'hello', enabled: true }] },
  auth: { type: 'none' }, scripts: {}, settings: { timeout: 100, followRedirect: true }, createdAt: 0, updatedAt: 0, ...patch });
const store = { getActiveEnvironmentId: () => undefined } as any;
const oauth = { type: 'oauth2' as const, oauth2: { grantType: 'client_credentials' as const, tokenUrl: 'http://example.test/token', clientId: 'id', clientSecret: 'secret', scope: '' } };

for (const version of ['v2', 'legacy'] as const) for (const transport of ['net', 'fetch'] as const) {
  test(`${version} ${transport} submits binary parts and validates before OAuth`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-engine-'));
    try {
      const file = path.join(dir, 'bytes.bin'); const bytes = Buffer.from([0, 255, 128, 195, 40]); await fs.writeFile(file, bytes);
      const timers = new DeterministicTimers(); let sent: any; let calls = 0;
      const engine = new RequestEngine({} as any, store, { responseTransport: transport, timers, captureConnectionTimings: async () => null,
        clock: { monotonicNow: () => timers.now, wallNow: () => 0 },
        fetch: async (_session, _url, init) => { calls++; sent = { body: init.body, headers: init.headers }; return new Response('ok'); },
        netRequest: () => {
          calls++;
          const fixture = createNetResponseFixture({ chunks: [{ data: 'ok' }], headers: { 'content-type': 'text/plain' } }, timers);
          const end = fixture.request.end.bind(fixture.request);
          fixture.request.end = (body?: string | Buffer) => { sent = { body, headers: Object.fromEntries(fixture.request.headers) }; end(); queueMicrotask(() => timers.runReady()); return fixture.request; };
          return fixture.request;
        },
      });
      const send = (req: Request) => version === 'v2' ? engine.executeV2({ request: req }) : engine.execute({ request: req });
      const req = request({ body: { type: 'multipart', multipart: [{ key: 'file', value: file, enabled: true, type: 'file' }] } });
      const original = structuredClone(req);
      await send(req);
      const form = await new Response(sent.body, { headers: sent.headers }).formData();
      expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
      expect(req).toEqual(original);
      expect(timers.pendingCount).toBe(0);
      await fs.unlink(file); calls = 0;
      await expect(send({ ...req, auth: oauth })).rejects.toMatchObject({ requestError: { kind: 'body', code: 'MULTIPART_FILE_NOT_FOUND' } });
      expect(calls).toBe(0);
      expect(timers.pendingCount).toBe(0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test('preparation and OAuth share the deadline, and late tokens cannot enter the cache', async () => {
  const timers = new DeterministicTimers(); let resolveToken!: (value: any) => void; let tokenStarted = false; let calls = 0;
  const engine = new RequestEngine({} as any, store, { responseTransport: 'fetch', timers, captureConnectionTimings: async () => null,
    clock: { monotonicNow: () => timers.now, wallNow: () => 0 },
    fetch: async () => { calls++; tokenStarted = true; return new Promise(resolve => { resolveToken = resolve; }); },
  });
  const result = engine.executeV2({ request: request({ auth: oauth }) }).catch(error => error);
  await expect.poll(() => tokenStarted).toBe(true);
  timers.advanceBy(100);
  expect((await result).requestError.kind).toBe('timeout');
  resolveToken(new Response(JSON.stringify({ access_token: 'late-secret', expires_in: 3600 })));
  await new Promise(resolve => setImmediate(resolve));
  const exported = await engine.exportCurl({ request: request({ auth: oauth }) });
  expect(exported.command).not.toContain('late-secret');
  expect(calls).toBe(1); expect(timers.pendingCount).toBe(0);
});

test('cancel during stat settles immediately and a subsequent send succeeds', async () => {
  const timers = new DeterministicTimers(); let pending = false; let network = 0;
  const engine = new RequestEngine({} as any, store, { responseTransport: 'fetch', timers, captureConnectionTimings: async () => null,
    uploadFileSystem: { ...uploadFileSystem, statUpload: async () => { pending = true; return new Promise(() => {}); } },
    fetch: async () => { network++; return new Response('ok'); },
  });
  const result = engine.executeV2({ request: request({ body: { type: 'multipart', multipart: [{ key: 'file', value: 'file', type: 'file', enabled: true }] } }) }).catch(error => error);
  await expect.poll(() => pending).toBe(true); engine.cancel();
  expect((await result).requestError.kind).toBe('cancelled'); expect(network).toBe(0);
  await engine.executeV2({ request: request({ settings: { timeout: 0, followRedirect: true } }) });
  expect(network).toBe(1); expect(timers.pendingCount).toBe(0);
});

test('file preparation consumes the same budget as waiting for target headers', async () => {
  const timers = new DeterministicTimers(); let waiting = false;
  const stat = { size: 0, mtimeMs: 0, ino: 1, dev: 1, isFile: () => true } as any;
  const engine = new RequestEngine({} as any, store, { responseTransport: 'fetch', timers, captureConnectionTimings: async () => null,
    clock: { monotonicNow: () => timers.now, wallNow: () => 0 },
    uploadFileSystem: { statUpload: async () => { timers.advanceBy(80); return stat; }, openUpload: async () => ({ stat: async () => stat, readInto: async () => 0, close: async () => {} }) },
    fetch: async () => { waiting = true; return new Promise(() => {}); },
  });
  const task = engine.executeV2({ request: request({ body: { type: 'multipart', multipart: [{ key: 'file', value: 'file', type: 'file', enabled: true }] } }) }).catch(error => error);
  await expect.poll(() => waiting).toBe(true);
  timers.advanceBy(19); expect(timers.pendingCount).toBe(1);
  timers.advanceBy(1); expect((await task).requestError.kind).toBe('timeout'); expect(timers.pendingCount).toBe(0);
});
