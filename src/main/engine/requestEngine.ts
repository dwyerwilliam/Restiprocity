import { app, session } from 'electron';
import type { AuthInfo, BaseWindow, Session } from 'electron';
import path from 'path';
import {
  Request,
  Response,
  Header,
  AuthConfig,
  IpcRequestPayload,
  OAuth2Config,
  ResponsePreviewV2,
  ResponseV2,
  DownloadMetadataV2,
} from '@shared/types';
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
import {
  collectResponseBody,
  type ResponseBodyCollectorTerminal,
  type ResponseBodyDownloadRequest,
  type ResponseBodySink,
} from './responseBodyCollector';
import { classifyFinalResponse, type ResponseClassification } from './responseClassifier';
import {
  ResponseDownloadCoordinator,
  ResponseDownloadFailureError,
  type ResponseDownloadActiveHandle,
  type ResponseDownloadCoordinatorDependencies,
  type ResponseDownloadResult,
} from './responseDownloadCoordinator';
import { validateRasterPreview, validateTextPreview, type RasterMediaType } from './responsePreview';

interface OAuthTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

interface OAuthTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

interface StreamingFetchResponse extends RuntimeFetchResponse {
  readonly body: {
    getReader(): {
      read(): Promise<ReadableStreamReadResult<Uint8Array>>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  } | null;
  readonly url?: string;
}

interface OpenedStreamingResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Header[];
  readonly url: string;
  readonly source: AsyncIterable<Uint8Array>;
  readonly headersAt: number;
  readonly abortTransport: () => void;
}

type RequestEngineDownloadDependencies = Pick<
  ResponseDownloadCoordinatorDependencies,
  'fileSystem' | 'createUniqueToken' | 'logger' | 'maximumNameAttempts'
>;

class WebResponseByteSource implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  private returned = false;
  private released = false;

  constructor(private readonly reader: ReturnType<NonNullable<StreamingFetchResponse['body']>['getReader']>) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.returned) return { done: true, value: undefined };
    const next = await this.reader.read();
    if (next.done) this.release();
    return next;
  }

  async return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.returned) {
      this.returned = true;
      void this.reader.cancel().catch(() => undefined).finally(() => this.release());
    }
    return { done: true, value: undefined };
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.reader.releaseLock();
  }
}

class NetResponseByteSource implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  private queued: Uint8Array | undefined;
  private pending: {
    resolve: (result: IteratorResult<Uint8Array>) => void;
    reject: (error: Error) => void;
  } | undefined;
  private terminalError: Error | undefined;
  private ended = false;
  private disposed = false;

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly disposeListeners: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array>> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.queued) {
      const value = this.queued;
      this.queued = undefined;
      this.resume();
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.resume();
    });
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    this.finish();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(chunk: Uint8Array): void {
    if (this.ended || this.terminalError) return;
    this.pause();
    const owned = Uint8Array.from(chunk);
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: false, value: owned });
      return;
    }
    if (this.queued) {
      this.fail(new Error('Response stream emitted data while paused'));
      return;
    }
    this.queued = owned;
  }

  end(): void {
    if (this.ended || this.terminalError) return;
    this.ended = true;
    this.dispose();
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended || this.terminalError) return;
    this.terminalError = error;
    this.dispose();
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.queued = undefined;
    this.dispose();
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve({ done: true, value: undefined });
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.disposeListeners();
  }
}

export class RequestEngine {
  private session: Session;
  private abortController: AbortController | null = null;
  private collectionStore: CollectionStore;
  private oauthTokenCache = new Map<string, OAuthTokenCacheEntry>();
  private runtime: RequestRuntimeAdapters;
  private downloadDependencies: RequestEngineDownloadDependencies;

  constructor(
    session: Session,
    collectionStore = new CollectionStore(app.getPath('userData')),
    runtimeOrNetRequest?: RequestRuntimeAdapterOverrides | NetRequestAdapter,
    downloadDependencies: RequestEngineDownloadDependencies = {},
  ) {
    this.session = session;
    this.collectionStore = collectionStore;
    const overrides = typeof runtimeOrNetRequest === 'function'
      ? { netRequest: runtimeOrNetRequest }
      : runtimeOrNetRequest;
    this.runtime = createRequestRuntimeAdapters(overrides);
    this.downloadDependencies = downloadDependencies;
  }

  async executeV2(payload: IpcRequestPayload, parentWindow?: BaseWindow): Promise<ResponseV2> {
    const { request, environmentId } = payload;
    const startTime = this.runtime.clock.monotonicNow();
    let failureUrl = request.url;
    this.abortController = new AbortController();
    const operationSignal = this.abortController.signal;

    try {
      const resolvedRequest = await this.resolveVariables(request, environmentId);
      const effectiveUrl = composeRequestUrl(resolvedRequest.url, resolvedRequest.parameters, resolvedRequest.auth);
      failureUrl = effectiveUrl;
      const targetSession = resolvedRequest.settings.allowInsecureCertificates
        ? this.createInsecureSession()
        : this.session;
      const headers = await this.buildHeaders(resolvedRequest);
      const opened = resolvedRequest.auth.type === 'ntlm' || resolvedRequest.settings.allowInsecureCertificates
        ? await this.openNetResponseV2(resolvedRequest, headers, effectiveUrl, targetSession)
        : await this.openFetchResponseV2(resolvedRequest, headers, effectiveUrl, targetSession);
      failureUrl = opened.url;

      const classification = classifyFinalResponse({
        method: resolvedRequest.method,
        status: opened.status,
        headers: opened.headers,
        url: opened.url,
        now: this.runtime.clock.wallNow(),
      });
      if (classification.kind === 'empty') await this.closeUnusedResponseSource(opened.source);
      const coordinator = new ResponseDownloadCoordinator({
        ...this.downloadDependencies,
        showSaveDialog: (parent, options) => this.runtime.showSaveDialog(parent, options),
        onPhase: (event) => this.runtime.emitProgress({
          requestId: request.id,
          phase: event.phase,
          receivedBytes: event.receivedBytes,
          ...(event.declaredSize === undefined ? {} : { totalBytes: event.declaredSize }),
        }),
      });
      let downloadRequest: ResponseBodyDownloadRequest | undefined;
      let downloadResult: ResponseDownloadResult | undefined;
      let activeDownload: ResponseDownloadActiveHandle | undefined;

      try {
        const collected = await collectResponseBody({
          source: opened.source,
          classification,
          idleTimeoutMs: resolvedRequest.settings.timeout,
          timers: this.runtime.timers,
          signal: operationSignal,
          onProgress: (receivedBytes) => this.runtime.emitProgress({
            requestId: request.id,
            phase: activeDownload ? 'downloading' : 'receiving',
            receivedBytes,
            ...(classification.declaredSize === undefined ? {} : { totalBytes: classification.declaredSize }),
          }),
          onDownload: async (nextDownload) => {
            downloadRequest = nextDownload;
            const started = await coordinator.start({
              parentWindow,
              suggestedFileName: nextDownload.suggestedFileName,
              mediaType: nextDownload.mediaType,
              declaredSize: nextDownload.declaredSize,
            });
            if (started.kind !== 'ready') {
              downloadResult = started.result;
              if (started.kind === 'cancelled') return null;
              if (started.result.outcome === 'failed') {
                throw new ResponseDownloadFailureError(started.result.failure);
              }
              throw new Error('Response download destination failed');
            }

            const handle = started.handle;
            activeDownload = handle;
            const sink: ResponseBodySink = {
              write: (chunk) => handle.write(chunk),
              close: async () => {
                const completed = await handle.complete();
                downloadResult = completed;
                if (completed.outcome === 'failed') {
                  throw new ResponseDownloadFailureError(completed.failure);
                }
              },
              abort: async () => {
                downloadResult = await handle.cancel();
              },
            };
            return sink;
          },
        });

        if (collected.terminal.kind !== 'completed') opened.abortTransport();
        if (operationSignal.aborted) throw operationSignal.reason ?? new DOMException('Request cancelled', 'AbortError');

        const failedDownload = collected.terminal.kind === 'failed'
          && collected.terminal.error instanceof ResponseDownloadFailureError;
        if (collected.terminal.kind === 'failed' && !failedDownload) throw collected.terminal.error;
        if (collected.terminal.kind === 'cancelled' && downloadResult?.outcome !== 'cancelled') {
          throw new DOMException('Request cancelled', 'AbortError');
        }

        const download = downloadRequest
          ? this.buildDownloadMetadata(downloadRequest, collected.totalBytes, downloadResult, collected.terminal)
          : undefined;
        const preview = this.buildResponsePreview(
          classification,
          opened.headers,
          collected.previewBytes,
          collected.totalBytes,
          collected.complete,
          download,
        );
        const endTime = this.runtime.clock.monotonicNow();
        const duration = endTime - startTime;
        const ttfb = Math.max(opened.headersAt - startTime, 0);
        return {
          version: 2,
          id: `${this.runtime.clock.wallNow()}-${randomBytes(4).toString('hex')}`,
          requestId: request.id,
          status: opened.status,
          statusText: opened.statusText,
          headers: opened.headers,
          preview,
          timings: {
            dns: 0,
            tcp: 0,
            tls: 0,
            ttfb,
            download: Math.max(duration - ttfb, 0),
            total: duration,
          },
          timestamp: this.runtime.clock.wallNow(),
          size: collected.totalBytes,
          ...(classification.declaredSize === undefined ? {} : { declaredSize: classification.declaredSize }),
          cookies: [],
          ...(download ? { download } : {}),
        };
      } finally {
        await coordinator.dispose();
      }
    } catch (err) {
      throw err instanceof RequestFailureError
        ? err
        : new RequestFailureError(classifyRequestFailure(err, failureUrl), err);
    } finally {
      if (this.abortController?.signal === operationSignal) this.abortController = null;
    }
  }

  // Temporary V1 compatibility path. Task 10 cuts callers over to executeV2.
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

  private async openFetchResponseV2(
    request: Request,
    headers: Record<string, string>,
    url: string,
    requestSession: Session,
  ): Promise<OpenedStreamingResponse> {
    const headerSignal = this.createRequestSignal(request.settings.timeout);
    const options: RequestInit = {
      method: request.method,
      headers,
      redirect: request.settings.followRedirect ? 'follow' : 'manual',
      signal: headerSignal.signal,
    };
    if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
      options.body = await this.buildBody(request, headers);
    }

    let response: RuntimeFetchResponse;
    try {
      response = await this.runtime.fetch(requestSession, url, options);
    } finally {
      headerSignal.dispose();
    }

    const streaming = response as StreamingFetchResponse;
    return {
      status: response.status,
      statusText: response.statusText,
      headers: this.extractHeaders(response),
      url: streaming.url || url,
      source: this.webResponseSource(streaming.body),
      headersAt: this.runtime.clock.monotonicNow(),
      abortTransport: () => {},
    };
  }

  private async openNetResponseV2(
    request: Request,
    headers: Record<string, string>,
    url: string,
    requestSession: Session,
  ): Promise<OpenedStreamingResponse> {
    const body = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
      ? await this.buildBody(request, headers)
      : null;
    if (request.auth.type === 'ntlm') {
      requestSession.allowNTLMCredentialsForDomains(buildNtlmAllowListPattern(new URL(url).hostname));
    }

    return await new Promise<OpenedStreamingResponse>((resolve, reject) => {
      const clientRequest = this.runtime.netRequest({ url, method: request.method, session: requestSession });
      const operationSignal = this.abortController?.signal;
      let finalUrl = url;
      let headerTimer: RequestTimerHandle | undefined;
      let timeoutSettlement: RequestTimerHandle | undefined;
      let timeoutFailure: Error | undefined;
      let source: NetResponseByteSource | undefined;
      let headersSettled = false;
      let terminal = false;
      let transportAborted = false;

      const isAbortInducedError = (error: unknown) => {
        if (!error || typeof error !== 'object') return false;
        const errorLike = error as { name?: unknown; code?: unknown };
        return errorLike.name === 'AbortError' || errorLike.code === 'ERR_ABORTED';
      };
      const clearHeaderTimers = () => {
        if (headerTimer) this.runtime.timers.clearTimeout(headerTimer);
        if (timeoutSettlement) this.runtime.timers.clearImmediate(timeoutSettlement);
        headerTimer = undefined;
        timeoutSettlement = undefined;
      };
      const abortTransport = () => {
        if (transportAborted) return;
        transportAborted = true;
        clientRequest.abort();
      };
      const disposeRequestListeners = () => {
        clientRequest.off('redirect', onRedirect);
        clientRequest.off('login', onLogin);
        clientRequest.off('response', onResponse);
        clientRequest.off('error', onRequestError);
        clientRequest.off('close', onClose);
        operationSignal?.removeEventListener('abort', onAbortBeforeHeaders);
      };
      const failBeforeHeaders = (error: Error, shouldAbort: boolean) => {
        if (terminal || headersSettled) return;
        terminal = true;
        clearHeaderTimers();
        disposeRequestListeners();
        let failure = error;
        if (shouldAbort) {
          try {
            abortTransport();
          } catch (abortError) {
            if (!isAbortInducedError(abortError)) failure = abortError instanceof Error ? abortError : new Error(String(abortError));
          }
        }
        reject(failure);
      };
      const onRedirect = (statusCode: number, _method: string, redirectUrl: string) => {
        if (!request.settings.followRedirect) {
          failBeforeHeaders(new Error(`Request failed: redirect to ${redirectUrl} (HTTP ${statusCode}) was blocked`), true);
          return;
        }
        finalUrl = redirectUrl;
        clientRequest.followRedirect();
      };
      const onLogin = (authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
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
          callback(formatNtlmUsername(ntlm), ntlm.password || '');
          return;
        }
        callback();
      };
      const onResponse = (response: RuntimeIncomingMessage) => {
        if (terminal || headersSettled) return;
        headersSettled = true;
        clearHeaderTimers();
        operationSignal?.removeEventListener('abort', onAbortBeforeHeaders);
        const pausable = response as RuntimeIncomingMessage & { pause?: () => void; resume?: () => void };
        const lifecycle = response as unknown as {
          on(event: 'aborted' | 'close', listener: () => void): void;
          off(event: 'aborted' | 'close', listener: () => void): void;
        };
        const pause = () => pausable.pause?.call(response);
        const resume = () => pausable.resume?.call(response);
        let byteSource!: NetResponseByteSource;
        let responseEnded = false;
        const onData = (chunk: Buffer) => byteSource.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const onResponseError = (error: Error) => byteSource.fail(error);
        const onEnd = () => {
          responseEnded = true;
          byteSource.end();
        };
        const onAborted = () => byteSource.fail(new Error('Response body terminated by remote peer before completion'));
        const onResponseClose = () => {
          if (!responseEnded) byteSource.fail(new Error('Response body closed before completion'));
        };
        const disposeResponseListeners = () => {
          response.off('data', onData);
          response.off('error', onResponseError);
          response.off('end', onEnd);
          lifecycle.off('aborted', onAborted);
          lifecycle.off('close', onResponseClose);
          disposeRequestListeners();
        };
        byteSource = new NetResponseByteSource(pause, resume, disposeResponseListeners);
        source = byteSource;
        response.on('data', onData);
        response.on('error', onResponseError);
        response.on('end', onEnd);
        lifecycle.on('aborted', onAborted);
        lifecycle.on('close', onResponseClose);
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: this.extractHeadersFromNet(response.headers),
          url: finalUrl,
          source: byteSource,
          headersAt: this.runtime.clock.monotonicNow(),
          abortTransport,
        });
      };
      const onRequestError = (error: Error) => {
        if (headersSettled) {
          source?.fail(error);
          return;
        }
        if (timeoutFailure && isAbortInducedError(error)) return;
        failBeforeHeaders(error, false);
      };
      const onClose = () => {
        if (!headersSettled) return;
        disposeRequestListeners();
      };
      const onAbortBeforeHeaders = () => failBeforeHeaders(new DOMException('Request cancelled', 'AbortError'), true);

      for (const [key, value] of Object.entries(headers)) clientRequest.setHeader(key, value);
      clientRequest.on('redirect', onRedirect);
      clientRequest.on('login', onLogin);
      clientRequest.on('response', onResponse);
      clientRequest.on('error', onRequestError);
      clientRequest.on('close', onClose);
      operationSignal?.addEventListener('abort', onAbortBeforeHeaders, { once: true });

      if (request.settings.timeout > 0) {
        headerTimer = this.runtime.timers.setTimeout(() => {
          const failure = new DOMException(`Request timed out after ${request.settings.timeout}ms`, 'TimeoutError');
          timeoutFailure = failure;
          try {
            abortTransport();
          } catch (abortError) {
            failBeforeHeaders(isAbortInducedError(abortError) ? failure : abortError as Error, false);
            return;
          }
          if (!terminal && !headersSettled) {
            timeoutSettlement = this.runtime.timers.setImmediate(() => failBeforeHeaders(failure, false));
          }
        }, request.settings.timeout);
      }

      if (body) clientRequest.end(body);
      else clientRequest.end();
    });
  }

  private webResponseSource(body: StreamingFetchResponse['body']): AsyncIterable<Uint8Array> {
    if (!body) return { async *[Symbol.asyncIterator]() {} };
    return new WebResponseByteSource(body.getReader());
  }

  private async closeUnusedResponseSource(source: AsyncIterable<Uint8Array>): Promise<void> {
    const iterator = source[Symbol.asyncIterator]();
    if (iterator.return) await iterator.return();
  }

  private buildDownloadMetadata(
    request: ResponseBodyDownloadRequest,
    totalBytes: number,
    result: ResponseDownloadResult | undefined,
    terminal: ResponseBodyCollectorTerminal,
  ): DownloadMetadataV2 {
    let state: DownloadMetadataV2['state'] = 'failed';
    let receivedBytes = totalBytes;
    let failure: DownloadMetadataV2['failure'];
    if (result) {
      state = result.outcome;
      receivedBytes = result.receivedBytes;
      if (result.outcome === 'failed') failure = result.failure;
    } else if (terminal.kind === 'completed') {
      state = 'saved';
    } else if (terminal.kind === 'cancelled') {
      state = 'cancelled';
    } else if (terminal.error instanceof ResponseDownloadFailureError) {
      failure = terminal.error.failure;
    }

    return {
      state,
      reason: request.reason,
      mediaType: request.mediaType,
      suggestedFileName: request.suggestedFileName,
      receivedBytes,
      ...(request.declaredSize === undefined ? {} : { declaredSize: request.declaredSize }),
      ...(failure ? { failure } : {}),
    };
  }

  private buildResponsePreview(
    classification: ResponseClassification,
    headers: readonly Header[],
    previewBytes: Uint8Array,
    totalBytes: number,
    complete: boolean,
    download: DownloadMetadataV2 | undefined,
  ): ResponsePreviewV2 {
    if (classification.kind === 'empty') {
      return { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'complete' };
    }
    if (classification.kind === 'text') {
      return validateTextPreview({
        chunks: [previewBytes],
        format: classification.format,
        complete: complete && previewBytes.byteLength === totalBytes,
        declaredCharset: this.extractDeclaredCharset(headers),
        totalBytes,
      }).preview;
    }
    if (classification.kind === 'raster' && !download) {
      const validation = validateRasterPreview({
        chunks: [previewBytes],
        mediaType: classification.mediaType as RasterMediaType,
        complete,
        totalBytes,
      });
      if (validation.eligible) return validation.preview;
    }

    const metadata = download ?? {
      state: 'failed' as const,
      reason: 'unsupported-media-type' as const,
      mediaType: classification.mediaType,
      receivedBytes: totalBytes,
    };
    if (previewBytes.byteLength === 0) {
      return {
        kind: 'download-only',
        mediaType: classification.mediaType,
        capturedBytes: 0,
        totalBytes,
        truncated: totalBytes > 0,
        download: metadata,
      };
    }
    return {
      kind: 'binary',
      mediaType: classification.mediaType,
      capturedBytes: previewBytes.byteLength,
      totalBytes,
      truncated: totalBytes > previewBytes.byteLength,
      download: metadata,
    };
  }

  private extractDeclaredCharset(headers: readonly Header[]): string | undefined {
    const contentType = headers.find((header) =>
      header.enabled && header.key.toLowerCase() === 'content-type'
    )?.value;
    if (!contentType) return undefined;
    for (const parameter of contentType.split(';').slice(1)) {
      const [name, value] = parameter.split('=', 2);
      if (name.trim().toLowerCase() === 'charset') return value?.trim();
    }
    return undefined;
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
