import type { OAuth2Config, OAuth2Parameter } from './types';
import type { VariableContext } from './variableContext';

const NONDETERMINISTIC_OAUTH_KEYS = new Set(['timestamp', 'randomInt', 'uuid']);
const NONDETERMINISTIC_OAUTH_REFERENCE = /\{\{\s*(timestamp|randomInt|uuid)\s*\}\}/i;

export function containsNondeterministicOAuthReference(value: string, context?: Pick<VariableContext, 'resolve'>): boolean {
  if (NONDETERMINISTIC_OAUTH_REFERENCE.test(value)) return true;
  if (!context) return false;
  return context.resolve(value).dependencies.some(key => NONDETERMINISTIC_OAUTH_KEYS.has(key));
}

export interface OAuthIdentityInputs {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  expectedIssuer: string;
  authorizationParameters: Array<{ key: string; value: string }>;
  tokenParameters: Array<{ key: string; value: string }>;
}

const enabledRows = (rows: OAuth2Parameter[] | undefined) => (rows ?? []).filter(row => row.enabled).map(row => ({ key: row.key.trim(), value: row.value }));

/**
 * The authored configuration that decides which token a request uses. The binding key hashes exactly this and the
 * nondeterminism check inspects exactly this, so a field added here is both bound and checked. Disabled rows are
 * never sent and are not part of it.
 */
export function oauthIdentityInputs(config: OAuth2Config): OAuthIdentityInputs {
  return {
    authorizationUrl: config.authorizationUrl,
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scope: config.scope,
    redirectUri: config.redirectUri,
    expectedIssuer: config.expectedIssuer ?? '',
    authorizationParameters: enabledRows(config.authorizationParameters),
    tokenParameters: enabledRows(config.tokenParameters),
  };
}

/**
 * The part of an authored request URL that decides its origin: everything before the first path, query or fragment
 * delimiter that is outside a {{reference}}. A URL that starts with a reference (`{{base_url}}/items`) contributes
 * only that reference. A bound token is per origin, so the rest of the URL may vary from send to send.
 */
export function oauthOriginPart(url: string): string {
  let index = 0;
  let pastSchemeSeparator = false;
  while (index < url.length) {
    if (url.startsWith('{{', index)) {
      const end = url.indexOf('}}', index + 2);
      if (end === -1) return url;
      index = end + 2;
      continue;
    }
    const character = url[index];
    if (!pastSchemeSeparator && character === '/' && url[index - 1] === ':' && url[index + 1] === '/') {
      pastSchemeSeparator = true;
      index += 2;
      continue;
    }
    if (character === '/' || character === '?' || character === '#') break;
    index++;
  }
  return url.slice(0, index);
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Every authored string that sets the identity of a token: the configuration inputs and the request origin. */
export function oauthIdentityValues(config: OAuth2Config, requestUrl: string): string[] {
  return [oauthOriginPart(requestUrl), ...stringsIn(oauthIdentityInputs(config))];
}
