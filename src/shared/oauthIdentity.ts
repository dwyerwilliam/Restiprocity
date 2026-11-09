import type { OAuth2Config } from './types';
import type { VariableContext } from './variableContext';

const NONDETERMINISTIC_OAUTH_KEYS = new Set(['timestamp', 'randomInt', 'uuid']);
const NONDETERMINISTIC_OAUTH_REFERENCE = /\{\{\s*(timestamp|randomInt|uuid)\s*\}\}/i;

export function containsNondeterministicOAuthReference(value: string, context?: Pick<VariableContext, 'resolve'>): boolean {
  if (NONDETERMINISTIC_OAUTH_REFERENCE.test(value)) return true;
  if (!context) return false;
  return context.resolve(value).dependencies.some(key => NONDETERMINISTIC_OAUTH_KEYS.has(key));
}

export function oauthIdentityValues(config: OAuth2Config): string[] {
  return [
    config.authorizationUrl,
    config.tokenUrl,
    config.clientId,
    config.clientSecret,
    config.scope,
    config.redirectUri,
    config.expectedIssuer ?? '',
    ...(config.authorizationParameters ?? []).flatMap(row => [row.key, row.value]),
  ];
}
