import { test, expect } from '@playwright/test';
import { OAuthService, type CallbackServer, type OAuthBindingInput } from '../../src/main/oauth/oauthService';
import { buildAuthorizationUrl, createPkcePair } from '../../src/shared/oauth';

function input(overrides: Partial<OAuthBindingInput> = {}): OAuthBindingInput {
  return {
    requestId: 'request-1',
    requestUrl: 'https://api.example.test/data',
    environmentId: 'core',
    config: {
      grantType: 'authorization_code',
      authorizationUrl: 'https://provider.example.test/authorize',
      tokenUrl: 'https://provider.example.test/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'api.read',
      redirectUri: '',
      clientAuthentication: 'body',
    },
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; },
    end(body?: string) { this.body = body ?? ''; },
  };
}

test.describe('OAuthService', () => {
  test('builds an S256 authorization URL and exchanges a claimed callback once', async () => {
    let callbackHandler: ((request: any, response: any, result: any) => Promise<void>) | undefined;
    let opened = '';
    let exchanges = 0;
    const callbackServer: CallbackServer = {
      listen: async (_host, _port, _path, handler) => { callbackHandler = handler; },
      close: async () => {},
    };
    const service = new OAuthService({
      createCallbackServer: () => callbackServer,
      openExternal: async url => { opened = url; },
      random: () => new Uint8Array(32).fill(7),
      fetch: async (_url, init) => {
        exchanges++;
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(init.credentials).toBe('omit');
        expect(String(init.body)).toContain('grant_type=authorization_code');
        expect(String(init.body)).toContain('code_verifier=');
        return new Response(JSON.stringify({ access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const binding = input();
    const waiting = await service.start(binding);
    expect(waiting.kind).toBe('waiting-for-sign-in');
    expect(callbackHandler).toBeDefined();
    const authorization = new URL(opened);
    expect(authorization.searchParams.get('response_type')).toBe('code');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('code_challenge')).toBe(createPkcePair(() => new Uint8Array(32).fill(7)).challenge);
    const callback = new URL(waiting.callbackUri!);
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'code-1');
    const result = { code: 'code-1' };
    await callbackHandler!({ headers: { host: callback.host }, socket: { remoteAddress: '127.0.0.1' }, url: callback.pathname + callback.search }, responseRecorder(), result);
    expect(service.status(binding).kind).toBe('ready');
    expect(await service.getAccessToken(binding)).toBe('access-1');
    expect(exchanges).toBe(1);
    const replay = responseRecorder();
    await callbackHandler!({ headers: { host: callback.host }, socket: { remoteAddress: '127.0.0.1' }, url: callback.pathname + callback.search }, replay, result);
    expect(replay.statusCode).toBe(400);
    expect(exchanges).toBe(1);
    service.dispose();
  });

  test('refreshes rotated tokens and clears the binding on invalid_grant', async () => {
    const responses = [
      { status: 200, value: { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 1 } },
      { status: 200, value: { access_token: 'access-2', token_type: 'Bearer', refresh_token: 'refresh-2', expires_in: 3600 } },
      { status: 400, value: { error: 'invalid_grant' } },
    ];
    const service = new OAuthService({
      fetch: async () => {
        const response = responses.shift()!;
        return new Response(JSON.stringify(response.value), { status: response.status, headers: { 'content-type': 'application/json' } });
      },
    });
    const binding = input({ config: { ...input().config, grantType: 'client_credentials' } });
    expect(await service.getAccessToken(binding)).toBe('access-1');
    expect(await service.refresh(binding)).toBe('access-2');
    expect(service.status(binding).hasRefreshToken).toBe(true);
    await expect(service.refresh(binding)).rejects.toThrow('OAuth authorization expired or was revoked.');
    expect(service.status(binding).kind).toBe('failed');
    service.dispose();
  });

  test('rejects password grants and reserved authorization parameters before network I/O', async () => {
    let calls = 0;
    const service = new OAuthService({ fetch: async () => { calls++; return new Response('{}'); } });
    const password = input({ config: { ...input().config, grantType: 'password' } });
    await expect(service.getAccessToken(password)).rejects.toMatchObject({ code: 'OAUTH_UNSUPPORTED_GRANT' });
    expect(calls).toBe(0);
    expect(() => buildAuthorizationUrl(input().config, 'state', 'challenge', 'http://127.0.0.1:42813/callback')).not.toThrow();
    expect(() => buildAuthorizationUrl({ ...input().config, authorizationUrl: 'https://provider.example.test/authorize?STATE=attacker' }, 'state', 'challenge', 'http://127.0.0.1:42813/callback')).toThrow();
    service.dispose();
  });
  test('form-encodes Basic client credentials and normalizes omitted parameter arrays', async () => {
    let requestInit: RequestInit | undefined;
    const service = new OAuthService({
      fetch: async (_url, init) => { requestInit = init; return new Response(JSON.stringify({ access_token: 'access', token_type: 'Bearer' })); },
    });
    const base = input({ config: { ...input().config, grantType: 'client_credentials', clientAuthentication: 'basic', clientId: 'my client', clientSecret: 'p@ss:w+rd', authorizationParameters: undefined, tokenParameters: undefined } });
    const equivalent = input({ config: { ...base.config, authorizationParameters: [], tokenParameters: [] } });
    expect(service.getBindingId(base)).toBe(service.getBindingId(equivalent));
    await expect(service.getAccessToken(base)).resolves.toBe('access');
    const decoded = Buffer.from(String(new Headers(requestInit?.headers).get('authorization')).replace(/^Basic /, ''), 'base64').toString();
    expect(decoded).toBe('my+client:p%40ss%3Aw%2Brd');
    expect(new URLSearchParams(String(requestInit?.body)).has('client_id')).toBe(false);
    service.dispose();
  });

  test('cancelling an interactive flow closes its callback server and permits a new binding', async () => {
    let handler: ((request: any, response: any, result: any) => Promise<void>) | undefined;
    let closes = 0;
    const callbackServer: CallbackServer = { listen: async (_host, _port, _path, next) => { handler = next; }, close: async () => { closes++; } };
    const service = new OAuthService({ createCallbackServer: () => callbackServer, openExternal: async () => {}, random: () => new Uint8Array(32).fill(3), fetch: async () => new Response('{}') });
    const first = input();
    const waiting = await service.start(first);
    expect(waiting.kind).toBe('waiting-for-sign-in');
    expect(waiting.operationId).toBeTruthy();
    const changed = input({ config: { ...first.config, scope: 'changed' }, operationId: waiting.operationId });
    const cancelled = await service.cancel(changed);
    expect(cancelled.kind).toBe('cancelled');
    expect(closes).toBe(1);
    const next = await service.start(first);
    expect(next.kind).toBe('waiting-for-sign-in');
    await service.cancel(first);
    expect(closes).toBe(2);
    service.dispose();
  });

});