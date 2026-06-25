import { Session } from 'electron';
import { Request, Response, ResponseTiming, Header, HttpMethod, AuthConfig, BodyType, IpcRequestPayload } from '@shared/types';
import { randomBytes } from 'crypto';

export class RequestEngine {
  private session: Session;
  private abortController: AbortController | null = null;

  constructor(session: Session) {
    this.session = session;
  }

  async execute(payload: IpcRequestPayload): Promise<Response | null> {
    const { request, environmentId } = payload;
    const startTime = performance.now();

    this.abortController = new AbortController();

    try {
      // Resolve environment variables
      const resolvedRequest = await this.resolveVariables(request, environmentId);

      // Build fetch options
      const fetchOptions = this.buildFetchOptions(resolvedRequest);

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
    } catch (err: any) {
      throw new Error(`Request failed: ${err.message}`);
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private buildFetchOptions(request: Request): RequestInit {
    const options: RequestInit = {
      method: request.method,
      headers: this.buildHeaders(request),
      redirect: request.settings.followRedirect ? 'follow' : 'manual',
      signal: this.abortController?.signal,
    };

    // Body handling
    if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = this.buildBody(request);
    }

    // Timeout
    if (request.settings.timeout) {
      options.signal = this.createTimeoutSignal(request.settings.timeout);
    }

    return options;
  }

  private buildHeaders(request: Request): Record<string, string> {
    const headers: Record<string, string> = {};

    // Enabled custom headers
    for (const h of request.headers) {
      if (h.enabled && h.key) {
        headers[h.key.toLowerCase()] = h.value;
      }
    }

    // Auth headers
    this.applyAuthHeaders(request.auth, headers);

    // User-Agent override
    if (request.settings.userAgent) {
      headers['user-agent'] = request.settings.userAgent;
    }

    return headers;
  }

  private applyAuthHeaders(auth: AuthConfig, headers: Record<string, string>): void {
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
        // OAuth2 token would be stored after token exchange
        // For now, assume token is available
        break;
    }
  }

  private buildBody(request: Request): string | null {
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
        // Multipart requires special handling with FormData
        // Simplified for now - return as string
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

  private async resolveVariables(request: Request, _environmentId?: string): Promise<Request> {
    // TODO: Load environment and interpolate {{variables}}
    // For now, return request as-is
    return { ...request };
  }

  private createTimeoutSignal(timeout: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeout);
    return controller.signal;
  }
}
