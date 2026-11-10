import { test, expect } from '@playwright/test';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import type { Request } from '../../src/shared/types';

const store = { getActiveEnvironmentId: () => undefined } as never;
const oauth = {
  type: 'oauth2' as const,
  oauth2: { grantType: 'client_credentials' as const, tokenUrl: 'http://token.example.test/token', clientId: 'id', clientSecret: 'secret', scope: '' },
};
const request = (patch: Partial<Request> = {}): Request => ({
  id: 'oauth-request', name: 'OAuth', method: 'GET', url: 'http://api.example.test/items', headers: [], parameters: [], body: { type: 'none' },
  auth: oauth, scripts: {}, settings: { timeout: 30_000, followRedirect: true }, createdAt: 0, updatedAt: 0, ...patch,
});

/** A token endpoint that never answers until told to, and aborts like a real fetch when its signal fires. */
function harness() {
  const seen = { tokenRequests: 0, tokenAborts: 0, tokenBodies: [] as string[], resourceHeaders: [] as Array<Record<string, string>> };
  let answerTokens = false;
  const engine = new RequestEngine({} as never, store, {
    responseTransport: 'fetch',
    captureConnectionTimings: async () => null,
    fetch: async (_session, url, init) => {
      if (String(url).endsWith('/token')) {
        seen.tokenRequests++;
        seen.tokenBodies.push(String(init.body));
        if (answerTokens) {
          return new Response(JSON.stringify({ access_token: `token-${seen.tokenRequests}`, token_type: 'Bearer', expires_in: 3600 }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => { seen.tokenAborts++; reject(init.signal!.reason); }, { once: true });
        });
      }
      seen.resourceHeaders.push(Object.fromEntries(new Headers(init.headers as HeadersInit)));
      return new Response('ok');
    },
  });
  return { engine, seen, answerTokens: () => { answerTokens = true; } };
}

for (const version of ['v2', 'legacy'] as const) {
  test(`${version}: cancelling a send aborts its client-credentials token request and caches nothing`, async () => {
    const { engine, seen, answerTokens } = harness();
    const send = () => version === 'v2' ? engine.executeV2({ request: request() }) : engine.execute({ request: request() });

    const pending = send().catch(error => error);
    await expect.poll(() => seen.tokenRequests).toBe(1);
    engine.cancel();

    // Without the fix the send waits for the token endpoint (30 s timeout); two seconds is far beyond a prompt abort.
    const outcome = await Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve('still waiting for the token endpoint'), 2000))]);
    expect(outcome).not.toBe('still waiting for the token endpoint');
    expect((outcome as { requestError?: unknown }).requestError).toMatchObject({ kind: 'cancelled' });
    expect(seen.tokenAborts).toBe(1);
    expect(seen.resourceHeaders).toEqual([]);

    // The cancelled send left nothing behind: the next one asks for its own token and succeeds.
    answerTokens();
    await send();
    expect(seen.tokenRequests).toBe(2);
    expect(seen.resourceHeaders).toHaveLength(1);
    expect(seen.resourceHeaders[0].authorization).toBe('Bearer token-2');
  });
}

const browser = (patch: Record<string, unknown> = {}) => ({
  type: 'oauth2' as const,
  oauth2: { grantType: 'authorization_code' as const, authorizationUrl: 'https://issuer.example.test/authorize', tokenUrl: 'https://issuer.example.test/token', clientId: 'id', clientSecret: 'secret', scope: '', ...patch },
});
const row = (key: string, value: string, enabled = true) => ({ key, value, enabled });

/** The code a send fails with, or 'sent'. Browser OAuth with no token fails with OAUTH_NOT_AUTHORIZED once its identity is accepted. */
async function outcome(auth: Request['auth'], url = 'http://api.example.test/items'): Promise<string> {
  const { engine } = harness();
  return engine.executeV2({ request: request({ auth, url }) }).then(() => 'sent', error => error?.requestError?.code ?? error?.code ?? String(error));
}

test.describe('browser OAuth identity', () => {
  test('a built-in in the path or query of the request URL does not change the identity', async () => {
    for (const url of ['http://api.example.test/items?nonce={{uuid}}', 'http://api.example.test/{{timestamp}}/items', 'http://api.example.test/items?n={{randomInt}}']) {
      expect(await outcome(browser(), url), url).toBe('OAUTH_NOT_AUTHORIZED');
    }
  });

  test('a built-in in the origin, an enabled authorization row or an enabled token row is rejected before any transport', async () => {
    expect(await outcome(browser(), 'http://api.{{uuid}}.example.test/items')).toBe('OAUTH_INVALID_CONFIG');
    expect(await outcome(browser({ authorizationParameters: [row('audience', '{{uuid}}')] }))).toBe('OAUTH_INVALID_CONFIG');
    expect(await outcome(browser({ tokenParameters: [row('resource', '{{timestamp}}')] }))).toBe('OAUTH_INVALID_CONFIG');
    expect(await outcome(browser({ clientId: '{{randomInt}}' }))).toBe('OAUTH_INVALID_CONFIG');
  });

  test('disabled rows are ignored', async () => {
    expect(await outcome(browser({ authorizationParameters: [row('audience', '{{uuid}}', false)], tokenParameters: [row('resource', '{{uuid}}', false)] }))).toBe('OAUTH_NOT_AUTHORIZED');
  });
});

test('client credentials keep their per-send built-ins in token parameters', async () => {
  const { engine, seen, answerTokens } = harness();
  answerTokens();
  const auth = { type: 'oauth2' as const, oauth2: { ...oauth.oauth2, tokenParameters: [row('nonce', '{{uuid}}')] } };
  await engine.executeV2({ request: request({ auth, url: 'http://api.example.test/items?nonce={{uuid}}' }) });
  expect(seen.tokenBodies).toHaveLength(1);
  expect(new URLSearchParams(seen.tokenBodies[0]).get('nonce')).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen.resourceHeaders).toHaveLength(1);
});
