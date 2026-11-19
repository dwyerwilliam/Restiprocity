import { isActiveMultipart, isMultipartManagedHeader } from '@shared/multipartPolicy';
import { prepareMultipart } from './multipartBody';
import { MultipartOperation } from './multipartOperation';
import { app } from 'electron';
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
import { composeRequestUrl } from '@shared/urlVariables';
import { buildCurlCommand, type CurlCommand } from '@shared/curlExport';
import { createVariableContext, observeDependencies, observeSensitivity, type BuiltInVariableValues, type VariableLayer } from '@shared/variableContext';
import {
  buildOutputLayer,
  enabledOutputNames,
  extractOutputValues,
  FINGERPRINT_BUILT_INS,
  OUTPUT_PLACEHOLDER,
  validateRequestOutputs,
} from '@shared/requestOutputs';
import type { Id, RequestOutputStatus, ResponseOutputsNoteV2, TokenErrorCode } from '@shared/types';
import { RequestOutputService, type AcquiredOutputs, type OutputBinding, type ProducerResult } from '@main/outputs/requestOutputService';
import { computeProducerFingerprint } from '@main/outputs/producerFingerprint';
import { isTokenSourceError, TokenSourceError } from '@main/outputs/tokenErrors';
import type { OutputIndexEntry } from '@main/stores/collectionStore';
import { isBrowserOAuth } from '@shared/oauth';
import { containsNondeterministicOAuthReference, oauthIdentityValues } from '@shared/oauthIdentity';
import { resolveRequestFields } from '@shared/requestInterpolation';
import { CollectionStore } from '@main/stores/collectionStore';
import { randomBytes } from 'crypto';
import { buildNtlmAllowListPattern, formatNtlmUsername } from './authTransport';
import { OAuthService, type OAuthBindingInput } from '@main/oauth/oauthService';
import { classifyRequestFailure, RequestFailureError } from './requestErrors';
import type { ConnectionTimingCapture } from './netLogCapture';
import {
  createRequestRuntimeAdapters,
  NetRequestAdapter,
  RequestRuntimeAdapterOverrides,
  RequestProgressEvent,
  RequestRuntimeAdapters,
  RequestTimerHandle,
  RuntimeFetchResponse,
  RuntimeIncomingMessage,
} from './requestRuntimeAdapters';

/**
 * The per-send state of one execution. Each execution carries its own signal, so a token request run for a send's
 * outputs never replaces the send's cancellation (`cancel()` only reaches the UI operation that `executeV2` started).
 */
export interface ExecutionContext {
  signal: AbortSignal;
  /** `token`: run for outputs — no timing capture, no progress, no Save dialog, 30 s ceiling when the timeout is off. */
  purpose: 'send' | 'token';
  /** Follow redirects only within the request's origin (never HTTPS → HTTP). `oauth` keeps its original message. */
  protectCredentialsOnRedirect: false | 'oauth' | 'output';
  onProgress?: (event: RequestProgressEvent) => void;
}

/** Applied to a token request whose own timeout is turned off. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

type RedirectProtection = ExecutionContext['protectCredentialsOnRedirect'];

function blockedRedirectMessage(protection: Exclude<RedirectProtection, false>, redirectUrl: string): string {
  return protection === 'oauth'
    ? `Request failed: OAuth redirect to ${redirectUrl} was blocked before Authorization could be forwarded`
    : `Request failed: redirect to ${redirectUrl} was blocked because the request carries a fetched token`;
}

function tokenError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** A token request a send used, how it is bound now, and the values it gave this send. */
interface ProducerUse {
  saved: Request;
  binding: OutputBinding;
  acquired: AcquiredOutputs;
  /** The output names this send used from it. */
  names: string[];
}

interface Resolution {
  request: Request;
  producers: ProducerUse[];
  /** Resolves the same request again with the same built-ins and the producers' current values (after a 401 refresh). */
  again(): Request;
  environmentId: string | undefined;
  layers: readonly VariableLayer[];
  index: ReadonlyMap<string, OutputIndexEntry>;
}

/** send and token: may fetch outputs (token refuses any); curl: cached values only; legacy: refuses outputs. */
type ResolveMode = 'send' | 'curl' | 'token' | 'legacy';

function outputLabel(names: readonly string[]): string {
  return names.map(name => `{{${name}}}`).join(', ');
}
import {
  collectResponseBody,
  type ResponseBodyCollectorTerminal,
  type ResponseBodyDownloadRequest,
  type ResponseBodySink,
} from './responseBodyCollector';
import { classifyFinalResponse, type ResponseClassification } from './responseClassifier';
import { markSavedFromNetwork } from './savedFileOrigin';
import {
  ResponseDownloadCoordinator,
  ResponseDownloadFailureError,
  type ResponseDownloadActiveHandle,
  type ResponseDownloadCoordinatorDependencies,
  type ResponseDownloadResult,
} from './responseDownloadCoordinator';
import { validateRasterPreview, validateTextPreview, type RasterMediaType } from './responsePreview';
import { getNetSetCookieLines, parseResponseCookies } from './responseCookies';

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
  readonly setCookieLines: readonly string[];
  readonly receivedAt: number;
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
  private oauthService: OAuthService;
  private runtime: RequestRuntimeAdapters;
  private downloadDependencies: RequestEngineDownloadDependencies;
  private outputService: RequestOutputService;

  constructor(
    session: Session,
    collectionStore = new CollectionStore(app.getPath('userData')),
    runtimeOrNetRequest?: RequestRuntimeAdapterOverrides | NetRequestAdapter,
    downloadDependencies: RequestEngineDownloadDependencies = {},
    oauthService?: OAuthService,
    outputService?: RequestOutputService,
  ) {
    this.session = session;
    this.collectionStore = collectionStore;
    const overrides = typeof runtimeOrNetRequest === 'function'
      ? { netRequest: runtimeOrNetRequest }
      : runtimeOrNetRequest;
    this.runtime = createRequestRuntimeAdapters(overrides);
    this.downloadDependencies = downloadDependencies;
    this.outputService = outputService ?? new RequestOutputService({ clock: this.runtime.clock });
    this.oauthService = oauthService ?? new OAuthService({ fetch: async (url, init) => await this.runtime.fetch(this.session, url, init) as unknown as globalThis.Response });
  }

  async executeV2(
    payload: IpcRequestPayload,
    parentWindow?: BaseWindow,
    onProgress?: (event: RequestProgressEvent) => void,
  ): Promise<ResponseV2> {
    this.abortController = new AbortController();
    const operationSignal = this.abortController.signal;
    try {
      return await this.executeInternal(payload.request, payload.environmentId, {
        signal: operationSignal,
        purpose: 'send',
        protectCredentialsOnRedirect: payload.request.auth.type === 'oauth2' ? 'oauth' : false,
        onProgress: onProgress ?? (event => this.runtime.emitProgress(event)),
      }, parentWindow);
    } finally {
      if (this.abortController?.signal === operationSignal) this.abortController = null;
    }
  }

  /** One execution with its own signal. Main-process only; never reachable over IPC. */
  async executeInternal(
    request: Request,
    environmentId: string | undefined,
    context: ExecutionContext,
    parentWindow?: BaseWindow,
  ): Promise<ResponseV2> {
    const startTime = this.runtime.clock.monotonicNow();
    let failureUrl = request.url;
    const operationSignal = context.signal;
    const tokenRun = context.purpose === 'token';
    const emitProgress = (event: RequestProgressEvent) => {
      if (tokenRun) return;
      (context.onProgress ?? (next => this.runtime.emitProgress(next)))(event);
    };
    let multipart: MultipartOperation | undefined;

    try {
      operationSignal.throwIfAborted();
      const resolution = await this.resolveVariables(request, environmentId, tokenRun ? 'token' : 'send', { signal: operationSignal, emitProgress });
      let resolvedRequest = resolution.request;
      if (tokenRun && !resolvedRequest.settings.timeout) {
        resolvedRequest = { ...resolvedRequest, settings: { ...resolvedRequest.settings, timeout: TOKEN_REQUEST_TIMEOUT_MS } };
      }
      operationSignal.throwIfAborted();
      // A fetched value may be in any header, so a request that used one only follows redirects within its origin.
      const redirectProtection: RedirectProtection = context.protectCredentialsOnRedirect || (resolution.producers.length ? 'output' : false);
      const openAttempt = async (attemptRequest: Request) => {
        if (isActiveMultipart(attemptRequest)) {
          // Each attempt gets its own deadline: receiving headers ends the previous operation's.
          multipart = new MultipartOperation(operationSignal, attemptRequest.settings.timeout, this.runtime);
          multipart.prepared = await prepareMultipart(attemptRequest.body.multipart ?? [], this.runtime.uploadFileSystem, multipart.signal);
          multipart.check();
        }
        const effectiveUrl = composeRequestUrl(attemptRequest.url, attemptRequest.parameters, attemptRequest.auth);
        failureUrl = effectiveUrl;
        const targetSession = attemptRequest.settings.allowInsecureCertificates
          ? this.runtime.getInsecureSession()
          : this.session;
        const headers = await this.buildHeaders(attemptRequest, multipart, environmentId, operationSignal);
        // Started after buildHeaders so an OAuth2 token exchange isn't attributed to this request.
        const capturePromise = tokenRun ? Promise.resolve(null) : this.startConnectionTimingCapture(targetSession, effectiveUrl);
        const timingCapture = multipart ? await multipart.wait(capturePromise, async capture => { await capture?.finish(); }) : await capturePromise;
        try {
          const opened = this.runtime.responseTransport === 'net' || attemptRequest.auth.type === 'ntlm' || attemptRequest.settings.allowInsecureCertificates
            ? await this.openNetResponseV2(attemptRequest, headers, effectiveUrl, targetSession, multipart, operationSignal, redirectProtection)
            : await this.openFetchResponseV2(attemptRequest, headers, effectiveUrl, targetSession, multipart, operationSignal, redirectProtection);
          return { opened, timingCapture };
        } catch (error) {
          await timingCapture?.finish();
          throw error;
        }
      };

      let { opened, timingCapture } = await openAttempt(resolvedRequest);
      let outputsNote: ResponseOutputsNoteV2 | undefined;
      const refresh = tokenRun ? [] : this.outputsToRefreshAfter(opened.status, resolvedRequest, resolution.producers);
      if (refresh.length) {
        // The cached value went bad: drop the 401 unread, fetch new values once, and send again with the same built-ins.
        opened.abortTransport();
        await this.closeUnusedResponseSource(opened.source);
        await timingCapture?.finish();
        multipart?.dispose();
        multipart = undefined;
        for (const producer of refresh) {
          this.outputService.invalidate(producer.binding, producer.acquired.generation);
          emitProgress({ requestId: request.id, phase: 'acquiring-token', receivedBytes: 0, tokenSource: producer.saved.name });
          producer.acquired = await this.outputService.acquire(producer.binding, {
            signal: operationSignal,
            run: signal => this.runProducer(producer.saved, resolution.environmentId, signal),
          });
        }
        emitProgress({ requestId: request.id, phase: 'waiting-headers', receivedBytes: 0 });
        resolvedRequest = resolution.again();
        ({ opened, timingCapture } = await openAttempt(resolvedRequest));
        outputsNote = { kind: 'resent-after-401', names: refresh.flatMap(producer => producer.names) };
      }
      // Connection setup is over once headers arrive; stop recording while the body streams.
      const connectionTimings = timingCapture ? timingCapture.finish() : Promise.resolve(null);
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
        markSaved: markSavedFromNetwork,
        ...this.downloadDependencies,
        showSaveDialog: (parent, options) => this.runtime.showSaveDialog(parent, options),
        onPhase: (event) => emitProgress({
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
          onProgress: (receivedBytes) => emitProgress({
            requestId: request.id,
            phase: activeDownload ? 'downloading' : 'receiving',
            receivedBytes,
            ...(classification.declaredSize === undefined ? {} : { totalBytes: classification.declaredSize }),
          }),
          onDownload: async (nextDownload) => {
            if (tokenRun) {
              // A token request's response must be readable text; it never opens a Save dialog.
              throw tokenError('TOKEN_SOURCE_NOT_TEXT', 'The token request returned a file download instead of text.');
            }
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
        const connection = await connectionTimings;
        const response: ResponseV2 = {
          version: 2,
          id: `${this.runtime.clock.wallNow()}-${randomBytes(4).toString('hex')}`,
          requestId: request.id,
          status: opened.status,
          statusText: opened.statusText,
          headers: opened.headers,
          preview,
          timings: {
            dns: connection?.dns ?? 0,
            tcp: connection?.tcp ?? 0,
            tls: connection?.tls ?? 0,
            ttfb,
            download: Math.max(duration - ttfb, 0),
            total: duration,
            connection: connection?.connection ?? 'unmeasured',
          },
          timestamp: this.runtime.clock.wallNow(),
          size: collected.totalBytes,
          ...(classification.declaredSize === undefined ? {} : { declaredSize: classification.declaredSize }),
          cookies: parseResponseCookies(opened.setCookieLines, opened.url, opened.receivedAt),
          ...(download ? { download } : {}),
        };
        if (!tokenRun) {
          outputsNote ??= this.seedFromManualSend(request, resolution, response);
          if (outputsNote) response.outputsNote = outputsNote;
        }
        return response;
      } finally {
        await coordinator.dispose();
      }
    } catch (err) {
      throw err instanceof RequestFailureError
        ? err
        : new RequestFailureError(classifyRequestFailure(err, failureUrl), err);
    } finally {
      multipart?.dispose();
    }
  }

  // Temporary V1 compatibility path. Task 10 cuts callers over to executeV2.
  async execute(payload: IpcRequestPayload): Promise<Response | null> {
    const { request, environmentId } = payload;
    const startTime = this.runtime.clock.monotonicNow();
    let failureUrl = request.url;

    this.abortController = new AbortController();
    const operationSignal = this.abortController.signal;
    let multipart: MultipartOperation | undefined;

    try {
      // Resolve environment variables
      const resolvedRequest = (await this.resolveVariables(request, environmentId, 'legacy')).request;
      operationSignal.throwIfAborted();
      if (isActiveMultipart(resolvedRequest)) {
        multipart = new MultipartOperation(operationSignal, resolvedRequest.settings.timeout, this.runtime);
        multipart.prepared = await prepareMultipart(resolvedRequest.body.multipart ?? [], this.runtime.uploadFileSystem, multipart.signal);
        multipart.check();
      }
      const effectiveUrl = composeRequestUrl(resolvedRequest.url, resolvedRequest.parameters, resolvedRequest.auth);
      failureUrl = effectiveUrl;

      // Use a partitioned session for insecure requests to avoid modifying the global session
      const targetSession = resolvedRequest.settings.allowInsecureCertificates
        ? this.runtime.getInsecureSession()
        : this.session;

      if (this.runtime.responseTransport === 'net' || resolvedRequest.auth.type === 'ntlm' || resolvedRequest.settings.allowInsecureCertificates) {
        const headers = await this.buildHeaders(resolvedRequest, multipart, environmentId, operationSignal);
        return await this.executeNetRequest(resolvedRequest, headers, startTime, effectiveUrl, targetSession, multipart, operationSignal);
      }

      // Build fetch options
      const { options: fetchOptions, dispose: disposeFetchSignal } = await this.buildFetchOptions(resolvedRequest, multipart, environmentId, operationSignal);

      try {
        // Execute request
        multipart?.check();
        const fetchPromise = this.runtime.fetch(targetSession, effectiveUrl, fetchOptions);
        const electronResponse = multipart ? await multipart.wait(fetchPromise) : await fetchPromise;
        // Legacy fetch keeps its timeout through response-body completion.
        const cookies = parseResponseCookies(electronResponse.headers.getSetCookie?.() ?? [], electronResponse.url || effectiveUrl, this.runtime.clock.wallNow());

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
          cookies,
        };

        return resp;
      } finally {
        disposeFetchSignal();
      }
    } catch (err) {
      throw err instanceof RequestFailureError ? err : new RequestFailureError(classifyRequestFailure(err, failureUrl), err);
    } finally {
      multipart?.dispose();
      if (this.abortController?.signal === operationSignal) this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Interpolates a request exactly as a send would and renders it as cURL. Performs no network I/O. */
  /** `sensitive` is true when the command carries a secret or confidential variable, or a cached OAuth access token. */
  async exportCurl(payload: IpcRequestPayload): Promise<CurlCommand & { sensitive: boolean }> {
    let sensitive = false;
    const resolvedRequest = (await this.resolveVariables(payload.request, payload.environmentId, 'curl', { onSensitive: () => { sensitive = true; } })).request;
    const url = composeRequestUrl(resolvedRequest.url, resolvedRequest.parameters, resolvedRequest.auth);
    const oauth2 = resolvedRequest.auth.type === 'oauth2' ? resolvedRequest.auth.oauth2 : undefined;
    const oauth2AccessToken = oauth2 ? this.oauthService.getCachedAccessToken(this.oauthBinding(resolvedRequest, payload.environmentId, oauth2)) : undefined;
    const command = buildCurlCommand(resolvedRequest, { url, fileBasename: path.basename, ...(oauth2AccessToken ? { oauth2AccessToken } : {}) });
    return { ...command, sensitive: sensitive || !!oauth2AccessToken };
  }

  private async startConnectionTimingCapture(requestSession: Session, requestUrl: string): Promise<ConnectionTimingCapture | null> {
    try {
      return await this.runtime.captureConnectionTimings(requestSession, requestUrl);
    } catch {
      // Measurement is best-effort; a send never fails because timings couldn't be recorded.
      return null;
    }
  }

  private async buildFetchOptions(request: Request, multipart: MultipartOperation | undefined, environmentId: string | undefined, signal: AbortSignal): Promise<{ options: RequestInit; dispose: () => void }> {
    const headers = await this.buildHeaders(request, multipart, environmentId, signal);
    const requestSignal = multipart ? { signal: multipart.signal, dispose: () => {} } : this.createRequestSignal(request.settings.timeout, signal);
    const options: RequestInit = {
      method: request.method,
      headers,
      redirect: request.auth.type === 'oauth2' ? 'manual' : (request.settings.followRedirect ? 'follow' : 'manual'),
      credentials: request.settings.cookiesEnabled !== false ? 'include' : 'omit',
      signal: requestSignal.signal,
    };

    try {
      if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
        options.body = await this.buildBody(request, headers, multipart);
      }
      return { options, dispose: requestSignal.dispose };
    } catch (error) {
      requestSignal.dispose();
      throw error;
    }
  }

  private async buildHeaders(request: Request, multipart: MultipartOperation | undefined, environmentId: string | undefined, signal: AbortSignal): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};

    // Enabled custom headers
    for (const h of request.headers) {
      if (h.enabled && h.key) {
        headers[h.key.toLowerCase()] = h.value;
      }
    }

    // Auth headers
    multipart?.check();
    const authPromise = this.applyAuthHeaders(request, headers, multipart, environmentId, signal);
    if (multipart) await multipart.wait(authPromise); else await authPromise;
    if (multipart?.prepared) {
      for (const key of Object.keys(headers)) if (isMultipartManagedHeader(key)) delete headers[key];
      headers['content-type'] = multipart.prepared.contentType;
    }

    // User-Agent override
    headers['user-agent'] = request.settings.userAgent?.trim() || 'Restiprocity';

    return headers;
  }

  private async applyAuthHeaders(request: Request, headers: Record<string, string>, multipart: MultipartOperation | undefined, environmentId: string | undefined, signal: AbortSignal): Promise<void> {
    const auth = request.auth;
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
        if (auth.oauth2) {
          // Without a multipart operation the send's own signal is the only way cancel() can stop a token request.
          const token = await this.oauthService.getAccessToken(this.oauthBinding(request, environmentId, auth.oauth2), multipart?.signal ?? signal);
          headers['authorization'] = 'Bearer ' + token;
        }
        break;
      case 'ntlm':
        break;
    }
  }

  private async executeNetRequest(request: Request, headers: Record<string, string>, startTime: number, url: string, reqSession: Session, multipart: MultipartOperation | undefined, signal: AbortSignal): Promise<Response> {
    const body = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
      ? await this.buildBody(request, headers, multipart)
      : null;

    if (request.auth.type === 'ntlm') {
      const parsedUrl = new URL(url);
      reqSession.allowNTLMCredentialsForDomains(buildNtlmAllowListPattern(parsedUrl.hostname));
    }

    return await new Promise<Response>((resolve, reject) => {
      multipart?.check();
      const clientRequest = this.runtime.netRequest({ url, method: request.method, session: reqSession,
        useSessionCookies: request.settings.cookiesEnabled !== false, redirect: 'manual' });
      let finalUrl = url;
      let responseStart = 0;
      let timeoutId: RequestTimerHandle | undefined;
      let timeoutSettlementId: RequestTimerHandle | undefined;
      let timeoutFailure: Error | undefined;
      let finished = false;
      let disposeActiveResponse: (() => void) | undefined;
      const abortSignal = multipart?.signal ?? signal;
      const onAbort = () => fail(abortSignal?.reason ?? new Error('Request cancelled'));

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
        if (this.abortController?.signal === abortSignal) this.abortController = null;
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
          reject(!multipart && abortError && !isAbortInducedError(abortError) ? abortError : error);
        });
      };

      for (const [key, value] of Object.entries(headers)) {
        clientRequest.setHeader(key, value);
      }

      const oauthOrigin = request.auth.type === 'oauth2' ? new URL(url).origin : undefined;
      const onRedirect = (statusCode: number, _method: string, redirectUrl: string) => {
        if (oauthOrigin) {
          let nextOrigin = '';
          try { nextOrigin = new URL(redirectUrl, finalUrl).origin; } catch { nextOrigin = ''; }
          if (!nextOrigin || (new URL(finalUrl).protocol === 'https:' && new URL(redirectUrl, finalUrl).protocol !== 'https:') || nextOrigin !== oauthOrigin) { fail(new Error(`Request failed: OAuth redirect to ${redirectUrl} was blocked before Authorization could be forwarded`)); return; }
        }
        if (request.settings.followRedirect) {
          finalUrl = redirectUrl;
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
        const cookies = parseResponseCookies(getNetSetCookieLines(response.headers), finalUrl, this.runtime.clock.wallNow());
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
            cookies,
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

      if (!multipart && request.settings.timeout) {
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
    multipart: MultipartOperation | undefined,
    signal: AbortSignal,
    redirectProtection: RedirectProtection,
  ): Promise<OpenedStreamingResponse> {
    const headerSignal = multipart ? { signal: multipart.signal, dispose: () => {} } : this.createRequestSignal(request.settings.timeout, signal);
    const options: RequestInit = {
      method: request.method,
      headers,
      // Protected credentials: fetch can't check where a redirect goes, so it returns the 3xx unfollowed.
      redirect: redirectProtection ? 'manual' : (request.settings.followRedirect ? 'follow' : 'manual'),
      credentials: request.settings.cookiesEnabled !== false ? 'include' : 'omit',
      signal: headerSignal.signal,
    };
    let response: RuntimeFetchResponse;
    try {
      if (request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD') {
        options.body = await this.buildBody(request, headers, multipart);
      }
      multipart?.check();
      const fetched = this.runtime.fetch(requestSession, url, options);
      response = multipart ? await multipart.wait(fetched) : await fetched;
      multipart?.headersReceived();
    } finally {
      headerSignal.dispose();
    }

    const streaming = response as StreamingFetchResponse;
    return {
      status: response.status,
      statusText: response.statusText,
      headers: this.extractHeaders(response),
      setCookieLines: response.headers.getSetCookie?.() ?? [],
      receivedAt: this.runtime.clock.wallNow(),
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
    multipart: MultipartOperation | undefined,
    signal: AbortSignal,
    redirectProtection: RedirectProtection,
  ): Promise<OpenedStreamingResponse> {
    const body = request.body.type !== 'none' && request.method !== 'GET' && request.method !== 'HEAD'
      ? await this.buildBody(request, headers, multipart)
      : null;
    if (request.auth.type === 'ntlm') {
      requestSession.allowNTLMCredentialsForDomains(buildNtlmAllowListPattern(new URL(url).hostname));
    }

    return await new Promise<OpenedStreamingResponse>((resolve, reject) => {
      multipart?.check();
      const clientRequest = this.runtime.netRequest({ url, method: request.method, session: requestSession,
        useSessionCookies: request.settings.cookiesEnabled !== false, redirect: 'manual' });
      const operationSignal = multipart?.signal ?? signal;
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
            if (!multipart && !isAbortInducedError(abortError)) failure = abortError instanceof Error ? abortError : new Error(String(abortError));
          }
        }
        reject(failure);
      };
      const protectedOrigin = redirectProtection ? new URL(url).origin : undefined;
      const onRedirect = (statusCode: number, _method: string, redirectUrl: string) => {
        if (protectedOrigin && redirectProtection) {
          let nextOrigin = '';
          try { nextOrigin = new URL(redirectUrl, finalUrl).origin; } catch { nextOrigin = ''; }
          if (!nextOrigin || (new URL(finalUrl).protocol === 'https:' && new URL(redirectUrl, finalUrl).protocol !== 'https:') || nextOrigin !== protectedOrigin) { failBeforeHeaders(new Error(blockedRedirectMessage(redirectProtection, redirectUrl)), true); return; }
        }
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
        try { multipart?.headersReceived(); } catch (error) { failBeforeHeaders(error as Error, true); return; }
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
          setCookieLines: getNetSetCookieLines(response.headers),
          receivedAt: this.runtime.clock.wallNow(),
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
      const onAbortBeforeHeaders = () => failBeforeHeaders(operationSignal?.reason ?? new DOMException('Request cancelled', 'AbortError'), true);

      for (const [key, value] of Object.entries(headers)) clientRequest.setHeader(key, value);
      clientRequest.on('redirect', onRedirect);
      clientRequest.on('login', onLogin);
      clientRequest.on('response', onResponse);
      clientRequest.on('error', onRequestError);
      clientRequest.on('close', onClose);
      operationSignal?.addEventListener('abort', onAbortBeforeHeaders, { once: true });

      if (!multipart && request.settings.timeout > 0) {
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
    if (classification.kind === 'empty' || (totalBytes === 0 && !download)) {
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

  private async buildBody(request: Request, headers: Record<string, string>, multipart?: MultipartOperation): Promise<string | Buffer<ArrayBuffer> | null> {
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
        multipart?.check();
        if (!multipart?.prepared) throw new Error('Multipart preparation missing');
        headers['content-type'] = multipart.prepared.contentType;
        return multipart.prepared.body as Buffer<ArrayBuffer>;
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
        if (key.toLowerCase() === 'set-cookie') {
          for (const line of value) result.push({ key, value: line, enabled: true });
        } else {
          result.push({ key, value: value.join(', '), enabled: true });
        }
      } else if (typeof value === 'string') {
        result.push({ key, value, enabled: true });
      }
    }
    return result;
  }

  private oauthBinding(request: Request, environmentId: string | undefined, config: OAuth2Config): OAuthBindingInput {
    const canonicalEnvironmentId = environmentId ?? this.collectionStore.getActiveEnvironmentId() ?? undefined;
    return { requestId: request.id, requestUrl: request.url, ...(canonicalEnvironmentId ? { environmentId: canonicalEnvironmentId } : {}), config };
  }

  /**
   * Resolves the fields a send uses. When the request uses outputs, they are found by resolving once with a
   * placeholder for every output, then acquired (cache or one fetch of each token request), then resolved for real
   * with the same built-ins.
   */
  private async resolveVariables(
    request: Request,
    environmentId?: string,
    mode: ResolveMode = 'send',
    options: { onSensitive?: () => void; signal?: AbortSignal; emitProgress?: (event: RequestProgressEvent) => void } = {},
  ): Promise<Resolution> {
    const canonicalEnvironmentId = environmentId ?? this.collectionStore.getActiveEnvironmentId() ?? undefined;
    const layers = canonicalEnvironmentId ? await this.collectEnvironmentVariables(canonicalEnvironmentId) : [];
    const builtIns: BuiltInVariableValues = {
      timestamp: this.runtime.clock.wallNow(),
      randomInt: this.runtime.randomInt(),
      uuid: this.runtime.uuid(),
    };
    const operation = mode === 'curl' ? 'curl' : 'send';
    const index = await this.loadOutputIndex();
    const consumed = index.size
      ? this.consumedOutputs(request, layers, builtIns, index, operation, canonicalEnvironmentId)
      : [];
    const producers: ProducerUse[] = [];
    if (consumed.length) {
      if (mode === 'legacy') throw new TokenSourceError('TOKEN_SOURCE_FAILED', `${outputLabel(consumed)} can't be used on this send path.`);
      const own = request.outputs === undefined ? undefined : validateRequestOutputs(request.outputs);
      if (mode === 'token' || (own?.ok && own.outputs.enabled)) {
        throw new TokenSourceError('TOKEN_SOURCE_CHAINED',
          `"${request.name}" provides outputs, so it can't use ${outputLabel(consumed)}. A token request can't use outputs.`);
      }
      const disabled = consumed.find(name => !index.get(name)!.enabled);
      if (disabled) {
        throw new TokenSourceError('TOKEN_SOURCE_MISSING', `${outputLabel([disabled])} comes from a request whose outputs are turned off. Turn them on to send this request.`);
      }
      let announced = false;
      for (const requestId of [...new Set(consumed.map(name => index.get(name)!.requestId))].sort()) {
        const names = consumed.filter(name => index.get(name)!.requestId === requestId);
        const prepared = this.prepareBinding(await this.loadTokenRequest(requestId, names), canonicalEnvironmentId, layers, index);
        const unprovided = names.find(name => !prepared.binding.names.includes(name));
        if (unprovided) throw new TokenSourceError('TOKEN_SOURCE_MISSING', `"${prepared.saved.name}" no longer provides ${outputLabel([unprovided])}.`);
        let acquired = this.outputService.peek(prepared.binding);
        if (!acquired) {
          if (mode === 'curl') {
            throw new TokenSourceError('TOKEN_NOT_FETCHED',
              `${outputLabel(names)} hasn't been fetched for this environment yet. Send "${prepared.saved.name}" or a request that uses it, then copy again.`);
          }
          options.emitProgress?.({ requestId: request.id, phase: 'acquiring-token', receivedBytes: 0, tokenSource: prepared.saved.name });
          announced = true;
          acquired = await this.outputService.acquire(prepared.binding, {
            signal: options.signal ?? new AbortController().signal,
            run: signal => this.runProducer(prepared.saved, canonicalEnvironmentId, signal),
          });
        }
        producers.push({ ...prepared, acquired, names });
      }
      if (announced) options.emitProgress?.({ requestId: request.id, phase: 'waiting-headers', receivedBytes: 0 });
    }
    const resolveNow = (onSensitive?: () => void) => {
      const values = new Map<string, string>();
      for (const producer of producers) for (const [name, value] of Object.entries(producer.acquired.values)) values.set(name, value);
      const outputLayer = buildOutputLayer(index.keys(), name => values.get(name) ?? OUTPUT_PLACEHOLDER);
      return this.resolveFields(request, layers, builtIns, outputLayer, operation, canonicalEnvironmentId, onSensitive);
    };
    return { request: resolveNow(options.onSensitive), producers, again: () => resolveNow(), environmentId: canonicalEnvironmentId, layers, index };
  }

  private resolveFields(
    request: Request,
    layers: readonly VariableLayer[],
    builtIns: BuiltInVariableValues,
    outputLayer: VariableLayer,
    operation: 'send' | 'curl',
    environmentId: string | undefined,
    onSensitive?: () => void,
    onKeys?: (keys: readonly string[]) => void,
  ): Request {
    const context = createVariableContext([], builtIns, new Set(), [...layers, outputLayer]);
    const oauth = request.auth.type === 'oauth2' ? request.auth.oauth2 : undefined;
    if (oauth && isBrowserOAuth(oauth) && oauthIdentityValues(oauth, request.url).some(value => containsNondeterministicOAuthReference(value, context))) {
      const error = new Error('Browser OAuth identity fields cannot use timestamp, randomInt, or uuid.') as Error & { code: string };
      error.code = 'OAUTH_INVALID_CONFIG';
      throw error;
    }
    let observed = onSensitive ? observeSensitivity(context, onSensitive) : context;
    if (onKeys) observed = observeDependencies(observed, onKeys);
    return resolveRequestFields(request, observed, { operation, hasOAuthToken: config => {
      return !!this.oauthService.getCachedAccessToken(this.oauthBinding(request, environmentId, config));
    } });
  }

  /** Output names the fields a send uses depend on, found by resolving with a placeholder for every output. */
  private consumedOutputs(
    request: Request,
    layers: readonly VariableLayer[],
    builtIns: BuiltInVariableValues,
    index: ReadonlyMap<string, OutputIndexEntry>,
    operation: 'send' | 'curl',
    environmentId: string | undefined,
  ): string[] {
    const used = new Set<string>();
    const placeholders = buildOutputLayer(index.keys(), () => OUTPUT_PLACEHOLDER);
    this.resolveFields(request, layers, builtIns, placeholders, operation, environmentId, undefined, keys => {
      for (const key of keys) if (index.has(key)) used.add(key);
    });
    return [...used].sort();
  }

  private async loadOutputIndex(): Promise<ReadonlyMap<string, OutputIndexEntry>> {
    // Tests and older callers may hand the engine a partial store.
    const store = this.collectionStore as Partial<CollectionStore>;
    return typeof store.getOutputIndex === 'function' ? await store.getOutputIndex.call(this.collectionStore) : new Map();
  }

  private async loadTokenRequest(requestId: Id, names: readonly string[]): Promise<Request> {
    const store = this.collectionStore as Partial<CollectionStore>;
    const saved = typeof store.getRequest === 'function' ? await store.getRequest.call(this.collectionStore, requestId) : null;
    if (!saved) throw new TokenSourceError('TOKEN_SOURCE_MISSING', `The request that provides ${outputLabel(names)} no longer exists.`);
    return saved;
  }

  /**
   * How a token request is bound right now: its validated outputs and a fingerprint of it as saved and as resolved
   * with fixed built-ins. Refuses a token request that uses outputs. Reads files, never the network.
   */
  private prepareBinding(
    tokenRequest: Request,
    environmentId: string | undefined,
    layers: readonly VariableLayer[],
    index: ReadonlyMap<string, OutputIndexEntry>,
  ): { saved: Request; binding: OutputBinding } {
    const checked = validateRequestOutputs(tokenRequest.outputs);
    if (!checked.ok) throw new TokenSourceError('TOKEN_SOURCE_INVALID', `Outputs on "${tokenRequest.name}" are not valid: ${checked.message}`);
    if (!checked.outputs.enabled) throw new TokenSourceError('TOKEN_SOURCE_MISSING', `Outputs on "${tokenRequest.name}" are turned off.`);
    const saved = { ...tokenRequest, outputs: checked.outputs };
    const used = new Set<string>();
    const resolved = this.resolveFields(saved, layers, FINGERPRINT_BUILT_INS, buildOutputLayer(index.keys(), () => OUTPUT_PLACEHOLDER),
      'send', environmentId, undefined, keys => { for (const key of keys) if (index.has(key)) used.add(key); });
    if (used.size) {
      throw new TokenSourceError('TOKEN_SOURCE_CHAINED',
        `"${saved.name}" provides outputs, so it can't use ${outputLabel([...used].sort())}. A token request can't use outputs.`);
    }
    return {
      saved,
      binding: {
        requestId: saved.id,
        environmentId,
        fingerprint: computeProducerFingerprint({ saved, resolved, environmentId }),
        names: checked.outputs.values.map(value => value.name),
        refreshAfterSeconds: checked.outputs.refreshAfterSeconds,
      },
    };
  }

  /** Runs a saved token request through the same engine core as a send, and takes its outputs from the response. */
  private async runProducer(saved: Request, environmentId: string | undefined, signal: AbortSignal): Promise<ProducerResult> {
    const outputs = saved.outputs!;
    const label = outputLabel(outputs.values.map(value => value.name));
    let response: ResponseV2;
    try {
      response = await this.executeInternal(saved, environmentId, {
        signal,
        purpose: 'token',
        protectCredentialsOnRedirect: saved.auth.type === 'oauth2' ? 'oauth' : false,
      });
    } catch (error) {
      // A cancel stays a cancel, and never carries the token request's failure (or its URL) to the send.
      if (signal.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError');
      const requestError = error instanceof RequestFailureError ? error.requestError : classifyRequestFailure(error, '');
      if (requestError.code === 'TOKEN_SOURCE_NOT_TEXT') {
        throw new TokenSourceError('TOKEN_SOURCE_NOT_TEXT', `Couldn't get ${label}: "${saved.name}" returned a file download instead of text.`);
      }
      if (requestError.code?.startsWith('TOKEN_')) throw new TokenSourceError(requestError.code as TokenErrorCode, requestError.message);
      throw new TokenSourceError('TOKEN_SOURCE_FAILED', `Couldn't get ${label}: "${saved.name}" failed. ${requestError.message}.`);
    }
    const preview = response.preview;
    const bodyText = preview.kind === 'text' && !preview.truncated && !preview.decodeError ? preview.text : null;
    const extracted = extractOutputValues({ status: response.status, headers: response.headers, bodyText }, outputs, saved.name);
    if (!extracted.ok) throw new TokenSourceError(extracted.code, extracted.message);
    return extracted.expiresInSeconds === undefined
      ? { values: extracted.values }
      : { values: extracted.values, expiresInSeconds: extracted.expiresInSeconds };
  }

  /**
   * Token requests worth one more try after a 401: their value came from the cache this time (a value fetched for this
   * very send that still gets 401 is the answer, not a stale token) and they allow it. NTLM uses 401 for its own handshake.
   */
  private outputsToRefreshAfter(status: number, request: Request, producers: readonly ProducerUse[]): ProducerUse[] {
    if (status !== 401 || request.auth.type === 'ntlm') return [];
    return producers.filter(producer => producer.acquired.fromCache && producer.saved.outputs?.resendOn401 === true);
  }

  /**
   * Sending a request that provides outputs yourself fills the cache, bound to the request exactly as it was sent.
   * Its outputs arrive from the window, so they are checked first; anything unusable leaves it an ordinary send.
   */
  private seedFromManualSend(request: Request, resolution: Resolution, response: ResponseV2): ResponseOutputsNoteV2 | undefined {
    if (request.outputs === undefined) return undefined;
    const checked = validateRequestOutputs(request.outputs);
    if (!checked.ok || !checked.outputs.enabled) return undefined;
    try {
      const prepared = this.prepareBinding(request, resolution.environmentId, resolution.layers, resolution.index);
      const preview = response.preview;
      const bodyText = preview.kind === 'text' && !preview.truncated && !preview.decodeError ? preview.text : null;
      const extracted = extractOutputValues({ status: response.status, headers: response.headers, bodyText }, checked.outputs, request.name);
      if (!extracted.ok) return { kind: 'not-updated', message: extracted.message };
      this.outputService.seed(prepared.binding, extracted.expiresInSeconds === undefined
        ? { values: extracted.values }
        : { values: extracted.values, expiresInSeconds: extracted.expiresInSeconds });
      return { kind: 'updated', names: Object.keys(extracted.values) };
    } catch (error) {
      return { kind: 'not-updated', message: error instanceof Error ? error.message : 'Outputs were not updated.' };
    }
  }

  /** What the Outputs tab shows for a request: metadata only, never values. Reads files, never the network. */
  async getOutputStatus(requestId: Id, environmentId?: Id): Promise<RequestOutputStatus> {
    const canonicalEnvironmentId = environmentId ?? this.collectionStore.getActiveEnvironmentId() ?? undefined;
    const empty: RequestOutputStatus = { requestId, environmentId: canonicalEnvironmentId ?? '', state: 'empty', names: [] };
    const store = this.collectionStore as Partial<CollectionStore>;
    const saved = typeof store.getRequest === 'function' ? await store.getRequest.call(this.collectionStore, requestId) : null;
    if (!saved?.outputs?.enabled) return empty;
    try {
      const layers = canonicalEnvironmentId ? await this.collectEnvironmentVariables(canonicalEnvironmentId) : [];
      return this.outputService.status(this.prepareBinding(saved, canonicalEnvironmentId, layers, await this.loadOutputIndex()).binding);
    } catch (error) {
      return {
        ...empty,
        state: 'failed',
        names: enabledOutputNames(saved),
        error: { code: isTokenSourceError(error) ? error.code : null, message: error instanceof Error ? error.message : 'Outputs are not available.' },
      };
    }
  }

  private async collectEnvironmentVariables(environmentId: string, seen = new Set<string>()): Promise<import('@shared/variableContext').VariableLayer[]> {
    const environment = await this.collectionStore.getEnvironment(environmentId);
    if (!environment || seen.has(environment.id)) return [];
    seen.add(environment.id);
    const parents = environment.parentId ? await this.collectEnvironmentVariables(environment.parentId, seen) : [];
    return [...parents, environment.variables];
  }

  private createRequestSignal(timeout: number, parentSignal: AbortSignal | undefined): { signal: AbortSignal | undefined; dispose: () => void } {
    if (!timeout) {
      return { signal: parentSignal, dispose: () => {} };
    }

    const controller = new AbortController();
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
