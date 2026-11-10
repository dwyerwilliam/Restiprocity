import { test, expect } from '@playwright/test';
import { buildOAuthBindingKey } from '../../src/shared/oauth';
import { containsNondeterministicOAuthReference, oauthIdentityInputs, oauthIdentityValues, oauthOriginPart } from '../../src/shared/oauthIdentity';
import type { OAuth2Config } from '../../src/shared/types';

const browserConfig = (patch: Partial<OAuth2Config> = {}): OAuth2Config => ({
  grantType: 'authorization_code',
  authorizationUrl: 'https://issuer.example.test/authorize',
  tokenUrl: 'https://issuer.example.test/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scope: 'api.read',
  redirectUri: '',
  clientAuthentication: 'body',
  ...patch,
});
const row = (key: string, value: string, enabled = true) => ({ key, value, enabled });
const key = (config: OAuth2Config, origin = 'https://api.example.test') => buildOAuthBindingKey({ id: 'request-1', url: origin }, 'core', config, origin);
const flagged = (config: OAuth2Config, requestUrl = 'https://api.example.test/data') => oauthIdentityValues(config, requestUrl).some(value => containsNondeterministicOAuthReference(value));

test.describe('OAuth identity', () => {
  test('the origin part of an authored URL stops at the first path, query or fragment outside a reference', () => {
    const cases: Array<[string, string]> = [
      ['https://api.example.com/items?nonce={{uuid}}', 'https://api.example.com'],
      ['https://api.example.com:8443/a/{{uuid}}', 'https://api.example.com:8443'],
      ['https://api.example.com?x={{uuid}}', 'https://api.example.com'],
      ['https://api.example.com#{{uuid}}', 'https://api.example.com'],
      ['{{base_url}}/items?x={{uuid}}', '{{base_url}}'],
      ['{{base_url}}', '{{base_url}}'],
      ['https://{{host}}/items', 'https://{{host}}'],
      ['{{scheme}}://{{host}}/x', '{{scheme}}://{{host}}'],
      ['https://api.{{uuid}}.example.com/x', 'https://api.{{uuid}}.example.com'],
      ['http://localhost:3000/a', 'http://localhost:3000'],
      ['https://{{host/x', 'https://{{host/x'],
      ['', ''],
    ];
    for (const [url, origin] of cases) expect(oauthOriginPart(url), url).toBe(origin);
  });

  test('a built-in in the path or query of the request URL is not part of the identity', () => {
    for (const url of ['https://api.example.com/items?nonce={{uuid}}', 'https://api.example.com/{{timestamp}}/items', '{{base_url}}/items?n={{randomInt}}']) {
      expect(flagged(browserConfig(), url), url).toBe(false);
    }
  });

  test('a built-in in the origin of the request URL is part of the identity', () => {
    for (const url of ['https://api.{{uuid}}.example.com/items', 'https://{{timestamp}}.example.com', 'https://api.example.com:{{randomInt}}/items']) {
      expect(flagged(browserConfig(), url), url).toBe(true);
    }
  });

  test('every configuration field that the binding key hashes is checked', () => {
    const fields: Array<Partial<OAuth2Config>> = [
      { authorizationUrl: 'https://issuer.example.test/{{uuid}}' }, { tokenUrl: 'https://issuer.example.test/{{uuid}}' },
      { clientId: '{{uuid}}' }, { clientSecret: '{{uuid}}' }, { scope: '{{uuid}}' }, { redirectUri: 'http://127.0.0.1/{{uuid}}' },
      { expectedIssuer: '{{uuid}}' },
      { authorizationParameters: [row('{{uuid}}', 'v')] }, { authorizationParameters: [row('audience', '{{uuid}}')] },
      { tokenParameters: [row('{{uuid}}', 'v')] }, { tokenParameters: [row('audience', '{{timestamp}}')] },
    ];
    for (const patch of fields) expect(flagged(browserConfig(patch)), JSON.stringify(patch)).toBe(true);
    expect(flagged(browserConfig())).toBe(false);
  });

  test('disabled parameter rows are neither bound nor checked', () => {
    const disabled = browserConfig({ authorizationParameters: [row('audience', '{{uuid}}', false)], tokenParameters: [row('resource', '{{uuid}}', false)] });
    expect(flagged(disabled)).toBe(false);
    expect(key(disabled)).toBe(key(browserConfig()));
    expect(key(browserConfig({ tokenParameters: [row('resource', 'a')] }))).not.toBe(key(browserConfig()));
    expect(key(browserConfig({ authorizationParameters: [row('audience', 'a')] }))).not.toBe(key(browserConfig()));
  });

  test('the binding key hashes exactly the identity inputs', () => {
    const base = browserConfig({ authorizationParameters: [row('audience', 'a')], tokenParameters: [row('resource', 'r')], expectedIssuer: 'https://issuer.example.test' });
    const inputs = oauthIdentityInputs(base);
    expect(inputs).toEqual({
      authorizationUrl: base.authorizationUrl, tokenUrl: base.tokenUrl, clientId: 'client-id', clientSecret: 'client-secret', scope: 'api.read', redirectUri: '',
      expectedIssuer: 'https://issuer.example.test',
      authorizationParameters: [{ key: 'audience', value: 'a' }], tokenParameters: [{ key: 'resource', value: 'r' }],
    });
    for (const patch of [
      { authorizationUrl: 'https://other.example.test/authorize' }, { tokenUrl: 'https://other.example.test/token' }, { clientId: 'other' }, { clientSecret: 'other' },
      { scope: 'other' }, { redirectUri: 'http://127.0.0.1:1/cb' }, { expectedIssuer: 'https://other.example.test' },
      { authorizationParameters: [row('audience', 'b')] }, { tokenParameters: [row('resource', 's')] },
    ] as Array<Partial<OAuth2Config>>) {
      expect(key({ ...base, ...patch }), JSON.stringify(patch)).not.toBe(key(base));
    }
    expect(key(base, 'https://other.example.test')).not.toBe(key(base));
  });
});
