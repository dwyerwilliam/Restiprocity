import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareMultipart } from '../../src/main/engine/multipartBody';
import { MULTIPART_MAX_BYTES } from '../../src/shared/multipartPolicy';

const text = (value: string) => ({ key: 'note', type: 'text' as const, value, enabled: true });
test('binary files and unicode text survive independent multipart parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multipart-'));
  try {
    const file = path.join(dir, 'bytes.bin');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await fs.writeFile(file, bytes);
    const result = await prepareMultipart([text('😀\0é'), { key: 'file', type: 'file', filePath: file, value: '', enabled: true }]);
    const form = await new Response(result.body, { headers: { 'content-type': result.contentType } }).formData();
    expect(form.get('note')).toBe('😀\0é');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('empty forms and disabled invalid files require no filesystem access', async () => {
  const result = await prepareMultipart([{ key: 'file', type: 'file', value: 'missing', enabled: false }], {
    statUpload: async () => { throw Error('unexpected stat'); }, openUpload: async () => { throw Error('unexpected open'); },
  }, undefined, 'boundary');
  expect(result.body.toString()).toBe('--boundary--\r\n');
});
test('aggregate cap includes framing and accepts exactly the limit', async () => {
  const empty = await prepareMultipart([text('')], undefined, undefined, 'boundary');
  const length = MULTIPART_MAX_BYTES - empty.body.length;
  expect((await prepareMultipart([text('x'.repeat(length))], undefined, undefined, 'boundary')).body.length).toBe(MULTIPART_MAX_BYTES);
  await expect(prepareMultipart([text('x'.repeat(length + 1))], undefined, undefined, 'boundary')).rejects.toMatchObject({ code: 'MULTIPART_TOO_LARGE' });
});
test('missing files have actionable errors without leaking their paths', async () => {
  const file = path.join(os.tmpdir(), 'does-not-exist-secret-' + Date.now());
  await expect(prepareMultipart([{ key: 'file', type: 'file', value: file, enabled: true }])).rejects.toMatchObject({
    code: 'MULTIPART_FILE_NOT_FOUND', message: 'Multipart row 1: file not found. Check its file path.',
  });
});
test('cancellation settles before a pending open and closes the eventual handle', async () => {
  const controller = new AbortController();
  const stat = await fs.stat(__filename);
  let resolveOpen!: (handle: any) => void;
  let opened!: () => void;
  const started = new Promise<void>(resolve => { opened = resolve; });
  let closed = false;
  const promise = prepareMultipart([{ key: 'file', type: 'file', value: __filename, enabled: true }], {
    statUpload: async () => stat,
    openUpload: () => { opened(); return new Promise(resolve => { resolveOpen = resolve; }); },
  }, controller.signal);
  await started;
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  resolveOpen({ close: async () => { closed = true; }, stat: async () => { throw Error('unexpected stat'); } });
  await expect.poll(() => closed).toBe(true);
});
test('file growth is detected before transmission and the handle closes', async () => {
  const stat = await fs.stat(__filename);
  let closed = false;
  await expect(prepareMultipart([{ key: 'file', type: 'file', value: __filename, enabled: true }], {
    statUpload: async () => stat,
    openUpload: async () => ({ stat: async () => stat, close: async () => { closed = true; },
      readInto: async (buffer, offset, length) => { buffer.fill(1, offset, offset + length); return length; } }),
  })).rejects.toMatchObject({ code: 'MULTIPART_FILE_CHANGED' });
  expect(closed).toBe(true);
});
test('part names reject NUL and delimiter collisions fail safely', async () => {
  await expect(prepareMultipart([{ ...text('ok'), key: 'bad\0name' }])).rejects.toMatchObject({ code: 'MULTIPART_INVALID_FIELD' });
  await expect(prepareMultipart([text('--boundary')], undefined, undefined, 'boundary')).rejects.toMatchObject({ code: 'MULTIPART_BOUNDARY_COLLISION' });
});

test('short reads, empty files, shrinkage and close failures are handled', async () => {
  const base = await fs.stat(__filename);
  for (const mode of ['short', 'empty', 'shrink', 'close'] as const) {
    const bytes = mode === 'empty' ? Buffer.alloc(0) : Buffer.from([255, 0, 128]);
    const stat = { ...base, size: bytes.length, isFile: () => true } as any;
    let closed = false;
    const task = prepareMultipart([{ key: 'file', type: 'file', value: 'fixture', enabled: true }], {
      statUpload: async () => stat,
      openUpload: async () => ({ stat: async () => stat,
        readInto: async (buffer, offset, _length, position) => mode === 'shrink' ? 0 : bytes.copy(buffer, offset, position, position + 1),
        close: async () => { closed = true; if (mode === 'close') throw new Error('private path'); },
      }),
    });
    if (mode === 'shrink' || mode === 'close') await expect(task).rejects.toMatchObject({ code: mode === 'shrink' ? 'MULTIPART_FILE_CHANGED' : 'MULTIPART_FILE_UNREADABLE' });
    else {
      const result = await task;
      const form = await new Response(result.body, { headers: { 'content-type': result.contentType } }).formData();
      expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(bytes);
    }
    expect(closed).toBe(true);
  }
});
