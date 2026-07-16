import { app, session } from 'electron';
import type { AuthInfo, Session } from 'electron';
import path from 'path';
import { Request, Response, Header, AuthConfig, IpcRequestPayload, OAuth2Config } from '@shared/types';
import { composeRequestUrl, expandUrlVariableShorthand } from '@shared/urlVariables';
import { CollectionStore } from '@main/stores/collectionStore';
import { randomBytes } from 'crypto';
import { buildOAuth2CacheKey, buildOAuth2TokenExchangeRequest, buildNtlmAllowListPattern, formatNtlmUsername } from './authTransport';
import { classifyRequestFailure, RequestFailureError } from './requestErrors';
import {
  createRequestRuntimeAdapters,
  NetRequestAdapter,
  RequestRuntimeAdapterOverrides,
  RequestRuntimeAdapters,
  RequestTimerHandle,
  RuntimeFetchResponse,
  RuntimeIncomingMessage,
} from './requestRuntimeAdapters';

interface OAuthTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

export class RequestEngine {
  private session: Session;
  private abortController: AbortController | null = null;
  private collectionStore: CollectionStore;
  private oauthTokenCache = new Map<string, OAuthTokenCacheEntry>();
  private runtime: RequestRuntimeAdapters;

  constructor(
    session: Session,
    collectionStore = new CollectionStore(app.getPath('userData')),
    runtimeOrNetRequest?: RequestRuntimeAdapterOverrides | NetRequestAdapter,
  ) {
    this.session = session;
    this.collectionStore = collectionStore;
    const overrides = typeof runtimeOrNetRequest === 'function'
      ? { netRequest: runtimeOrNetRequest }
      : runtimeOrNetRequest;
    this.runtime = createRequestRuntimeAdapters(overrides);
  }

  async execute(payload: IpcRequestPayload): Promise<Response | null> {
    const { request, environmentId } = payload;
    const startTime = this.runtime.clock.monotonicNow();
    let failureUrl = request.url;

    this.abortController = new AbortController();

    try {
      // Resolve environment variables
      const resolvedRequest = await this.resolveVariables(request, environmentId);
      const effectiveUrl = composeRequestUrl(resolvedRequest.url, resolvedRequest.parameters, resolvedRequest.auth);
      failureUrl = effectiveUrl;

      // Use a partitioned session for insecure requests to avoid modifying the global session
      const targetSession = resolvedRequest.settings.allowInsecureCertificates
        ? this.createInsecureSession()
        : this.session;

      if (resolvedRequest.auth.type === 'ntlm' || resolvedRequest.settings.allowInsecureCertificates) {
        const headers = await this.buildHeaders(resolvedRequest);
        return await this.executeNetRequest(resolvedRequest, headers, startTime, effectiveUrl, targetSession);
      }

      // Build fetch options
      const { options: fetchOptions, dispose: disposeFetchSignal } = await this.buildFetchOptions(resolvedRequest);

      try {
        // Execute request
        const electronResponse = await this.runtime.fetch(targetSession, effectiveUrl, fetchOptions);

        // Read response body
        const bodyBuffer = await electronResponse.arrayBuffer();
        const body = Buffer.from(bodyBuffer).toString('utf-8');
        const size = bodyBuffer.byteLength;

        const endTime = this.runtime.clock.monotonicNow();
        const duration = endTime - startTime;

        // Build response object
        const resp: Response = {
          id: `${this.runtime.clock.wallNow()}-${randomBytes(4).toString('hex')}`,
          requestId: request.id,
          status: electronResponse.status,
          statusText: electronResponse.statusText,
          headers: this.extractHeaders(electronResponse),
          body,
          timings: {
            dns: 0, // Electron doesn't expose granular timings easily
            tcp: 0,
            tls: 0,
            ttfb: duration * 0.3, // Approximation
            download: duration * 0.7,
            total: duration,
          },
          timestamp: this.runtime.clock.wallNow(),
          size,
          cookies: [],
        };

        return resp;
      } finally {
        disposeFetchSignal();
      }
    } catch (err) {
      throw new RequestFailureError(classifyRequestFailure(err, failureUrl), err);
    }
  }

  /** Create a partitioned session that bypasses TLS certificate verification. */
  private createInsecureSession(): Session {
    const insecureSession = session.fromPartition('insecure-request', {
      cache: false,
    });
    insecureSession.setCertificateVerifyProc((_request, callback) => callback(0));
    return insecureSession;
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async buildFetchOptions(request: Request): Promise<{ options: RequestInit; dispose: () => void }> {
    const headers = await this.buildHeaders(request);
    const requestSignal = this.createRequestSignal(request.settings.timeout);
    const options: RequestInit = {
      method: request.method,
      headers,
      redirect: request.settings.followRedirect ? 'follow' : 'manual',
      signal: requestSignal.signal,
    };

    // Body handling
    if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = await this.buildBody(request, headers);
    }

    return { options, dispose: requestSignal.dispose };
  }

  private async buildHeaders(request: Request): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    // Enabled custom headers
    for (const h of request.headers) {
      if (h.enabled && h.key) {
        headers[h.key.toLowerCase()] = h.value;
      }
    }

    // Auth headers
    await this.applyAuthHeaders(request.auth, headers);

    // User-Agent override
    headers['user-agent'] = request.settings.userAgent?.trim() || 'Restiprocity';

    return headers;
  }

  private async applyAuthHeaders(auth: AuthConfig, headers: Record<string, string>): Promise<void> {
    switch (auth.type) {
      case 'bearer':
        if (auth.bearer?.token) {
          headers['authorization'] = `${auth.bearer.prefix || 'Bearer'} ${auth.bearer.token}`;
        }
        break;
      case 'api_key':
        if (auth.api_key?.key && auth.api_key?.value) {
          if (auth.api_key.in === 'header') {
            headers[auth.api_key.key.toLowerCase()] = auth.api_key.value;
          }
          // Query param handled in URL resolution
        }
        break;
      case 'basic':
        if (auth.basic?.username && auth.basic?.password) {
          const credentials = Buffer.from(`${auth.basic.username}:${auth.basic.password}`).toString('base64');
          headers['authorization'] = `Basic ${credentials}`;
        }
        break;
      case 'oauth2':
        if (auth.oauth2?.grantType === 'client_credentials') {
          const token = await this.getOAuth2Token(auth.oauth2);
          headers['authorization'] = `Bearer ${token}`;
        }
        break;
      case 'ntlm':
        break;
    }
  }

  private async executeNetRequest(request: Request, headers: Record<string, string>, startTime: number, url: string, reqSession: Session): Promise<Response> {
    const body = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
      ? await this.buildBody(request, headers)
      : null;

    if (request.auth.type === 'ntlm') {
      const parsedUrl = new URL(url);
      reqSession.allowNTLMCredentialsForDomains(buildNtlmAllowListPattern(parsedUrl.hostname));
    }

    return await new Promise<Response>((resolve, reject) => {
      const clientRequest = this.runtime.netRequest({ url, method: request.method, session: reqSession });
      let responseStart = 0;
      let timeoutId: RequestTimerHandle | undefined;
      let timeoutSettlementId: RequestTimerHandle | undefined;
      let timeoutFailure: Error | undefined;
      let finished = false;
      let disposeActiveResponse: (() => void) | undefined;
      const abortSignal = this.abortController?.signal;
      const onAbort = () => fail(new Error('Request cancelled'));

      const finalize = (callback: () => void) => {
        if (finished) return false;
        finished = true;
        if (timeoutId) {
          this.runtime.timers.clearTimeout(timeoutId);
        }
        if (timeoutSettlementId) {
          this.runtime.timers.clearImmediate(timeoutSettlementId);
        }
        abortSignal?.removeEventListener('abort', onAbort);
        this.abortController = null;
        callback();
        return true;
      };

      const isAbortInducedError = (error: unknown) => {
        if (!error || typeof error !== 'object') return false;
        const errorLike = error as { name?: unknown; code?: unknown };
        return errorLike.name === 'AbortError' || errorLike.code === 'ERR_ABORTED';
      };

      const abortRequest = (): Error | null => {
        try {
          clientRequest.abort();
          return null;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      };

      const fail = (error: Error, shouldAbort = true) => {
        finalize(() => {
          const abortError = shouldAbort ? abortRequest() : null;
          reject(abortError && !isAbortInducedError(abortError) ? abortError : error);
        });
      };

      for (const [key, value] of Object.entries(headers)) {
        clientRequest.setHeader(key, value);
      }

      const onRedirect = (statusCode: number, _method: string, redirectUrl: string) => {
        if (request.settings.followRedirect) {
          clientRequest.followRedirect();
          return;
        }
        fail(new Error(`Request failed: redirect to ${redirectUrl} (HTTP ${statusCode}) was blocked`));
      };

      const onLogin = (
        authInfo: AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (authInfo.isProxy) {
          callback();
          return;
        }

        const ntlm = request.auth.ntlm;

        if (ntlm?.useCurrentAuthContext !== false) {
          callback();
          return;
        }

        if (ntlm?.username) {
          const username = formatNtlmUsername(ntlm);
          callback(username, ntlm.password || '');
          return;
        }

        callback();
      };

      const onResponse = (response: RuntimeIncomingMessage) => {
        responseStart = this.runtime.clock.monotonicNow();
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const disposeResponse = () => {
          response.off('data', onData);
          response.off('error', onResponseError);
          response.off('end', onEnd);
          if (disposeActiveResponse === disposeResponse) disposeActiveResponse = undefined;
        };
        const onResponseError = (error: Error) => {
          disposeResponse();
          fail(new Error(`Request failed: ${error.message}`));
        };
        const onEnd = () => {
          disposeResponse();
          const bodyBuffer = Buffer.concat(chunks);
          const duration = this.runtime.clock.monotonicNow() - startTime;
          const ttfb = responseStart > 0 ? responseStart - startTime : duration;
          const download = Math.max(duration - ttfb, 0);
          const resp: Response = {
            id: `${this.runtime.clock.wallNow()}-${randomBytes(4).toString('hex')}`,
            requestId: request.id,
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? '',
            headers: this.extractHeadersFromNet(response.headers),
            body: bodyBuffer.toString('utf-8'),
            timings: {
              dns: 0,
              tcp: 0,
              tls: 0,
              ttfb,
              download,
              total: duration,
            },
            timestamp: this.runtime.clock.wallNow(),
            size: bodyBuffer.byteLength,
            cookies: [],
          };

          finalize(() => resolve(resp));
        };

        disposeActiveResponse?.();
        disposeActiveResponse = disposeResponse;
        response.on('data', onData);
        response.on('error', onResponseError);
        response.on('end', onEnd);
      };

      const onRequestError = (error: Error) => {
        if (timeoutFailure && isAbortInducedError(error)) return;
        fail(error, false);
      };

      const onClose = () => {
        disposeActiveResponse?.();
        clientRequest.off('redirect', onRedirect);
        clientRequest.off('login', onLogin);
        clientRequest.off('response', onResponse);
        clientRequest.off('error', onRequestError);
        clientRequest.off('close', onClose);
      };

      clientRequest.on('redirect', onRedirect);
      clientRequest.on('login', onLogin);
      clientRequest.on('response', onResponse);
      clientRequest.on('error', onRequestError);
      clientRequest.on('close', onClose);

      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      if (request.settings.timeout) {
        timeoutId = this.runtime.timers.setTimeout(() => {
          const failure = new Error(`Request timed out after ${request.settings.timeout}ms`);
          timeoutFailure = failure;
          const abortError = abortRequest();
          if (abortError) {
            fail(isAbortInducedError(abortError) ? failure : abortError, false);
            return;
          }
          if (!finished) {
            timeoutSettlementId = this.runtime.timers.setImmediate(() => fail(failure, false));
          }
        }, request.settings.timeout);
      }

      if (body) {
        clientRequest.end(body);
      } else {
        clientRequest.end();
      }
    });
  }

  private async buildBody(request: Request, headers: Record<string, string>): Promise<string | null> {
    switch (request.body.type) {
      case 'raw':
        if (request.body.raw) {
          // Set content type based on language
          const lang = request.body.raw.language;
          const contentTypes: Record<string, string> = {
            json: 'application/json',
            xml: 'application/xml',
            text: 'text/plain',
            html: 'text/html',
            javascript: 'application/javascript',
          };
          // Content-Type will be set in headers if not already
          return request.body.raw.content;
        }
        return null;
      case 'form-urlencoded':
        if (request.body.form) {
          const params = new URLSearchParams();
          for (const field of request.body.form) {
            if (field.enabled) {
              params.append(field.key, field.value);
            }
          }
          return params.toString();
        }
        return null;
      case 'multipart':
        if (request.body.multipart) {
          const boundary = `----RestiprocityBoundary${randomBytes(16).toString('hex')}`;
          if (!headers['content-type']) {
            headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
          }
          return await this.buildMultipartBody(request.body.multipart, boundary);
        }
        return null;
      default:
        return null;
    }
  }

  private extractHeaders(resp: Pick<RuntimeFetchResponse, 'headers'>): Header[] {
    const headers: Header[] = [];
    for (const [key, value] of resp.headers.entries()) {
      headers.push({ key, value, enabled: true });
    }
    return headers;
  }

  private extractHeadersFromNet(headers: Record<string, string | string[] | undefined>): Header[] {
    const result: Header[] = [];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        result.push({ key, value: value.join(', '), enabled: true });
      } else if (typeof value === 'string') {
        result.push({ key, value, enabled: true });
      }
    }
    return result;
  }

  private async resolveVariables(request: Request, environmentId?: string): Promise<Request> {
    const resolvedEnvironmentId = environmentId ?? this.collectionStore.getActiveEnvironmentId() ?? undefined;
    if (!resolvedEnvironmentId) {
      return this.interpolateValue(request, new Map<string, string>());
    }

    const variables = await this.collectEnvironmentVariables(resolvedEnvironmentId);
    if (variables.size === 0) {
      return this.interpolateValue(request, new Map<string, string>());
    }

    return this.interpolateValue(request, variables);
  }

  private async collectEnvironmentVariables(environmentId: string, seen = new Set<string>()): Promise<Map<string, string>> {
    const environment = await this.collectionStore.getEnvironment(environmentId);
    if (!environment || seen.has(environment.id)) {
      return new Map<string, string>();
    }

    seen.add(environment.id);

    const variables = environment.parentId
      ? await this.collectEnvironmentVariables(environment.parentId, seen)
      : new Map<string, string>();

    for (const variable of environment.variables) {
      variables.set(variable.key, variable.value);
    }

    return variables;
  }

  private interpolateValue<T>(value: T, variables: Map<string, string>): T {
    if (typeof value === 'string') {
      return expandUrlVariableShorthand(value, { knownKeys: new Set(variables.keys()), includeTrailingUnknown: true })
        .replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key: string) => variables.get(key) ?? match) as T;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.interpolateValue(item, variables)) as T;
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, entryValue]) => [key, this.interpolateValue(entryValue, variables)]);
      return Object.fromEntries(entries) as T;
    }

    return value;
  }

  private async getOAuth2Token(config: OAuth2Config): Promise<string> {
    const cacheKey = buildOAuth2CacheKey(config);
    const cached = this.oauthTokenCache.get(cacheKey);
    if (cached && this.runtime.clock.wallNow() < cached.expiresAt) {
      return cached.accessToken;
    }

    const tokenRequest = buildOAuth2TokenExchangeRequest(config, this.abortController?.signal);
    const response = await this.runtime.fetch(this.session, tokenRequest.url, tokenRequest.init);

    if (!response.ok) {
      throw new Error(`OAuth2 token exchange failed: ${response.status} ${response.statusText}`);
    }

    const tokenResponse = await response.json() as OAuthTokenResponse;
    if (typeof tokenResponse.access_token !== 'string' || !tokenResponse.access_token) {
      throw new Error('OAuth2 token exchange failed: response did not include access_token');
    }

    const expiresInSeconds = typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : 3600;
    const safetyWindowMs = 30_000;
    const expiresAt = this.runtime.clock.wallNow() + Math.max(expiresInSeconds * 1000 - safetyWindowMs, 0);
    this.oauthTokenCache.set(cacheKey, { accessToken: tokenResponse.access_token, expiresAt });

    return tokenResponse.access_token;
  }

  private async buildMultipartBody(fields: NonNullable<Request['body']['multipart']>, boundary: string): Promise<string> {
    const parts: string[] = [];

    for (const field of fields) {
      if (!field.enabled || !field.key) {
        continue;
      }

      parts.push(`--${boundary}\r\n`);

      if (field.type === 'file') {
        const filePath = field.filePath || field.value;
        const filename = path.basename(filePath);
        const fileContent = await this.runtime.fileSystem.readFile(filePath, 'utf-8');
        parts.push(`Content-Disposition: form-data; name="${this.escapeMultipartName(field.key)}"; filename="${this.escapeMultipartName(filename)}"\r\n`);
        parts.push('Content-Type: application/octet-stream\r\n\r\n');
        parts.push(fileContent);
        parts.push('\r\n');
      } else {
        parts.push(`Content-Disposition: form-data; name="${this.escapeMultipartName(field.key)}"\r\n\r\n`);
        parts.push(field.value);
        parts.push('\r\n');
      }
    }

    parts.push(`--${boundary}--\r\n`);
    return parts.join('');
  }

  private escapeMultipartName(value: string): string {
    return value.replace(/["\\\r\n]/g, (char) => {
      switch (char) {
        case '"':
          return '%22';
        case '\\':
          return '%5C';
        case '\r':
          return '%0D';
        case '\n':
          return '%0A';
        default:
          return char;
      }
    });
  }

  private createRequestSignal(timeout: number): { signal: AbortSignal | undefined; dispose: () => void } {
    if (!timeout) {
      return { signal: this.abortController?.signal, dispose: () => {} };
    }

    const controller = new AbortController();
    const parentSignal = this.abortController?.signal;
    let timeoutId: RequestTimerHandle | undefined = this.runtime.timers.setTimeout(() => {
      controller.abort(new DOMException(`Request timed out after ${timeout}ms`, 'TimeoutError'));
    }, timeout);
    const clearRequestTimeout = () => {
      if (!timeoutId) return;
      this.runtime.timers.clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const cancelRequest = () => {
      controller.abort(new DOMException('Request cancelled', 'AbortError'));
    };

    controller.signal.addEventListener('abort', clearRequestTimeout, { once: true });
    parentSignal?.addEventListener('abort', cancelRequest, { once: true });

    return {
      signal: controller.signal,
      dispose: () => {
        clearRequestTimeout();
        controller.signal.removeEventListener('abort', clearRequestTimeout);
        parentSignal?.removeEventListener('abort', cancelRequest);
      },
    };
  }
}
