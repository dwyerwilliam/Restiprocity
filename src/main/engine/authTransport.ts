import { OAuth2Config, NtlmConfig } from '../../shared/types';

export interface OAuth2TokenExchangeRequest {
  url: string;
  init: RequestInit;
  cacheKey: string;
}

export function buildOAuth2CacheKey(config: OAuth2Config): string {
  return [
    config.grantType,
    config.authorizationUrl,
    config.tokenUrl,
    config.clientId,
    config.clientSecret,
    config.scope,
    config.redirectUri,
  ].join('\n');
}

export function buildOAuth2TokenExchangeRequest(config: OAuth2Config, signal?: AbortSignal): OAuth2TokenExchangeRequest {
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', config.clientId);
  params.set('client_secret', config.clientSecret);

  if (config.scope) {
    params.set('scope', config.scope);
  }

  return {
    url: config.tokenUrl,
    cacheKey: buildOAuth2CacheKey(config),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal,
    },
  };
}

export function formatNtlmUsername(config: NtlmConfig): string {
  return config.domain ? `${config.domain}\\${config.username}` : config.username;
}

export function buildNtlmAllowListPattern(hostname: string): string {
  return `*${hostname}`;
}
