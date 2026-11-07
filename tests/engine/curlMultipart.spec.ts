import { test, expect } from '@playwright/test';
import { buildCurlCommand } from '../../src/shared/curlExport';
import { prepareMultipart } from '../../src/main/engine/multipartBody';
import type { Request } from '../../src/shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('generated POSIX cURL preserves multipart semantics against a real server', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'curl-multipart-'));
  const file = path.join(dir, 'file with spaces.bin'); await fs.writeFile(file, Buffer.from([0, 128, 255, 13, 10]));
  const received: { body: Buffer; type: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ body: Buffer.concat(chunks), type: String(req.headers['content-type']) }); res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  const request: Request = { id: 'curl', name: 'curl', method: 'POST', url, headers: [{ key: 'CONTENT-TYPE', value: 'broken', enabled: true }, { key: 'Content-Length', value: '1', enabled: true }], parameters: [],
    body: { type: 'multipart', multipart: [
      { key: 'quote"\\\r\n😀', value: '@literal;type=hello', enabled: true, type: 'text' },
      { key: 'duplicate', value: '<literal', enabled: true, type: 'text' }, { key: 'duplicate', value: 'second', enabled: true, type: 'text' },
      { key: 'upload', filePath: file, value: '', enabled: true, type: 'file' },
    ] }, auth: { type: 'none' }, settings: { timeout: 5000, followRedirect: true }, scripts: {}, createdAt: 0, updatedAt: 0 };
  try {
    const expected = await prepareMultipart(request.body.multipart!);
    const canonical = async (body: Buffer, type: string) => {
      const form = await new Response(body, { headers: { 'content-type': type } }).formData();
      return Promise.all([...form.entries()].map(async ([key, value]) => [key, typeof value === 'string' ? value : { name: value.name, bytes: Buffer.from(await value.arrayBuffer()).toString('hex') }]));
    };
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
    const script = path.join(dir, 'request.sh');
    for (const empty of [false, true]) {
      const chosen = empty ? { ...request, body: { type: 'multipart' as const } } : request;
      let command = buildCurlCommand(chosen, { url, fileBasename: path.basename }).command;
      if (process.platform === 'win32') command = command.replace(/^curl/, 'C:/Windows/System32/curl.exe');
      await fs.writeFile(script, command, 'utf8');
      await exec(bash, [script.replace(/\\/g, '/')], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      const last = received.at(-1)!;
      if (empty) expect(last.body.toString()).toBe('------RestiprocityEmptyForm--\r\n');
      else expect(await canonical(last.body, last.type)).toEqual(await canonical(expected.body, expected.contentType));
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); }
});
