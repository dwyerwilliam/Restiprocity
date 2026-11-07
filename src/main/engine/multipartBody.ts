import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MultipartField } from '@shared/types';
import { MULTIPART_MAX_BYTES, encodeMultipartName } from '@shared/multipartPolicy';

export class MultipartError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MultipartError'; }
}
export interface UploadHandle {
  stat(): Promise<Stats>;
  readInto(target: Buffer, offset: number, length: number, position: number): Promise<number>;
  close(): Promise<void>;
}
export interface UploadFileSystem {
  statUpload(path: string): Promise<Stats>;
  openUpload(path: string): Promise<UploadHandle>;
}
export const uploadFileSystem: UploadFileSystem = {
  statUpload: file => fs.stat(file),
  async openUpload(file) {
    const handle = await fs.open(file, 'r');
    return { stat: () => handle.stat(), close: () => handle.close(),
      readInto: async (buffer, offset, length, position) => (await handle.read(buffer, offset, length, position)).bytesRead };
  },
};
export function escapeMultipartName(value: string): string {
  if (value.includes('\0')) throw new MultipartError('MULTIPART_INVALID_FIELD', 'Multipart part names cannot contain NUL.');
  return encodeMultipartName(value);
}
const same = (a: Stats, b: Stats) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev && b.isFile();
const changed = (row: number) => new MultipartError('MULTIPART_FILE_CHANGED', `Multipart row ${row}: file changed while preparing. Retry the request.`);
function fileError(error: unknown, row: number): Error {
  if (error instanceof MultipartError) return error;
  const code = (error as { code?: string })?.code;
  return new MultipartError(code === 'ENOENT' ? 'MULTIPART_FILE_NOT_FOUND' : 'MULTIPART_FILE_UNREADABLE',
    `Multipart row ${row}: ${code === 'ENOENT' ? 'file not found. Check its file path.' : 'file could not be read. Check its permissions and path.'}`);
}
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Bounded snapshot preparation; never opens a network connection. */
export async function prepareMultipart(fields: MultipartField[], fileSystem: UploadFileSystem = uploadFileSystem,
  signal?: AbortSignal, boundary = `----RestiprocityBoundary${randomBytes(16).toString('hex')}`): Promise<{ body: Buffer; contentType: string }> {
  const check = () => signal?.throwIfAborted();
  check();
  // Race the operation, not individual reads: the worker retains ownership until
  // the pending OS operation finishes, then closes its handle in finally.
  const work = async () => {
    const tail = `--${boundary}--\r\n`;
    let total = Buffer.byteLength(tail);
    const add = (size: number) => {
      total += size;
      if (!Number.isSafeInteger(size) || size < 0 || total > MULTIPART_MAX_BYTES) {
        throw new MultipartError('MULTIPART_TOO_LARGE', 'Multipart body exceeds 32 MiB, including form headers and boundaries.');
      }
    };
    const countText = async (value: string) => {
      for (let pos = 0; pos < value.length;) {
        check();
        let end = Math.min(pos + 16384, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        add(Buffer.byteLength(value.slice(pos, end)));
        pos = end;
        await yieldTurn();
      }
    };
    const parts: { head: string; value: string; file?: string; stat?: Stats; row: number }[] = [];
    for (let index = 0; index < fields.length; index++) {
      check();
      const field = fields[index];
      if (!field.enabled || !field.key) continue;
      const row = index + 1;
      const name = escapeMultipartName(field.key);
      let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
      const part: typeof parts[number] = { head: '', value: field.value, row };
      if (field.type === 'file') {
        part.file = field.filePath || field.value;
        if (!part.file || part.file.includes('\0')) throw new MultipartError('MULTIPART_INVALID_FIELD', `Multipart row ${row}: enter a valid file path.`);
        head += `; filename="${escapeMultipartName(path.basename(part.file))}"\r\nContent-Type: application/octet-stream`;
        try { part.stat = await fileSystem.statUpload(part.file); } catch (error) { check(); throw fileError(error, row); }
        check();
        if (!part.stat.isFile()) throw new MultipartError('MULTIPART_NOT_REGULAR_FILE', `Multipart row ${row}: choose a regular file.`);
        add(part.stat.size);
      } else {
        await countText(part.value);
      }
      part.head = head + '\r\n\r\n';
      await countText(part.head);
      add(2);
      parts.push(part);
      await yieldTurn();
    }
    check();
    const body = Buffer.alloc(total);
    let offset = 0;
    const write = async (value: string) => {
      for (let pos = 0; pos < value.length;) {
        check();
        let end = Math.min(pos + 16384, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        offset += body.write(value.slice(pos, end), offset, 'utf8');
        pos = end;
        await yieldTurn();
      }
    };
    for (const part of parts) {
      check();
      await write(part.head);
      const start = offset;
      if (part.file) {
        let handle: UploadHandle | undefined;
        try {
          handle = await fileSystem.openUpload(part.file);
          check();
          if (!same(part.stat!, await handle.stat())) throw changed(part.row);
          check();
          let position = 0;
          while (position < part.stat!.size) {
            check();
            const count = await handle.readInto(body, offset, Math.min(65536, part.stat!.size - position), position);
            check();
            if (count <= 0 || count > Math.min(65536, part.stat!.size - position)) throw changed(part.row);
            position += count; offset += count;
          }
          check();
          if (await handle.readInto(Buffer.alloc(1), 0, 1, position) || !same(part.stat!, await handle.stat())) throw changed(part.row);
          check();
        } catch (error) { check(); throw fileError(error, part.row); }
        finally { if (handle) { try { await handle.close(); } catch (error) { check(); throw fileError(error, part.row); } } }
      } else await write(part.value);
      if (body.subarray(start, offset).includes(Buffer.from(`--${boundary}`))) {
        throw new MultipartError('MULTIPART_BOUNDARY_COLLISION', 'Multipart boundary collided with content. Retry the request.');
      }
      await write('\r\n');
    }
    await write(tail);
    check();
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  };
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
    work().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
