import { isActiveMultipart, isMultipartManagedHeader, encodeMultipartName } from './multipartPolicy';
import type { Request } from './types';

export interface CurlExportOptions {
  /** Final URL with enabled query parameters (and query API keys) already merged in. */
  url: string;
  /** A still-valid cached OAuth 2.0 access token; export never performs a token exchange. */
  oauth2AccessToken?: string;
  fileBasename?: (path: string) => string;
}

export interface CurlCommand {
  command: string;
  /** Ways the command knowingly differs from what Send would transmit. */
  warnings: string[];
}

/** POSIX shell single-quoting (bash, zsh, Git Bash). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a cURL command that mirrors what `RequestEngine` sends for an already-interpolated
 * request: the same header precedence (auth and User-Agent overwrite authored headers), the same
 * body serialization, and no body for GET/HEAD. Cookies from the app-session jar are not included;
 * authored Cookie headers are.
 */
export function buildCurlCommand(request: Request, options: CurlExportOptions): CurlCommand {
  const args: string[] = [];
  const warnings: string[] = [];
  const headers = new Map<string, { key: string; value: string }>();
  const setHeader = (key: string, value: string) => headers.set(key.toLowerCase(), { key, value });

  for (const header of request.headers) {
    if (header.enabled && header.key) setHeader(header.key, header.value);
  }

  const { auth } = request;
  switch (auth.type) {
    case 'bearer':
      if (auth.bearer?.token) setHeader('Authorization', `${auth.bearer.prefix || 'Bearer'} ${auth.bearer.token}`);
      break;
    case 'api_key':
      if (auth.api_key?.key && auth.api_key.value && auth.api_key.in === 'header') setHeader(auth.api_key.key, auth.api_key.value);
      break;
    case 'basic':
      if (auth.basic?.username && auth.basic.password) {
        setHeader('Authorization', `Basic ${toBase64(`${auth.basic.username}:${auth.basic.password}`)}`);
      }
      break;
    case 'oauth2':
      if (options.oauth2AccessToken) {
        setHeader('Authorization', 'Bearer ' + options.oauth2AccessToken);
      } else if (auth.oauth2?.grantType !== 'client_credentials') {
        warnings.push('OAuth 2.0 grants other than Client Credentials send no token, so no Authorization header was added.');
      } else {
        warnings.push('No cached OAuth 2.0 token: send the request once, then copy again to include its Authorization header.');
      }
      break;
    case 'ntlm':
      args.push('--ntlm');
      if (auth.ntlm?.useCurrentAuthContext !== false) {
        // An empty user makes curl use the logged-in Windows account (SSPI).
        args.push('-u', shellQuote(':'));
      } else {
        const user = auth.ntlm.domain ? `${auth.ntlm.domain}\\${auth.ntlm.username || ''}` : auth.ntlm.username || '';
        args.push('-u', shellQuote(`${user}:${auth.ntlm.password || ''}`));
      }
      break;
  }

  if (isActiveMultipart(request)) {
    for (const key of headers.keys()) if (isMultipartManagedHeader(key)) headers.delete(key);
  }
  headers.delete('user-agent');
  args.push('-A', shellQuote(request.settings.userAgent?.trim() || 'Restiprocity'));

  for (const { key, value } of headers.values()) {
    args.push('-H', shellQuote(`${key}: ${value}`));
  }

  const sendsBody = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD';
  if (sendsBody) appendBody(request, args, warnings, headers.has('content-type'), options);

  if (request.settings.followRedirect) args.push('-L');
  if (request.settings.allowInsecureCertificates) args.push('-k');
  // -m rather than --max-time: the app's own cURL import only understands the short form.
  if (request.settings.timeout > 0) args.push('-m', String(request.settings.timeout / 1000));

  const method = request.method === 'HEAD' ? ' --head' : request.method === 'GET' ? '' : ` -X ${request.method}`;
  const command = [`curl${method} ${shellQuote(options.url)}`, ...pairArgs(args)].join(' \\\n  ');
  return { command, warnings };
}

function appendBody(request: Request, args: string[], warnings: string[], hasContentType: boolean, options: CurlExportOptions): void {
  const { body } = request;
  if (body.type === 'raw' && body.raw) {
    args.push('--data-raw', shellQuote(body.raw.content));
    if (!hasContentType) {
      warnings.push('No Content-Type header is set; curl will send application/x-www-form-urlencoded for this body.');
    }
  } else if (body.type === 'form-urlencoded' && body.form) {
    const params = new URLSearchParams();
    for (const field of body.form) {
      if (field.enabled) params.append(field.key, field.value);
    }
    args.push('--data-raw', shellQuote(params.toString()));
  } else if (body.type === 'multipart') {
    const fields = (body.multipart ?? []).filter(field => field.enabled && field.key);
    warnings.push("cURL does not enforce Restiprocity's 32 MiB multipart limit.");
    if (!fields.length) {
      const boundary = '----RestiprocityEmptyForm';
      args.push('-H', shellQuote(`Content-Type: multipart/form-data; boundary=${boundary}`));
      // ANSI-C quoting preserves CRLF even when Git Bash normalizes script line endings.
      args.push('--data-raw', `$'--${boundary}--\\r\\n'`);
    }
    if (fields.some(field => field.type === 'file')) warnings.push('File paths are local; cURL reads their contents when it runs.');
    const quoteForm = (value: string) => value.replace(/(["\\])/g, '\\$1');
    for (const field of fields) {
      if (field.key.includes('=') || field.key.includes('\0')) throw new Error('This multipart field name cannot be represented in cURL. Remove equals signs or NUL characters.');
      const name = encodeMultipartName(field.key);
      if (field.type === 'file') {
        const filePath = field.filePath || field.value;
        if (!filePath || filePath.includes('\0')) throw new Error('Enter a valid multipart file path before exporting.');
        const filename = options.fileBasename?.(filePath) ?? filePath.split(/[\\/]/).pop()!;
        args.push('-F', shellQuote(`${name}=@"${quoteForm(filePath)}";type=application/octet-stream;filename="${quoteForm(encodeMultipartName(filename))}"`));
      } else {
        if (field.value.includes('\0')) throw new Error('Multipart text containing NUL cannot be represented in a cURL command.');
        args.push('--form-string', shellQuote(`${name}=${field.value}`));
      }
    }
  }
}

/** Keeps each flag on the same line as its value. */
function pairArgs(args: string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg.startsWith('-') && next !== undefined && !next.startsWith('-')) {
      lines.push(`${arg} ${next}`);
      index += 1;
    } else {
      lines.push(arg);
    }
  }
  return lines;
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
