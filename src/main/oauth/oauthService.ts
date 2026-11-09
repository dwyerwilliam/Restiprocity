import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { shell, session, type BrowserWindow, type Session } from 'electron';
import type { OAuth2Config, OAuthTokenStatus } from '@shared/types';
import { buildAuthorizationUrl, buildOAuthBindingKey, callbackUri, createPkcePair, enabledOAuthParameters, isBrowserOAuth, isSafeToken, oauthClientAuthentication, normalizeOAuthGrant, parseExpiresIn, parseHttpsOrLoopback, OAUTH_CALLBACK_HOST, OAUTH_CALLBACK_PORT, OAUTH_MAX_CALLBACK_URL, OAUTH_MAX_TOKEN_RESPONSE } from '@shared/oauth';
import { containsNondeterministicOAuthReference, oauthIdentityValues } from '@shared/oauthIdentity';

export interface OAuthBindingInput {
  requestId: string;
  requestUrl: string;
  environmentId?: string;
  config: OAuth2Config;
  operationId?: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  grantedScope?: string;
}

interface Entry {
  token?: OAuthToken;
  revision: number;
  lastUsed: number;
  generation: number;
  pending?: Promise<string>;
  pendingAbort?: AbortController;
  operationId?: string;
  callbackClaimed?: boolean;
  callbackServer?: CallbackServer;
  callbackTimeout?: ReturnType<typeof setTimeout>;
  status: OAuthTokenStatus;
}

interface CallbackResult {
  code?: string;
  error?: string;
  issuer?: string;
}

export interface OAuthServiceDependencies {
  fetch?: (url: string, init: RequestInit, signal: AbortSignal) => Promise<Response>;
  openExternal?: (url: string) => Promise<void>;
  createCallbackServer?: () => CallbackServer;
  now?: () => number;
  monotonicNow?: () => number;
  random?: () => Uint8Array;
  session?: Session;
}

export interface CallbackServer {
  listen(host: string, port: number, path: string, handler: (request: IncomingMessage, response: ServerResponse, result: CallbackResult | null) => void): Promise<void>;
  close(): Promise<void>;
}

function defaultCallbackServer(): CallbackServer {
  let server: Server | undefined;
  const sockets = new Set<{ destroy(): void; once(event: 'close', listener: () => void): void }>();
  return {
    listen(host, port, path, handler) {
      server = createServer((request, response) => {
        const rawUrl = request.url ?? '';
        if (rawUrl.length > OAUTH_MAX_CALLBACK_URL || request.method !== 'GET') {
          response.writeHead(400, fixedHeaders()); response.end(failurePage()); return;
        }
        let parsed: URL;
        try { parsed = new URL(rawUrl, `http://${request.headers.host ?? host}`); } catch { response.writeHead(400, fixedHeaders()); response.end(failurePage()); return; }
        if (parsed.pathname !== path) { response.writeHead(404, fixedHeaders()); response.end(failurePage()); return; }
        const values = (key: string) => parsed.searchParams.getAll(key);
        const state = values('state'); const code = values('code'); const error = values('error'); const issuer = values('iss'); const responseMode = values('response_mode');
        const result = state.length === 1 && !!state[0] && responseMode.length === 0 && ((code.length === 1 && !!code[0] && error.length === 0) || (code.length === 0 && error.length === 1 && !!error[0])) && issuer.length <= 1
          ? { code: code[0], error: error[0], issuer: issuer[0] }
          : null;
        handler(request, response, result);
      });
      return new Promise((resolve, reject) => { server!.once('error', reject); server!.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }); server!.listen(port, host, () => { server!.removeListener('error', reject); resolve(); }); });
    },
    close() { return new Promise(resolve => { if (!server) return resolve(); for (const socket of sockets) socket.destroy(); server.close(() => resolve()); server = undefined; }); },
  };
}

function fixedHeaders(): Record<string, string> {
  return { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer' };
}
function successPage(): string { return '<!doctype html><meta charset="utf-8"><title>Restiprocity</title><style>body{font-family:system-ui;margin:3rem;background:#1e1e2e;color:#cdd6f4}</style><h1>Return to Restiprocity</h1><p>You can close this tab.</p>'; }
function failurePage(): string { return '<!doctype html><meta charset="utf-8"><title>Restiprocity</title><style>body{font-family:system-ui;margin:3rem;background:#1e1e2e;color:#cdd6f4}</style><h1>Sign-in was not completed</h1><p>Return to Restiprocity.</p>'; }
function operationId(): string { return Buffer.from(randomBytes(16)).toString('hex'); }
function safeError(code: string, message: string): Error & { code: string } { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
function isLoopbackPeer(value: string | undefined): boolean { return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'; }

export class OAuthService {
  private readonly entries = new Map<string, Entry>();
  private readonly dependencies: Required<Pick<OAuthServiceDependencies, 'now' | 'monotonicNow' | 'random'>> & OAuthServiceDependencies;
  private readonly callbackServers = new Set<CallbackServer>();
  private interactiveBinding: string | undefined;
  private interactiveCleanup: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly maxEntries = 100;

  constructor(dependencies: OAuthServiceDependencies = {}) {
    this.dependencies = { now: () => Date.now(), monotonicNow: () => Date.now(), random: () => randomBytes(32), ...dependencies };
  }

  getBindingId(input: OAuthBindingInput): string {
    return buildOAuthBindingKey({ id: input.requestId, url: input.requestUrl }, input.environmentId, input.config, this.origin(input.requestUrl));
  }

  status(input: OAuthBindingInput): OAuthTokenStatus {
    const bindingId = this.getBindingId(input);
    const existing = this.entries.get(bindingId);
    if (!existing) return { bindingId, kind: 'unauthorized', revision: 0, ...(isBrowserOAuth(input.config) ? { callbackUri: input.config.redirectUri || callbackUri(input.config) } : {}) };
    existing.lastUsed = this.dependencies.now();
    if (existing.token && this.isExpired(existing.token)) {
      existing.status = { ...existing.status, kind: existing.token.refreshToken ? 'expired' : 'expired', expiresAt: existing.token.expiresAt, hasRefreshToken: !!existing.token.refreshToken };
    }
    return { ...existing.status, ...(isBrowserOAuth(input.config) ? { callbackUri: input.config.redirectUri || callbackUri(input.config) } : {}) };
  }

  getCachedAccessToken(input: OAuthBindingInput): string | undefined {
    const entry = this.entries.get(this.getBindingId(input));
    if (!entry?.token || this.isExpired(entry.token)) return undefined;
    entry.lastUsed = this.dependencies.now();
    return entry.token.accessToken;
  }

  async getAccessToken(input: OAuthBindingInput, signal?: AbortSignal): Promise<string> {
    const bindingId = this.getBindingId(input);
    const entry = this.entry(bindingId);
    entry.lastUsed = this.dependencies.now();
    const normalizedGrant = normalizeOAuthGrant(input.config.grantType);
    if (normalizedGrant === 'password' || normalizedGrant === 'unsupported') throw safeError('OAUTH_UNSUPPORTED_GRANT', 'This OAuth grant is not supported. Use Authorization Code with PKCE or Client Credentials.');
    if (entry.token && !this.isExpired(entry.token)) return entry.token.accessToken;
    if (entry.token?.refreshToken && isBrowserOAuth(input.config)) return this.refresh(input, entry, signal);
    if (isBrowserOAuth(input.config)) throw safeError('OAUTH_NOT_AUTHORIZED', 'Sign in with OAuth before sending this request.');
    return this.acquireClientCredentials(input, entry, signal);
  }

  async start(input: OAuthBindingInput, window?: BrowserWindow): Promise<OAuthTokenStatus> {
    if (isBrowserOAuth(input.config) && [input.requestUrl, ...oauthIdentityValues(input.config)].some(value => containsNondeterministicOAuthReference(value))) throw safeError('OAUTH_INVALID_CONFIG', 'Browser OAuth identity fields cannot use timestamp, randomInt, or uuid.');
    if (isBrowserOAuth(input.config) && (!input.config.authorizationUrl.trim() || !input.config.tokenUrl.trim() || !input.config.clientId.trim())) throw safeError('OAUTH_INVALID_CONFIG', 'OAuth authorization URL, token URL, and client ID are required.');
    const bindingId = this.getBindingId(input);
    const entry = this.entry(bindingId);
    if (!isBrowserOAuth(input.config)) {
      await this.getAccessToken(input);
      return this.status(input);
    }
    if (this.interactiveBinding && this.interactiveBinding !== bindingId) throw safeError('OAUTH_BUSY', 'Another OAuth sign-in is already waiting for a callback.');
    if (entry.operationId) return this.status(input);
    await this.interactiveCleanup;
    if (entry.token && !this.isExpired(entry.token)) return this.status(input);
    const operation = operationId();
    const generation = ++entry.generation;
    this.interactiveBinding = bindingId;
    entry.operationId = operation;
    entry.callbackClaimed = false;
    entry.status = this.publish(entry, { kind: 'opening-browser', operationId: operation, message: 'Opening the system browser.' });
    const callback = this.dependencies.createCallbackServer?.() ?? defaultCallbackServer();
    this.callbackServers.add(callback);
    entry.callbackServer = callback;
    const controller = new AbortController();
    entry.pendingAbort = controller;
    const config = { ...input.config, grantType: 'authorization_code' as const };
    const redirect = config.redirectUri || callbackUri(config);
    let callbackUrl: URL;
    let pkce: ReturnType<typeof createPkcePair>;
    let authorizationUrl: string;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      callbackUrl = new URL(redirect);
      if (!this.validCallbackUrl(callbackUrl, config)) throw safeError('OAUTH_INVALID_CONFIG', 'Redirect URI must be a literal loopback HTTP URI for this OAuth flow.');
      pkce = createPkcePair(this.dependencies.random);
      authorizationUrl = buildAuthorizationUrl(config, pkce.state, pkce.challenge, redirect);
      await callback.listen(callbackUrl.hostname.replace(/^\[|\]$/g, ''), Number(callbackUrl.port), callbackUrl.pathname, async (request, response, result) => {
        if (!result || request.headers.host !== callbackUrl.host || !isLoopbackPeer(request.socket.remoteAddress) || !result.code && !result.error) { response.writeHead(400, fixedHeaders()); response.end(failurePage()); return; }
        const state = new URL(request.url ?? '', `http://${request.headers.host}`).searchParams.get('state');
        if (state !== pkce.state || entry.generation !== generation || entry.operationId !== operation || entry.callbackClaimed) { response.writeHead(400, fixedHeaders()); response.end(failurePage()); return; }
        entry.callbackClaimed = true;
        response.writeHead(200, fixedHeaders()); response.end(result.error ? failurePage() : successPage());
        if (result.error) { entry.status = this.publish(entry, { kind: 'failed', operationId: undefined, code: 'OAUTH_ACCESS_DENIED', message: 'OAuth authorization was denied.' }); await this.finishInteractive(bindingId); return; }
        if (config.expectedIssuer && result.issuer !== config.expectedIssuer) { entry.status = this.publish(entry, { kind: 'failed', operationId: undefined, code: 'OAUTH_ISSUER_MISMATCH', message: 'OAuth issuer did not match the configured issuer.' }); await this.finishInteractive(bindingId); return; }
        entry.status = this.publish(entry, { kind: 'exchanging-code', operationId: operation, message: 'Exchanging authorization code.' });
        try {
          const token = await this.exchange(config, { code: result.code!, redirectUri: redirect, verifier: pkce.verifier }, controller.signal);
          if (entry.generation !== generation) return;
          entry.token = token; entry.status = this.publish(entry, { kind: 'ready', operationId: undefined, message: undefined, code: undefined, expiresAt: token.expiresAt, hasRefreshToken: !!token.refreshToken, grantedScope: token.grantedScope });
        } catch (error) {
          if (entry.generation !== generation) return;
          entry.status = this.publish(entry, { kind: 'failed', operationId: undefined, code: this.errorCode(error), message: this.safeMessage(error) });
        } finally { if (window && !window.isDestroyed()) window.focus(); await this.finishInteractive(bindingId); }
      });
      entry.status = this.publish(entry, { kind: 'waiting-for-sign-in', operationId: operation });
      timeoutId = setTimeout(() => { if (entry.generation === generation && entry.operationId === operation) { controller.abort(safeError('OAUTH_TIMEOUT', 'OAuth sign-in timed out.')); entry.status = this.publish(entry, { kind: 'failed', operationId: undefined, code: 'OAUTH_TIMEOUT', message: 'OAuth sign-in timed out.' }); void this.finishInteractive(bindingId); } }, 5 * 60 * 1000);
      entry.callbackTimeout = timeoutId;
      await (this.dependencies.openExternal ?? (url => shell.openExternal(url)))(authorizationUrl);
      if (window && !window.isDestroyed()) window.focus();
      return this.status(input);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      const superseded = entry.generation !== generation || entry.operationId !== operation;
      await this.finishInteractive(bindingId);
      if (superseded) return this.status(input);
      entry.status = this.publish(entry, { kind: 'failed', operationId: undefined, code: this.errorCode(error), message: this.safeMessage(error) });
      throw error;
    }
  }

  async refresh(input: OAuthBindingInput, entry = this.entry(this.getBindingId(input)), signal?: AbortSignal): Promise<string> {
    if (!entry.token?.refreshToken) throw safeError('OAUTH_NOT_AUTHORIZED', 'Sign in with OAuth before sending this request.');
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    const refreshToken = entry.token.refreshToken;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason ?? safeError('OAUTH_CANCELLED', 'OAuth operation cancelled.'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    entry.pendingAbort = controller;
    entry.status = this.publish(entry, { kind: 'refreshing', hasRefreshToken: true });
    const pending = this.exchange(input.config, { refreshToken }, controller.signal)
      .then(token => {
        if (generation !== entry.generation) throw safeError('OAUTH_CANCELLED', 'OAuth operation was superseded.');
        if (!token.refreshToken) token.refreshToken = refreshToken;
        entry.token = token;
        entry.status = this.publish(entry, { kind: 'ready', operationId: undefined, message: undefined, code: undefined, expiresAt: token.expiresAt, hasRefreshToken: !!token.refreshToken, grantedScope: token.grantedScope });
        return token.accessToken;
      })
      .catch(error => {
        if (generation === entry.generation && this.errorCode(error) === 'OAUTH_INVALID_GRANT') {
          entry.token = undefined;
          entry.status = this.publish(entry, { kind: 'failed', code: 'OAUTH_INVALID_GRANT', message: 'OAuth authorization expired or was revoked.' });
        }
        throw error;
      })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort);
        if (entry.pendingAbort === controller) entry.pendingAbort = undefined;
        if (entry.pending === pending) entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  async acquireClientCredentials(input: OAuthBindingInput, entry = this.entry(this.getBindingId(input)), signal?: AbortSignal): Promise<string> {
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason ?? safeError('OAUTH_CANCELLED', 'OAuth operation cancelled.'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort(signal.reason);
    entry.pendingAbort = controller;
    const pending = this.exchange(input.config, {}, controller.signal)
      .then(token => {
        if (generation !== entry.generation) throw safeError('OAUTH_CANCELLED', 'OAuth operation was superseded.');
        entry.token = token;
        entry.status = this.publish(entry, { kind: 'ready', expiresAt: token.expiresAt, hasRefreshToken: !!token.refreshToken, grantedScope: token.grantedScope });
        return token.accessToken;
      })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort);
        if (entry.pendingAbort === controller) entry.pendingAbort = undefined;
        if (entry.pending === pending) entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  async clear(input: OAuthBindingInput): Promise<OAuthTokenStatus> {
    const requestedId = this.getBindingId(input);
    const [id, entry] = this.findEntry(requestedId, input.operationId);
    if (!entry) return { bindingId: requestedId, kind: 'unauthorized', revision: 0 };
    entry.generation++;
    entry.pendingAbort?.abort();
    await this.finishInteractive(id);
    entry.token = undefined;
    entry.status = this.publish(entry, { kind: 'unauthorized', operationId: undefined, message: undefined, code: undefined, expiresAt: undefined, hasRefreshToken: false, grantedScope: undefined });
    return entry.status;
  }
  async cancel(input: OAuthBindingInput): Promise<OAuthTokenStatus> {
    const requestedId = this.getBindingId(input);
    const [id, entry] = this.findEntry(requestedId, input.operationId);
    if (!entry) return { bindingId: requestedId, kind: 'unauthorized', revision: 0 };
    entry.generation++;
    entry.pendingAbort?.abort();
    entry.status = this.publish(entry, { kind: 'cancelled', operationId: undefined, message: 'OAuth operation cancelled.', code: undefined, expiresAt: undefined, hasRefreshToken: !!entry.token?.refreshToken });
    await this.finishInteractive(id);
    return entry.status;
  }
  dispose(): void { this.disposed = true; for (const entry of this.entries.values()) { entry.generation++; entry.pendingAbort?.abort(); } for (const server of this.callbackServers) void server.close(); this.callbackServers.clear(); }

  private async exchange(config: OAuth2Config, values: { code?: string; verifier?: string; redirectUri?: string; refreshToken?: string }, signal?: AbortSignal): Promise<OAuthToken> {
    if (!config.tokenUrl.trim() || !config.clientId.trim()) throw safeError('OAUTH_INVALID_CONFIG', 'OAuth token URL and client ID are required.');
    const tokenUrl = this.dependencies.session || !this.dependencies.fetch
      ? parseHttpsOrLoopback(config.tokenUrl, 'Token URL')
      : new URL(config.tokenUrl);
    const params = new URLSearchParams();
    const grant = values.refreshToken ? 'refresh_token' : values.code ? 'authorization_code' : 'client_credentials';
    params.set('grant_type', grant);
    if (values.code) { params.set('code', values.code); params.set('redirect_uri', values.redirectUri ?? config.redirectUri); params.set('code_verifier', values.verifier ?? ''); }
    if (values.refreshToken) params.set('refresh_token', values.refreshToken);
    if (config.scope && grant === 'client_credentials') params.set('scope', config.scope);
    const auth = oauthClientAuthentication(config);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (auth === 'basic') {
      const formEncode = (value: string) => new URLSearchParams([['value', value]]).toString().slice('value='.length);
      headers.authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString('base64')}`;
    } else {
      if (config.clientId) params.set('client_id', config.clientId);
      if (auth === 'body' && config.clientSecret) params.set('client_secret', config.clientSecret);
    }
    for (const [key, value] of enabledOAuthParameters(config.tokenParameters)) params.append(key, value);
    const tokenController = new AbortController();
    const forwardAbort = () => tokenController.abort(signal?.reason ?? safeError('OAUTH_CANCELLED', 'OAuth operation cancelled.'));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeoutId = setTimeout(() => tokenController.abort(safeError('OAUTH_TIMEOUT', 'OAuth token request timed out.')), 30_000);
    try {
      const response = await (this.dependencies.fetch ?? this.defaultFetch.bind(this))(tokenUrl.toString(), { method: 'POST', headers, body: params.toString(), redirect: 'error', credentials: 'omit', signal: tokenController.signal }, tokenController.signal);
      if (signal?.aborted || tokenController.signal.aborted) throw tokenController.signal.reason ?? safeError('OAUTH_CANCELLED', 'OAuth operation cancelled.');
      const text = await response.text();
      if (signal?.aborted || tokenController.signal.aborted) throw tokenController.signal.reason ?? safeError('OAUTH_CANCELLED', 'OAuth operation cancelled.');
      if (text.length > OAUTH_MAX_TOKEN_RESPONSE) throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth token response was too large.');
      let payload: any; try { payload = JSON.parse(text); } catch { throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth token response was not valid JSON.'); }
      if (!response.ok) { if (payload?.error === 'invalid_grant') throw safeError('OAUTH_INVALID_GRANT', 'OAuth authorization expired or was revoked.'); if (payload?.error === 'invalid_client') throw safeError('OAUTH_INVALID_CLIENT', 'OAuth client authentication failed.'); throw safeError('OAUTH_TOKEN_REQUEST_FAILED', 'OAuth token request failed.'); }
      if (!isSafeToken(payload?.access_token)) throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth token response did not contain a valid access token.');
      if ((grant === 'authorization_code' || grant === 'refresh_token') && String(payload.token_type ?? '').toLowerCase() !== 'bearer') throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth provider returned an unsupported token type.');
      if (payload.token_type !== undefined && String(payload.token_type).toLowerCase() !== 'bearer') throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth provider returned an unsupported token type.');
      const expires = parseExpiresIn(payload.expires_in); const skew = expires === undefined ? 0 : Math.min(30, expires * 0.1) * 1000;
      const refreshToken = payload.refresh_token === undefined ? undefined : (isSafeToken(payload.refresh_token) ? payload.refresh_token : (() => { throw safeError('OAUTH_INVALID_RESPONSE', 'OAuth token response contained an invalid refresh token.'); })());
      return { accessToken: payload.access_token, refreshToken, expiresAt: expires === undefined ? undefined : this.dependencies.now() + Math.max(0, expires * 1000 - skew), grantedScope: typeof payload.scope === 'string' ? payload.scope : undefined };
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async defaultFetch(url: string, init: RequestInit): Promise<Response> { const oauthSession = this.dependencies.session ?? session.fromPartition('restiprocity-oauth', { cache: false }); return oauthSession.fetch(url, init) as unknown as Response; }
  private entry(id: string): Entry { let entry = this.entries.get(id); if (!entry) { if (this.entries.size >= this.maxEntries) { const candidate = [...this.entries.entries()].filter(([, value]) => !value.pending && !value.operationId).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]; if (candidate) this.entries.delete(candidate[0]); else throw safeError('OAUTH_CACHE_FULL', 'OAuth token cache is busy.'); } entry = { revision: 0, lastUsed: this.dependencies.now(), generation: 0, status: { bindingId: id, kind: 'unauthorized', revision: 0 } }; this.entries.set(id, entry); } return entry; }
  private isExpired(token: OAuthToken): boolean { return token.expiresAt !== undefined && token.expiresAt <= this.dependencies.now(); }
  private publish(entry: Entry, patch: Partial<OAuthTokenStatus>): OAuthTokenStatus { entry.revision++; entry.status = { ...entry.status, ...patch, bindingId: entry.status.bindingId, kind: patch.kind ?? entry.status.kind, revision: entry.revision }; return entry.status; }
  private async finishInteractive(id: string): Promise<void> {
    const entry = this.entries.get(id);
    let cleanup = Promise.resolve();
    if (entry) {
      entry.operationId = undefined;
      entry.callbackClaimed = false;
      entry.pendingAbort = undefined;
      if (entry.callbackTimeout) { clearTimeout(entry.callbackTimeout); entry.callbackTimeout = undefined; }
      const callback = entry.callbackServer;
      entry.callbackServer = undefined;
      if (callback) {
        this.callbackServers.delete(callback);
        cleanup = Promise.resolve().then(() => callback.close()).catch(() => undefined);
        this.interactiveCleanup = cleanup;
      }
    }
    if (this.interactiveBinding === id) this.interactiveBinding = undefined;
    await cleanup;
    if (this.interactiveCleanup === cleanup) this.interactiveCleanup = Promise.resolve();
  }
  private findEntry(requestedId: string, operationId?: string): [string, Entry | undefined] {
    if (operationId) {
      for (const [id, entry] of this.entries) if (entry.operationId === operationId) return [id, entry];
    }
    const direct = this.entries.get(requestedId);
    if (direct) return [requestedId, direct];
    if (this.interactiveBinding) return [this.interactiveBinding, this.entries.get(this.interactiveBinding)];
    return [requestedId, undefined];
  }
  private origin(value: string): string { try { const url = new URL(value); return `${url.protocol}//${url.host}`; } catch { return ''; } }
  private validCallbackUrl(url: URL, config: OAuth2Config): boolean { const hostname = url.hostname.replace(/^\[|\]$/g, ''); return url.protocol === 'http:' && (hostname === OAUTH_CALLBACK_HOST || hostname === '::1') && !!url.port && !url.username && !url.password && !url.hash && !url.search && url.pathname === new URL(callbackUri(config, url.hostname, Number(url.port))).pathname; }
  private errorCode(error: unknown): string { return typeof error === 'object' && error && 'code' in error && typeof (error as any).code === 'string' ? (error as any).code : 'OAUTH_TOKEN_REQUEST_FAILED'; }
  private safeMessage(error: unknown): string { return error instanceof Error && error.message ? error.message : 'OAuth operation failed.'; }
}
