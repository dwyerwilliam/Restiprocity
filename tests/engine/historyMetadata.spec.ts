import { test, expect } from '@playwright/test';
import type { Request } from '../../src/shared/types';
import { buildHistoryRequestMetadata } from '../../src/main/stores/historyMetadata';

function request(url: string): Request {
  return {
    id: 'history-test', name: 'Authored request', method: 'POST', url,
    headers: [{ key: 'secret', value: 'HEADER_MARKER', enabled: true }],
    parameters: [{ key: 'added', value: 'PARAM_MARKER', enabled: true }],
    body: { type: 'none' }, auth: { type: 'none' }, scripts: {},
    settings: { followRedirect: true, timeout: 1000, cookiesEnabled: true },
    createdAt: 1, updatedAt: 1,
  };
}

test.describe('safe configured URL', () => {
  test('retains authored templates and pair ordering without other request data', () => {
    const input = request('https://{{host}}/path?x={{ value }}&z=two+words&x=%2f&flag#discard');
    const result = buildHistoryRequestMetadata(input);
    expect(result).toEqual({ requestName: 'Authored request', method: 'POST',
      url: 'https://{{host}}/path?x={{ value }}&z=two+words&x=%2f&flag' });
  });

  test('captures immutable send-time values before stale input mutation', () => {
    const input = request('https://example.test/original');
    const result = buildHistoryRequestMetadata(input);
    input.name = 'Changed'; input.method = 'DELETE'; input.url = 'https://elsewhere.test';
    expect(result).toEqual({ requestName: 'Authored request', method: 'POST', url: 'https://example.test/original' });
    expect(Object.keys(result).sort()).toEqual(['method', 'requestName', 'url']);
  });

  test('preserves token-only sensitive values but redacts mixed literals', () => {
    const result = buildHistoryRequestMetadata(request('https://{{ host }}/?token={{ value }}{{other}}&password=%7B%7B%20pass%20%7D%7D&key=prefix{{key}}'));
    expect(result.url).toBe('https://{{ host }}/?token={{ value }}{{other}}&password=%7B%7B%20pass%20%7D%7D&key=[REDACTED]');
  });
});

test.describe('credential and malformed URL redaction', () => {
  test('removes userinfo fragment and all encoded case-varied duplicate sensitive keys', () => {
    const keys = ['access_token', 'refresh_token', 'token', 'api_key', 'apikey', 'key', 'password', 'passwd', 'client_secret'];
    const query = keys.flatMap((key) => [`${key}=MARKER`, `${key.toUpperCase().replace(/./, (letter) => '%' + letter.charCodeAt(0).toString(16))}=MARKER`]).join('&');
    const result = buildHistoryRequestMetadata(request(`https://user:MARKER@example.test/p?${query}#MARKER`));
    expect(JSON.stringify(result)).not.toContain('MARKER');
    expect(result.url).toBe('https://example.test/p?' + query.replace(/MARKER/g, '[REDACTED]'));
  });

  test('redacts nonstandard configured query name and each literal configured secret', () => {
    const input = request('https://example.test/?CUSTOM=MARKER&ordinary=BEARER&b=BASIC&c=OAUTH&d=NTLM&e=API&blank=&safe=visible');
    input.auth = {
      type: 'api_key', api_key: { in: 'query', key: 'custom', value: 'API' },
      bearer: { token: 'BEARER', prefix: 'Bearer' }, basic: { username: 'user', password: 'BASIC' },
      ntlm: { password: 'NTLM' }, oauth2: { grantType: 'client_credentials', authorizationUrl: '', tokenUrl: '', clientId: '', clientSecret: 'OAUTH', scope: '', redirectUri: '' },
    };
    const result = buildHistoryRequestMetadata(input);
    expect(result.url).toBe('https://example.test/?CUSTOM=[REDACTED]&ordinary=[REDACTED]&b=[REDACTED]&c=[REDACTED]&d=[REDACTED]&e=[REDACTED]&blank=&safe=visible');
    expect(JSON.stringify(result)).not.toMatch(/MARKER|BEARER|BASIC|OAUTH|NTLM|API/);
  });

  for (const url of ['', 'not a URL', '//example.test/p', 'https:///path', 'https://:443/p',
    'https://[broken/p', 'https://host:bad/p', 'https://one@two@host/p', 'https://host\\@evil/p',
    'https://host/%GG', 'https://host/?%FF=MARKER', 'https://host/?key=%FF', 'file:///secret', 'https://{{ broken/p']) {
    test(`fails closed for ${JSON.stringify(url)}`, () => {
      const result = buildHistoryRequestMetadata(request(url));
      expect(result).toEqual({ requestName: 'Authored request', method: 'POST', url: '' });
    });
  }

  test('redacts encoded repeated literal secrets without misleading blank metadata', () => {
    const input = request('https://user:MARKER@{{ host }}/?token=MARKER&%74OKEn=%4dARKER&x={{ value }}');
    const result = buildHistoryRequestMetadata(input);
    expect(result.url).toBe('https://{{ host }}/?token=[REDACTED]&%74OKEn=[REDACTED]&x={{ value }}');
    expect(JSON.stringify(result)).not.toContain('MARKER');
  });
});
