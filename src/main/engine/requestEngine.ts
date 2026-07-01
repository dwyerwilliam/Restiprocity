import { app, net, Session } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { Request, Response, Header, AuthConfig, IpcRequestPayload, OAuth2Config } from '@shared/types';
import { CollectionStore } from '@main/stores/collectionStore';
import { randomBytes } from 'crypto';
import { buildOAuth2CacheKey, buildOAuth2TokenExchangeRequest, buildNtlmAllowListPattern, formatNtlmUsername } from './authTransport';

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

  constructor(session: Session, collectionStore = new CollectionStore(app.getPath('userData'))) {
    this.session = session;
    this.collectionStore = collectionStore;
  }

  async execute(payload: IpcRequestPayload): Promise<Response | null> {
    const { request, environmentId } = payload;
    const startTime = performance.now();

    this.abortController = new AbortController();

    try {
      // Resolve environment variables
      const resolvedRequest = await this.resolveVariables(request, environmentId);

      if (resolvedRequest.auth.type === 'ntlm') {
        const headers = await this.buildHeaders(resolvedRequest);
        return await this.executeNtlmRequest(resolvedRequest, headers, startTime);
      }

      // Build fetch options
      const fetchOptions = await this.buildFetchOptions(resolvedRequest);

      // Execute request
      const electronResponse = await fetch(resolvedRequest.url, fetchOptions);

      // Read response body
      const bodyBuffer = await electronResponse.arrayBuffer();
      const body = Buffer.from(bodyBuffer).toString('utf-8');
      const size = bodyBuffer.byteLength;

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Build response object
      const resp: Response = {
        id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
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
        timestamp: Date.now(),
        size,
        cookies: [],
      };

      return resp;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Request failed: ${message}`);
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async buildFetchOptions(request: Request): Promise<RequestInit> {
    const headers = await this.buildHeaders(request);
    const options: RequestInit = {
      method: request.method,
      headers,
      redirect: request.settings.followRedirect ? 'follow' : 'manual',
      signal: this.abortController?.signal,
    };

    // Body handling
    if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = await this.buildBody(request, headers);
    }

    // Timeout
    if (request.settings.timeout) {
      options.signal = this.createTimeoutSignal(request.settings.timeout);
    }

    return options;
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
    if (request.settings.userAgent) {
      headers['user-agent'] = request.settings.userAgent;
    }

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

  private async executeNtlmRequest(request: Request, headers: Record<string, string>, startTime: number): Promise<Response> {
    const body = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
      ? await this.buildBody(request, headers)
      : null;

    const url = new URL(request.url);
    this.session.allowNTLMCredentialsForDomains(buildNtlmAllowListPattern(url.hostname));

    return await new Promise<Response>((resolve, reject) => {
      const clientRequest = net.request({ url: request.url, method: request.method, session: this.session });
      let responseStart = 0;
      let timeoutId: NodeJS.Timeout | undefined;
      let finished = false;

      const finalize = (callback: () => void) => {
        if (finished) return;
        finished = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.abortController = null;
        callback();
      };

      const fail = (message: string) => {
        try {
          clientRequest.abort();
        } catch {
        }
        finalize(() => reject(new Error(message)));
      };

      for (const [key, value] of Object.entries(headers)) {
        clientRequest.setHeader(key, value);
      }

      clientRequest.on('redirect', (statusCode, method, redirectUrl) => {
        if (request.settings.followRedirect) {
          clientRequest.followRedirect();
          return;
        }
        fail(`Request failed: redirect to ${redirectUrl} (HTTP ${statusCode}) was blocked`);
      });

      clientRequest.on('login', (authInfo, callback) => {
        if (authInfo.isProxy) {
          callback();
          return;
        }

        const ntlm = request.auth.ntlm;
        if (!ntlm?.username) {
          callback();
          return;
        }

        const username = formatNtlmUsername(ntlm);
        callback(username, ntlm.password || '');
      });

      clientRequest.on('response', (response) => {
        responseStart = performance.now();
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('error', (error) => {
          fail(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        response.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const duration = performance.now() - startTime;
          const ttfb = responseStart > 0 ? responseStart - startTime : duration;
          const download = Math.max(duration - ttfb, 0);
          const resp: Response = {
            id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
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
            timestamp: Date.now(),
            size: bodyBuffer.byteLength,
            cookies: [],
          };

          finalize(() => resolve(resp));
        });
      });

      clientRequest.on('error', (error) => {
        fail(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      });

      if (this.abortController) {
        this.abortController.signal.addEventListener('abort', () => {
          fail('Request cancelled');
        }, { once: true });
      }

      if (request.settings.timeout) {
        timeoutId = setTimeout(() => {
          fail(`Request timed out after ${request.settings.timeout}ms`);
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

  private extractHeaders(resp: globalThis.Response): Header[] {
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

    const environment = await this.collectionStore.getEnvironment(resolvedEnvironmentId);
    if (!environment) {
      return this.interpolateValue(request, new Map<string, string>());
    }

    const variables = new Map(environment.variables.map((variable) => [variable.key, variable.value]));
    return this.interpolateValue(request, variables);
  }

  private interpolateValue<T>(value: T, variables: Map<string, string>): T {
    if (typeof value === 'string') {
      return value.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, key: string) => variables.get(key) ?? match) as T;
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
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken;
    }

    const tokenRequest = buildOAuth2TokenExchangeRequest(config, this.abortController?.signal);
    const response = await fetch(tokenRequest.url, tokenRequest.init);

    if (!response.ok) {
      throw new Error(`OAuth2 token exchange failed: ${response.status} ${response.statusText}`);
    }

    const tokenResponse = await response.json() as OAuthTokenResponse;
    if (typeof tokenResponse.access_token !== 'string' || !tokenResponse.access_token) {
      throw new Error('OAuth2 token exchange failed: response did not include access_token');
    }

    const expiresInSeconds = typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : 3600;
    const safetyWindowMs = 30_000;
    const expiresAt = Date.now() + Math.max(expiresInSeconds * 1000 - safetyWindowMs, 0);
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
        const fileContent = await fs.readFile(filePath, 'utf-8');
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

  private createTimeoutSignal(timeout: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeout);
    return controller.signal;
  }
}
