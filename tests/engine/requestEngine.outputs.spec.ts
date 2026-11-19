import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import type { RequestProgressEvent } from '../../src/main/engine/requestRuntimeAdapters';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { defaultRequestOutputs } from '../../src/shared/requestOutputs';
import { CORE_ENVIRONMENT_ID, type Request, type RequestOutputs } from '../../src/shared/types';
import { FakeClientRequest, FakeIncomingMessage } from './fixtures/httpResponseFixture';

type TokenReply = { status?: number; body?: unknown; headers?: Record<string, string>; hang?: boolean; raw?: string };

interface Harness {
  engine: RequestEngine;
  store: CollectionStore;
  login: Request;
  seen: { token: number; tokenAborts: number; saveDialogs: number; tokenBodies: string[]; child: Array<{ url: string; headers: Record<string, string>; redirect?: string }> };
  clock: { wall: number; mono: number; advance(ms: number): void };
  reply: { next: (n: number) => TokenReply; child: (url: string) => { status: number; body: string } };
  child(patch?: Partial<Request>): Request;
  send(request: Request, environmentId?: string, onProgress?: (event: RequestProgressEvent) => void): Promise<unknown>;
  cleanup(): Promise<void>;
}

function tokenResponse(reply: TokenReply, n: number): Response {
  if (reply.raw !== undefined) return new Response(reply.raw === '' ? null : reply.raw, { status: reply.status ?? 200, headers: reply.headers ?? { 'content-type': 'text/plain' } });
  return new Response(JSON.stringify(reply.body ?? { access_token: `tok-${n}`, expires_in: 3600 }), {
    status: reply.status ?? 200,
    headers: reply.headers ?? { 'content-type': 'application/json' },
  });
}

async function harness(outputs: RequestOutputs = defaultRequestOutputs(), transport: 'fetch' | 'net' = 'fetch'): Promise<Harness> {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-outputs-'));
  const store = new CollectionStore(userData);
  await store.init();
  await store.updateEnvironment(CORE_ENVIRONMENT_ID, { variables: [
    { key: 'auth', value: 'https://auth.example.test', type: 'standard' },
    { key: 'client_secret', value: 'cs-1', type: 'confidential' },
    { key: 'loop', value: '{{loop}}x', type: 'standard' },
  ] });
  const seen: Harness['seen'] = { token: 0, tokenAborts: 0, saveDialogs: 0, tokenBodies: [], child: [] };
  const clock = { wall: 1_700_000_000_000, mono: 0, advance(ms: number) { this.wall += ms; this.mono += ms; } };
  const reply: Harness['reply'] = { next: () => ({}), child: () => ({ status: 200, body: 'ok' }) };

  const fetch = async (_session: unknown, url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.pathname === '/token') {
      const n = ++seen.token;
      seen.tokenBodies.push(init.body === undefined ? '' : Buffer.from(init.body as never).toString('utf8'));
      const next = reply.next(n);
      if (next.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => { seen.tokenAborts++; reject(init.signal!.reason); }, { once: true });
        });
      }
      return tokenResponse(next, n);
    }
    seen.child.push({ url, headers: Object.fromEntries(new Headers(init.headers as HeadersInit)), redirect: init.redirect });
    const answer = reply.child(url);
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'text/plain' } });
  };

  const netRequest = (options: { url: string }) => {
    const clientRequest: FakeClientRequest = new FakeClientRequest(current => {
      setImmediate(async () => {
        const response = await fetch(undefined, options.url, { headers: Object.fromEntries(current.headers) });
        const message = new FakeIncomingMessage({ status: response.status, headers: Object.fromEntries(response.headers) });
        current.emit('response', message);
        const text = await response.text();
        setImmediate(() => { message.emit('data', Buffer.from(text)); message.emit('end'); current.emit('close'); });
      });
    });
    return clientRequest;
  };

  const engine = new RequestEngine({} as never, store, {
    responseTransport: transport,
    captureConnectionTimings: async () => null,
    showSaveDialog: async () => { seen.saveDialogs++; return { canceled: true, filePath: '' }; },
    clock: { wallNow: () => clock.wall, monotonicNow: () => clock.mono },
    fetch: fetch as never,
    netRequest: netRequest as never,
  });
  const login = await store.createRequest({
    name: 'Get session token', method: 'POST', url: '{{auth}}/token', headers: [], parameters: [],
    body: { type: 'raw', raw: { language: 'json', content: '{"secret":"{{client_secret}}"}' } }, auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 0 }, scripts: {}, outputs,
  });
  const child = (patch: Partial<Request> = {}): Request => ({
    id: 'child', name: 'List orders', method: 'GET', url: 'https://api.example.test/orders', headers: [], parameters: [],
    body: { type: 'none' }, auth: { type: 'bearer', bearer: { token: '{{api_token}}', prefix: '' } },
    settings: { followRedirect: true, timeout: 0 }, scripts: {}, createdAt: 0, updatedAt: 0, ...patch,
  });
  const send = (request: Request, environmentId?: string, onProgress?: (event: RequestProgressEvent) => void) =>
    engine.executeV2({ request, environmentId }, undefined, onProgress);
  return { engine, store, login, seen, clock, reply, child, send, cleanup: () => fs.rm(userData, { recursive: true, force: true }) };
}

async function failure(promise: Promise<unknown>): Promise<{ kind: string; code: string | null; message: string; rawMessage: string }> {
  const error = await promise.then(() => { throw new Error('expected the send to fail'); }, (caught: unknown) => caught);
  return (error as { requestError: { kind: string; code: string | null; message: string; rawMessage: string } }).requestError;
}

for (const transport of ['fetch', 'net'] as const) {
  test(`${transport}: a cold send fetches the token once, later sends reuse it, and it is fetched again at the interval`, async () => {
    const h = await harness(defaultRequestOutputs(), transport);
    try {
      const progress: RequestProgressEvent[] = [];
      await h.send(h.child(), undefined, event => progress.push(event));
      expect(h.seen.token).toBe(1);
      expect(h.seen.child).toHaveLength(1);
      expect(h.seen.child[0].headers.authorization).toBe('Bearer tok-1');
      expect(progress.slice(0, 2)).toEqual([
        { requestId: 'child', phase: 'acquiring-token', receivedBytes: 0, tokenSource: 'Get session token' },
        { requestId: 'child', phase: 'waiting-headers', receivedBytes: 0 },
      ]);

      // The response says expires_in 3600, so it is fresh for 3600 s less 10% (at most 30 s).
      const quiet: RequestProgressEvent[] = [];
      h.clock.advance(3_569_999);
      await h.send(h.child({ id: 'create', url: 'https://api.example.test/orders/new' }), undefined, event => quiet.push(event));
      expect(h.seen.token).toBe(1);
      expect(h.seen.child[1].headers.authorization).toBe('Bearer tok-1');
      expect(quiet.some(event => event.phase === 'acquiring-token')).toBe(false);

      h.clock.advance(1);
      await h.send(h.child());
      expect(h.seen.token).toBe(2);
      expect(h.seen.child[2].headers.authorization).toBe('Bearer tok-2');
    } finally {
      await h.cleanup();
    }
  });
}

test('a shorter expires_in refreshes sooner', async () => {
  const h = await harness();
  try {
    h.reply.next = n => ({ body: { access_token: `tok-${n}`, expires_in: 100 } });
    await h.send(h.child());
    h.clock.advance(89_999);
    await h.send(h.child());
    expect(h.seen.token).toBe(1);
    h.clock.advance(1);
    await h.send(h.child());
    expect(h.seen.token).toBe(2);
  } finally {
    await h.cleanup();
  }
});

test('only fields a send uses fetch a token, and an overridden auth header with a cycle is ignored', async () => {
  const h = await harness();
  try {
    await h.send(h.child({ auth: { type: 'none' }, headers: [{ key: 'X-Token', value: '{{api_token}}', enabled: false }] }));
    expect(h.seen.token).toBe(0);
    await h.send(h.child({ headers: [{ key: 'Authorization', value: '{{loop}}', enabled: true }] }));
    expect(h.seen.token).toBe(1);
    expect(h.seen.child[1].headers.authorization).toBe('Bearer tok-1');
    // An output works in any field, not only Bearer.
    await h.send(h.child({ auth: { type: 'none' }, headers: [{ key: 'X-Api-Token', value: '{{api_token}}', enabled: true }] }));
    expect(h.seen.child[2].headers['x-api-token']).toBe('tok-1');
  } finally {
    await h.cleanup();
  }
});

test('the token request is the saved one, resolved with the environment', async () => {
  const h = await harness();
  try {
    await h.send(h.child());
    expect(h.seen.tokenBodies).toEqual(['{"secret":"cs-1"}']);
    // An unsaved edit in the window doesn't change what runs for outputs: only the saved request does.
    await h.store.updateRequest(h.login.id, { body: { type: 'raw', raw: { language: 'json', content: '{"secret":"{{client_secret}}","v":2}' } } });
    await h.send(h.child());
    expect(h.seen.tokenBodies[1]).toBe('{"secret":"cs-1","v":2}');
  } finally {
    await h.cleanup();
  }
});

test('a failing token request stops the send before any child traffic, and the next send recovers', async () => {
  const h = await harness();
  try {
    h.reply.next = () => ({ status: 500, body: { error: 'down', access_token: 'leaked' } });
    const error = await failure(h.send(h.child()));
    expect(error).toMatchObject({ kind: 'authentication', code: 'TOKEN_SOURCE_HTTP' });
    expect(error.message).toBe('Couldn\'t get {{api_token}}: "Get session token" returned HTTP 500.');
    expect(h.seen.child).toEqual([]);
    expect(await h.engine.getOutputStatus(h.login.id)).toMatchObject({ state: 'failed', error: { code: 'TOKEN_SOURCE_HTTP' } });

    h.reply.next = n => ({ body: { access_token: `tok-${n}` } });
    await h.send(h.child());
    expect(h.seen.child[0].headers.authorization).toBe('Bearer tok-2');
  } finally {
    await h.cleanup();
  }
});

test('a missing field, a non-text value and a download each fail with their own code', async () => {
  const h = await harness();
  try {
    h.reply.next = () => ({ body: { token: 'elsewhere' } });
    expect(await failure(h.send(h.child()))).toMatchObject({ code: 'TOKEN_EXTRACT_FAILED', message: expect.stringContaining('JSON field "/access_token" is missing') });
    h.reply.next = () => ({ body: { access_token: 42 } });
    expect(await failure(h.send(h.child()))).toMatchObject({ code: 'TOKEN_EXTRACT_FAILED', message: expect.stringContaining('is a number, not text') });
    h.reply.next = () => ({ raw: 'bin', headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="t.bin"' } });
    expect(await failure(h.send(h.child()))).toMatchObject({ code: 'TOKEN_SOURCE_NOT_TEXT' });
    expect(h.seen.saveDialogs).toBe(0);
    expect(h.seen.child).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test('outputs turned off, a token request that uses outputs, and a deleted token request', async () => {
  const h = await harness();
  try {
    await h.store.updateRequest(h.login.id, { outputs: { ...defaultRequestOutputs(), enabled: false } });
    expect(await failure(h.send(h.child()))).toMatchObject({ code: 'TOKEN_SOURCE_MISSING', message: expect.stringContaining('turned off') });

    await h.store.updateRequest(h.login.id, { outputs: defaultRequestOutputs(), url: '{{auth}}/token?previous={{api_token}}' });
    expect(await failure(h.send(h.child()))).toMatchObject({ code: 'TOKEN_SOURCE_CHAINED' });
    // Sending the token request itself is refused the same way.
    const saved = await h.store.getRequest(h.login.id);
    expect(await failure(h.send(saved!))).toMatchObject({ code: 'TOKEN_SOURCE_CHAINED' });
    expect(h.seen.token).toBe(0);

    // A deleted token request leaves {{api_token}} an unknown variable, sent as written like any other.
    await h.store.delete(h.login.id);
    await h.send(h.child());
    expect(h.seen.child.at(-1)?.headers.authorization).toBe('Bearer {{api_token}}');
  } finally {
    await h.cleanup();
  }
});

test('cancelling during the token request cancels the send, with no child traffic and no token URL', async () => {
  const h = await harness();
  try {
    h.reply.next = () => ({ hang: true });
    const pending = failure(h.send(h.child()));
    await expect.poll(() => h.seen.token).toBe(1);
    h.engine.cancel();
    const error = await pending;
    expect(error.kind).toBe('cancelled');
    expect(JSON.stringify(error)).not.toContain('auth.example.test');
    expect(h.seen.tokenAborts).toBe(1);
    expect(h.seen.child).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test('a request that uses an output does not let fetch follow redirects', async () => {
  const h = await harness();
  try {
    await h.send(h.child());
    await h.send(h.child({ auth: { type: 'none' } }));
    expect(h.seen.child[0].redirect).toBe('manual');
    expect(h.seen.child[1].redirect).toBe('follow');
  } finally {
    await h.cleanup();
  }
});

test('environments get separate tokens, and editing a value the token request uses fetches again', async () => {
  const h = await harness();
  try {
    const production = await h.store.createEnvironment({ name: 'Production', parentId: CORE_ENVIRONMENT_ID, variables: [] });
    await h.send(h.child());
    await h.send(h.child(), production.id);
    expect(h.seen.token).toBe(2);
    await h.send(h.child());
    expect(h.seen.token).toBe(2);

    await h.store.updateEnvironment(CORE_ENVIRONMENT_ID, { variables: [
      { key: 'auth', value: 'https://auth.example.test', type: 'standard' },
      { key: 'client_secret', value: '••••••••', type: 'confidential' },
      { key: 'unrelated', value: 'x', type: 'standard' },
      { key: 'loop', value: '{{loop}}x', type: 'standard' },
    ] });
    await h.send(h.child());
    expect(h.seen.token).toBe(2);

    await h.store.updateEnvironment(CORE_ENVIRONMENT_ID, { variables: [
      { key: 'auth', value: 'https://auth.example.test', type: 'standard' },
      { key: 'client_secret', value: 'cs-2', type: 'confidential' },
    ] });
    await h.send(h.child());
    expect(h.seen.token).toBe(3);
  } finally {
    await h.cleanup();
  }
});

test('Copy as cURL uses a fresh token after confirmation and never runs the token request', async () => {
  const h = await harness();
  try {
    await expect(h.engine.exportCurl({ request: h.child() })).rejects.toThrow(
      '{{api_token}} hasn\'t been fetched for this environment yet. Send "Get session token" or a request that uses it, then copy again.');
    expect(h.seen.token).toBe(0);
    await h.send(h.child());
    const curl = await h.engine.exportCurl({ request: h.child() });
    expect(curl.sensitive).toBe(true);
    expect(JSON.stringify(curl)).toContain('Bearer tok-1');
    expect(h.seen.token).toBe(1);
    h.clock.advance(3_600_000);
    await expect(h.engine.exportCurl({ request: h.child() })).rejects.toThrow(/hasn't been fetched/);
    expect(h.seen.token).toBe(1);
  } finally {
    await h.cleanup();
  }
});

test('status reports metadata only', async () => {
  const h = await harness();
  try {
    expect(await h.engine.getOutputStatus(h.login.id)).toEqual({ requestId: h.login.id, environmentId: CORE_ENVIRONMENT_ID, state: 'empty', names: ['api_token'] });
    await h.send(h.child());
    const status = await h.engine.getOutputStatus(h.login.id);
    expect(status).toEqual({
      requestId: h.login.id, environmentId: CORE_ENVIRONMENT_ID, state: 'fresh', names: ['api_token'],
      fetchedAt: h.clock.wall, refreshAt: h.clock.wall + 3_570_000,
    });
    expect(JSON.stringify(status)).not.toContain('tok-1');
    expect(await h.engine.getOutputStatus('not-a-request')).toMatchObject({ state: 'empty', names: [] });
  } finally {
    await h.cleanup();
  }
});

test('the legacy path refuses a request that uses outputs instead of sending the placeholder', async () => {
  const h = await harness();
  try {
    expect(await failure(h.engine.execute({ request: h.child() }))).toMatchObject({ code: 'TOKEN_SOURCE_FAILED' });
    expect(h.seen.child).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test('header and whole-body outputs', async () => {
  const h = await harness({ ...defaultRequestOutputs(), values: [
    { name: 'api_token', source: { kind: 'header', name: 'x-session-token' } },
  ] });
  try {
    h.reply.next = n => ({ raw: '', status: 204, headers: { 'x-session-token': `hdr-${n}` } });
    await h.send(h.child());
    expect(h.seen.child[0].headers.authorization).toBe('Bearer hdr-1');
    await h.store.updateRequest(h.login.id, { outputs: { ...defaultRequestOutputs(), values: [{ name: 'api_token', source: { kind: 'body' } }] } });
    h.reply.next = n => ({ raw: `  body-${n}\n` });
    await h.send(h.child());
    expect(h.seen.child[1].headers.authorization).toBe('Bearer body-2');
  } finally {
    await h.cleanup();
  }
});
