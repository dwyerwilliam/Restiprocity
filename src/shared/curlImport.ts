import { parseCurlCommand } from 'curl-parser-ts';
import type { CurlParseResult } from 'curl-parser-ts';
import { HttpMethod, Request, RequestBody, AuthConfig, Header, QueryParameter } from './types';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function toHttpMethod(method: string): HttpMethod {
  const normalized = method.toUpperCase();
  return HTTP_METHODS.includes(normalized as HttpMethod) ? normalized as HttpMethod : 'GET';
}

function parsedRecordToRows(record: Record<string, string>): QueryParameter[] {
  return Object.entries(record).map(([key, value]) => ({ key, value, enabled: true }));
}

function parsedHeadersToRows(headers: Record<string, string>, cookies: Record<string, string>): Header[] {
  const rows = Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true }));
  const cookieHeader = Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');

  return cookieHeader ? [...rows, { key: 'Cookie', value: cookieHeader, enabled: true }] : rows;
}

function parsedBodyFn(parsed: CurlParseResult): RequestBody {
  if (parsed.multipartFormData) {
    return {
      type: 'multipart',
      multipart: Object.entries(parsed.multipartFormData).map(([key, value]) => ({
        key,
        type: 'text',
        value,
        enabled: true,
      })),
    };
  }

  if (parsed.formData) {
    return {
      type: 'form-urlencoded',
      form: Object.entries(parsed.formData).map(([key, value]) => ({ key, value, enabled: true })),
    };
  }

  if (!parsed.data) {
    return { type: 'none' };
  }

  const contentType = Object.entries(parsed.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  const language = contentType.includes('json') || /^[\s]*[\[{]/.test(parsed.data) ? 'json' : 'text';

  return {
    type: 'raw',
    raw: {
      language,
      content: parsed.data,
    },
  };
}

function parsedAuthFn(parsed: CurlParseResult): AuthConfig {
  if (!parsed.auth) return { type: 'none' };

  const [username, password = ''] = parsed.auth.split(':', 2);
  return {
    type: 'basic',
    basic: { username, password },
  };
}

function requestNameFromUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    return `${parsedUrl.hostname}${parsedUrl.pathname === '/' ? '' : parsedUrl.pathname}`;
  } catch {
    return url || 'Imported cURL Request';
  }
}

export function buildRequestFromCurl(curlCommand: string, idGenerator: () => string): Request {
  const parsed = parseCurlCommand(curlCommand);
  const now = Date.now();

  if (!parsed.url) {
    throw new Error('Clipboard cURL command does not include a URL.');
  }

  return {
    id: idGenerator(),
    name: requestNameFromUrl(parsed.url),
    method: toHttpMethod(parsed.method),
    url: parsed.url,
    headers: parsedHeadersToRows(parsed.headers, parsed.cookies),
    parameters: parsedRecordToRows(parsed.query),
    body: parsedBodyFn(parsed),
    auth: parsedAuthFn(parsed),
    settings: {
      followRedirect: parsed.followRedirects,
      timeout: parsed.timeout ? Number(parsed.timeout) * 1000 : 30000,
      cookiesEnabled: true,
      allowInsecureCertificates: parsed.insecure,
    },
    scripts: {},
    createdAt: now,
    updatedAt: now,
  };
}
