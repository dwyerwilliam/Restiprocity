import type { Request } from './types';

/** Maximum encoded multipart body, including all framing. */
export const MULTIPART_MAX_BYTES = 32 * 1024 * 1024;

export function isActiveMultipart(request: Pick<Request, 'method' | 'body'>): boolean {
  return request.body.type === 'multipart' && request.method !== 'GET' && request.method !== 'HEAD';
}

export function isMultipartManagedHeader(name: string): boolean {
  return ['content-type', 'content-length', 'transfer-encoding'].includes(name.toLowerCase());
}

/** Encoding used in multipart Content-Disposition quoted parameters. */
export function encodeMultipartName(value: string): string {
  return value.replace(/["\\\r\n]/g, c => ({ '"': '%22', '\\': '%5C', '\r': '%0D', '\n': '%0A' })[c]!);
}
