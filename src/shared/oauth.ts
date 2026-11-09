import { createHash, randomBytes } from 'node:crypto';
import type { OAuth2Config, OAuth2GrantType, OAuth2Parameter, Request } from './types';

export const OAUTH_CALLBACK_HOST = '127.0.0.1';
export const OAUTH_CALLBACK_PORT = 42813;
export const OAUTH_CALLBACK_PREFIX = '/oauth/callback/';
export const OAUTH_MAX_AUTHORIZATION_URL = 2081;
export const OAUTH_MAX_CALLBACK_URL = 16 * 1024;
export const OAUTH_MAX_TOKEN_RESPONSE = 1024 * 1024;
export function normalizeOAuthGrant(grant: OAuth2GrantType): 'authorization_code' | 'client_credentials' | 'password' | 'unsupported' {
  if (grant === 'pkce' || grant === 'authorization_code') return 'authorization_code';
  if (grant === 'client_credentials') return grant;
  if (grant === 'password') return grant;
  return 'unsupported';
}

export function isBrowserOAuth(config: OAuth2Config): boolean {
  return normalizeOAuthGrant(config.grantType) === 'authorization_code';
}

export function oauthClientAuthentication(config: OAuth2Config): 'none' | 'basic' | 'body' {
  if (config.clientAuthentication) return config.clientAuthentication;
  return config.grantType === 'client_credentials' ? 'body' : (config.clientSecret ? 'body' : 'none');
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createPkcePair(random: () => Uint8Array = () => randomBytes(32)): { state: string; verifier: string; challenge: string } {
  const state = base64Url(random());
  const verifier = base64Url(random());
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { state, verifier, challenge };
}

export function providerCallbackId(config: OAuth2Config): string {
  const normalized = JSON.stringify({ authorizationUrl: config.authorizationUrl, tokenUrl: config.tokenUrl });
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function callbackUri(config: OAuth2Config, host = OAUTH_CALLBACK_HOST, port = OAUTH_CALLBACK_PORT): string {
  const normalizedHost = host.replace(/^\[|\]$/g, '');
  return 'http://' + (normalizedHost.includes(':') ? '[' + normalizedHost + ']' : normalizedHost) + ':' + port + OAUTH_CALLBACK_PREFIX + providerCallbackId(config);
}

export function parseHttpsOrLoopback(value: string, field: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} must be a valid URL.`); }
  if (parsed.username || parsed.password || parsed.hash || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} contains unsupported URL characters.`);
  if (parsed.protocol === 'https:') return parsed;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol === 'http:' && (hostname === '127.0.0.1' || hostname === '::1')) return parsed;
  throw new Error(`${field} must use HTTPS, or HTTP on the loopback interface.`);
}

const RESERVED_AUTH = new Set(['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'client_secret', 'access_token', 'refresh_token', 'code', 'code_verifier']);

export function enabledOAuthParameters(parameters: OAuth2Parameter[] | undefined): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  const singleton = new Set<string>();
  for (const row of parameters ?? []) {
    if (!row.enabled) continue;
    const key = row.key.trim();
    if (!key || RESERVED_AUTH.has(key.toLowerCase())) throw new Error(`OAuth parameter "${key || '(empty)'}" is reserved.`);
    if (singleton.has(key.toLowerCase()) && key.toLowerCase() !== 'resource') throw new Error(`OAuth parameter "${key}" is duplicated.`);
    singleton.add(key.toLowerCase());
    result.push([key, row.value]);
  }
  return result;
}

export function buildAuthorizationUrl(config: OAuth2Config, state: string, challenge: string, redirect = config.redirectUri): string {
  const url = parseHttpsOrLoopback(config.authorizationUrl, 'Authorization URL');
  for (const key of url.searchParams.keys()) if (RESERVED_AUTH.has(key.toLowerCase())) throw new Error('Authorization URL contains protocol parameters that Restiprocity controls.');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirect);
  if (config.scope) url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of enabledOAuthParameters(config.authorizationParameters)) url.searchParams.append(key, value);
  const result = url.toString();
  if (result.length > OAUTH_MAX_AUTHORIZATION_URL) throw new Error('Authorization URL is too long for the system browser.');
  return result;
}

export function buildOAuthBindingKey(request: Pick<Request, 'id' | 'url'>, environmentId: string | undefined, config: OAuth2Config, origin: string): string {
  const normalizeParameters = (parameters: OAuth2Parameter[] | undefined) => (parameters ?? []).filter(row => row.enabled).map(row => ({ key: row.key.trim(), value: row.value }));
  const payload = JSON.stringify({ requestId: request.id, environmentId: environmentId ?? 'core', grant: normalizeOAuthGrant(config.grantType), authorizationUrl: config.authorizationUrl, tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, scope: config.scope, redirectUri: config.redirectUri, clientAuthentication: oauthClientAuthentication(config), expectedIssuer: config.expectedIssuer ?? '', authorizationParameters: normalizeParameters(config.authorizationParameters), tokenParameters: normalizeParameters(config.tokenParameters), origin });
  return createHash('sha256').update(payload).digest('hex');
}

export function parseExpiresIn(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) { const parsed = Number(value); if (Number.isSafeInteger(parsed)) return parsed; throw new Error('OAuth token response has an invalid expires_in value.'); }
  throw new Error('OAuth token response has an invalid expires_in value.');
}

export function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024 && !/[\u0000-\u001f\u007f]/.test(value);
}
