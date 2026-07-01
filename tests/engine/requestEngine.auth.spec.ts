import { expect, test } from '@playwright/test';
import { buildOAuth2CacheKey, buildOAuth2TokenExchangeRequest, buildNtlmAllowListPattern, formatNtlmUsername } from '../../src/main/engine/authTransport';

test.describe('Request engine auth helpers', () => {
  test('builds OAuth2 client-credentials token request payload', () => {
    const config = {
      grantType: 'client_credentials' as const,
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'api.read api.write',
      redirectUri: 'http://localhost/callback',
    };

    const tokenRequest = buildOAuth2TokenExchangeRequest(config);
    const body = new URLSearchParams(String(tokenRequest.init.body));

    expect(tokenRequest.url).toBe('https://auth.example.com/token');
    expect(tokenRequest.init.method).toBe('POST');
    expect(tokenRequest.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('client-id');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(body.get('scope')).toBe('api.read api.write');
  });

  test('changes OAuth2 cache key when credentials change', () => {
    const base = {
      grantType: 'client_credentials' as const,
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'api.read',
      redirectUri: 'http://localhost/callback',
    };

    const next = { ...base, clientSecret: 'changed-secret' };

    expect(buildOAuth2CacheKey(base)).not.toBe(buildOAuth2CacheKey(next));
  });

  test('formats NTLM credentials and domain allow-list', () => {
    expect(formatNtlmUsername({ username: 'svc-account', password: 'secret' })).toBe('svc-account');
    expect(formatNtlmUsername({ username: 'svc-account', password: 'secret', domain: 'CORP' })).toBe('CORP\\svc-account');
    expect(buildNtlmAllowListPattern('api.example.com')).toBe('*api.example.com');
  });
});
