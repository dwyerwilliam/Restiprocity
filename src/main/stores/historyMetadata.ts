import type { Request } from '@shared/types';

export type HistoryRequestMetadata = {
  readonly requestName: string;
  readonly method: Request['method'];
  readonly url: string;
};

const SENSITIVE_KEYS = new Set([
  'access_token', 'refresh_token', 'token', 'api_key', 'apikey', 'key',
  'password', 'passwd', 'client_secret',
]);
const TEMPLATE = /\{\{\s*\w+\s*\}\}/g;

export function buildHistoryRequestMetadata(request: Request): HistoryRequestMetadata {
  const metadata = { requestName: request.name, method: request.method, url: '' };
  try {
    const authored = request.url.split('#', 1)[0];
    const masked = authored.replace(TEMPLATE, 'template');
    if (/[\s\\{}]/.test(masked) || /%(?![\da-f]{2})/i.test(masked)) return metadata;
    const parts = /^(https?:\/\/)([^/?#]+)([^#]*)$/i.exec(authored);
    if (!parts) return metadata;
    const [, scheme, authority, tail] = parts;
    const parsed = new URL(masked);
    if (!parsed.hostname || authority.split('@').length > 2) return metadata;
    const host = authority.slice(authority.lastIndexOf('@') + 1);
    if (!host || host.startsWith(':')) return metadata;
    const secrets = new Set([
      request.auth.bearer?.token, request.auth.api_key?.value,
      request.auth.basic?.password, request.auth.oauth2?.clientSecret,
      request.auth.ntlm?.password,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0));
    const keys = new Set(SENSITIVE_KEYS);
    if (request.auth.api_key?.in === 'query') keys.add(request.auth.api_key.key.trim().toLowerCase());
    const question = tail.indexOf('?');
    if (question < 0) return { ...metadata, url: `${scheme}${host}${tail}` };
    const query = tail.slice(question + 1).split('&').map((pair) => {
      const equals = pair.indexOf('=');
      const key = equals < 0 ? pair : pair.slice(0, equals);
      const value = equals < 0 ? '' : pair.slice(equals + 1);
      const decodedKey = decodeURIComponent(key.replace(/\+/g, ' ')).toLowerCase();
      const decodedValue = decodeURIComponent(value.replace(/\+/g, ' '));
      const tokenOnly = /^(?:\{\{\s*\w+\s*\}\})+$/.test(decodedValue);
      return !tokenOnly && (keys.has(decodedKey) || secrets.has(decodedValue))
        ? `${key}=[REDACTED]` : pair;
    }).join('&');
    return { ...metadata, url: `${scheme}${host}${tail.slice(0, question)}?${query}` };
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return metadata;
    throw error;
  }
}
