import type { Page } from '@playwright/test';
import type { RendererApi, RequestOperationPayload } from '../../../src/preload';
import type {
  AppSettings,
  CollectionExportFileResult,
  CollectionImportFileResult,
  CurlExportResult,
  Environment,
  IpcRequestPayload,
  HistoryEntry,
  HttpMethod,
  Request,
  RequestGroup,
  ResponseFileActionPayload,
  ResponseOpenExternalResult,
  ResponseOperationProgressV2,
  ResponseOperationResultV2,
  ResponseSaveAsResult,
  ResponseTiming,
  ResponseV2,
  UpdateStatus,
} from '../../../src/shared/types';

/** Real requests carry no `type` and no `children`: CollectionStore.listAll() only normalizes groups. */
export type MockRequest = Request;

export type MockRequestGroup = RequestGroup & { type: 'group' };
export type MockCollectionNode = MockRequest | MockRequestGroup;

export interface MockResponseRoute {
  match: {
    urlIncludes?: string;
    method?: HttpMethod;
    allowInsecureCertificates?: boolean;
  };
  result: ResponseOperationResultV2;
}

export type MockApiConfig = {
  nodes?: MockCollectionNode[];
  environments?: Environment[];
  responses?: ResponseOperationResultV2[];
  responseRoutes?: MockResponseRoute[];
  defaultResponse?: ResponseOperationResultV2;
  sendMode?: 'immediate' | 'pending';
  persistCollection?: boolean;
  historyEntries?: HistoryEntry[];
  historyDetails?: Record<string, Record<string, unknown> | null>;
  settings?: Partial<AppSettings>;
  importedRequest?: Request;
  saveAsResult?: ResponseSaveAsResult;
  openExternalResult?: ResponseOpenExternalResult;
  curlExportResult?: CurlExportResult;
  exportFileResult?: CollectionExportFileResult;
  importFileResult?: CollectionImportFileResult;
  /** Nodes added to the collection when the mocked import succeeds. */
  importFileNodes?: MockCollectionNode[];
  /** Environments added when the mocked import succeeds. */
  importFileEnvironments?: Environment[];
  updateStatus?: UpdateStatus;
  updateCheckResult?: UpdateStatus;
  updateApplyResult?: UpdateStatus;
};

export interface MockApiHarness {
  pendingOperations: Map<string, RequestOperationPayload>;
  progressListeners: Set<(progress: ResponseOperationProgressV2) => void>;
  cancelledOperations: string[];
  sendAttempts: number;
  createdRequests: MockCollectionNode[];
  saveAsRequests: ResponseFileActionPayload[];
  openExternalRequests: ResponseFileActionPayload[];
  curlExportRequests: IpcRequestPayload[];
  exportFileRequests: (string | undefined)[];
  importFileAttempts: number;
  lastSendRequest?: RequestOperationPayload;
  lastResult?: ResponseOperationResultV2;
  lastCollectionUpdate?: { id: string; payload: unknown };
  collectionCreateAttempts: number;
  collectionUpdateAttempts: number;
  collectionDeleteAttempts: number;
  collectionExportAttempts: number;
  historyGetAttempts: number;
  emitProgress(progress: ResponseOperationProgressV2): void;
  resolveOperation(operationId: string, result?: ResponseOperationResultV2): void;
  rejectOperation(operationId: string, message?: string): void;
  queueResult(result: ResponseOperationResultV2): void;
  updateCheckAttempts: number;
  updateApplyAttempts: number;
}

export type MockWindow = Window & {
  api: RendererApi;
  __mockApi: MockApiHarness;
  __lastSendRequest?: RequestOperationPayload;
  __lastCollectionUpdate?: { id: string; payload: unknown };
  __createdRequests?: MockCollectionNode[];
  __saveAsRequests?: ResponseFileActionPayload[];
  __openExternalRequests?: ResponseFileActionPayload[];
  __envState?: {
    readonly list: Environment[];
    readonly activeId: string | null;
  };
};

const DEFAULT_TIMINGS: ResponseTiming = {
  dns: 0,
  tcp: 0,
  tls: 0,
  ttfb: 1,
  download: 1,
  total: 2,
};

export function bytesFromBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value.replace(/=+$/, '')) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function createMockRequest(
  overrides: Partial<MockRequest> & Pick<MockRequest, 'id' | 'name'>,
): MockRequest {
  const now = 1;
  return {
    id: overrides.id,
    name: overrides.name,
    method: 'GET',
    url: `https://example.test/${overrides.id}`,
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 30_000, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockGroup(
  overrides: Partial<MockRequestGroup> & Pick<MockRequestGroup, 'id' | 'name' | 'children'>,
): MockRequestGroup {
  const now = 1;
  return {
    id: overrides.id,
    type: 'group',
    name: overrides.name,
    children: overrides.children,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createTextResponse(options: {
  id?: string;
  requestId?: string;
  status?: number;
  statusText?: string;
  text?: string;
  format?: 'json' | 'xml' | 'html' | 'svg' | 'text';
  parseState?: 'not-applicable' | 'unparsed' | 'valid' | 'invalid' | 'over-budget';
  charset?: string;
  decodeError?: boolean;
  capturedBytes?: number;
  totalBytes?: number;
  truncated?: boolean;
  completeness?: 'complete' | 'truncated' | 'unknown';
  headers?: ResponseV2['headers'];
  cookies?: ResponseV2['cookies'];
  timings?: ResponseTiming;
  timestamp?: number;
  size?: number;
} = {}): ResponseV2 {
  const text = options.text ?? '{}';
  const format = options.format ?? 'text';
  const byteLength = new TextEncoder().encode(text).byteLength;
  return {
    version: 2,
    id: options.id ?? 'response-fixture',
    requestId: options.requestId ?? 'request-fixture',
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers: options.headers ?? [{ key: 'content-type', value: 'text/plain', enabled: true }],
    preview: {
      kind: 'text',
      format,
      text,
      parseState: options.parseState ?? (format === 'json' ? 'valid' : 'not-applicable'),
      charset: options.charset ?? 'utf-8',
      decodeError: options.decodeError ?? false,
      capturedBytes: options.capturedBytes ?? byteLength,
      totalBytes: options.totalBytes ?? byteLength,
      truncated: options.truncated ?? false,
      completeness: options.completeness ?? 'complete',
    },
    timings: options.timings ?? DEFAULT_TIMINGS,
    timestamp: options.timestamp ?? 1,
    size: options.size ?? options.totalBytes ?? byteLength,
    cookies: options.cookies ?? [],
  };
}

export function createImageResponse(options: {
  id?: string;
  requestId?: string;
  mediaType?: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  totalBytes?: number;
  truncated?: boolean;
  download?: ResponseV2['download'];
}): ResponseV2 {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  return {
    version: 2,
    id: options.id ?? 'image-response-fixture',
    requestId: options.requestId ?? 'request-fixture',
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'content-type', value: options.mediaType ?? 'image/png', enabled: true }],
    preview: {
      kind: 'image',
      mediaType: options.mediaType ?? 'image/png',
      bytes: options.bytes,
      dimensions: { width, height, pixels: width * height, validated: true },
      capturedBytes: options.bytes.byteLength,
      totalBytes: options.totalBytes ?? options.bytes.byteLength,
      truncated: options.truncated ?? false,
    },
    timings: DEFAULT_TIMINGS,
    timestamp: 1,
    size: options.totalBytes ?? options.bytes.byteLength,
    cookies: [],
    ...(options.download ? { download: options.download } : {}),
  };
}

export function createDownloadResponse(options: {
  id?: string;
  requestId?: string;
  mediaType?: string | null;
  state: 'awaiting-destination' | 'downloading' | 'publishing' | 'saved' | 'cancelled' | 'failed';
  reason: 'attachment' | 'binary' | 'unsupported-media-type' | 'preview-limit' | 'invalid-image';
  receivedBytes: number;
  suggestedFileName?: string;
  failure?: { code: string | null; message: string };
}): ResponseV2 {
  const download = {
    state: options.state,
    reason: options.reason,
    mediaType: options.mediaType ?? null,
    receivedBytes: options.receivedBytes,
    ...(options.suggestedFileName ? { suggestedFileName: options.suggestedFileName } : {}),
    ...(options.failure ? { failure: options.failure } : {}),
  } as NonNullable<ResponseV2['download']>;
  return {
    version: 2,
    id: options.id ?? 'download-response-fixture',
    requestId: options.requestId ?? 'request-fixture',
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'content-type', value: options.mediaType ?? 'application/octet-stream', enabled: true }],
    preview: {
      kind: 'download-only',
      mediaType: options.mediaType ?? null,
      capturedBytes: 0,
      totalBytes: options.receivedBytes,
      truncated: options.receivedBytes > 0,
      download,
    },
    timings: DEFAULT_TIMINGS,
    timestamp: 1,
    size: options.receivedBytes,
    cookies: [],
    download,
  };
}

export function createResponseResult(response: ResponseV2, kind: 'response' | 'download' = 'response'): ResponseOperationResultV2 {
  if (kind === 'download') {
    if (!response.download) throw new Error('Download results require response.download metadata');
    return { version: 2, operationId: 'fixture-operation', kind, response, download: response.download };
  }
  return { version: 2, operationId: 'fixture-operation', kind, response };
}

export function createFailedResult(options: {
  kind?: 'transport' | 'certificate' | 'timeout' | 'cancelled';
  code?: string | null;
  message?: string;
  retryable?: boolean;
} = {}): ResponseOperationResultV2 {
  return {
    version: 2,
    operationId: 'fixture-operation',
    kind: 'failed',
    error: {
      kind: options.kind ?? 'transport',
      code: options.code ?? null,
      message: options.message ?? 'Mock request failed',
      retryable: options.retryable ?? true,
    },
  };
}

export function createCancelledResult(): ResponseOperationResultV2 {
  return { version: 2, operationId: 'fixture-operation', kind: 'cancelled' };
}

export function createBusyResult(): ResponseOperationResultV2 {
  return { version: 2, operationId: 'fixture-operation', kind: 'busy' };
}

export async function installMockApi(page: Page, config: MockApiConfig = {}): Promise<void> {
  await page.addInitScript((fixtureConfig: MockApiConfig) => {
    type BrowserWindow = Window & {
      api: RendererApi;
      __mockApi: MockApiHarness;
      __lastSendRequest?: RequestOperationPayload;
      __lastCollectionUpdate?: { id: string; payload: unknown };
      __createdRequests?: MockCollectionNode[];
      __saveAsRequests?: ResponseFileActionPayload[];
      __openExternalRequests?: ResponseFileActionPayload[];
      __envState?: { readonly list: Environment[]; readonly activeId: string | null };
    };

    type PendingOperation = {
      payload: RequestOperationPayload;
      resolve: (result: ResponseOperationResultV2) => void;
      reject: (error: Error) => void;
    };

    const clone = <T,>(value: T): T => structuredClone(value);
    const reviveBytes = (value: unknown): Uint8Array => {
      if (value instanceof Uint8Array) return value;
      if (Array.isArray(value)) return Uint8Array.from(value.map((entry) => (typeof entry === 'number' ? entry : 0)));
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.data)) return Uint8Array.from(record.data.map((entry) => (typeof entry === 'number' ? entry : 0)));
        const indices = Object.keys(record).filter((key) => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right));
        if (indices.length > 0) return Uint8Array.from(indices.map((key) => (typeof record[key] === 'number' ? record[key] as number : 0)));
      }
      return new Uint8Array();
    };
    const reviveResponse = (result: ResponseOperationResultV2): ResponseOperationResultV2 => {
      const next = clone(result);
      if ('response' in next && next.response.preview.kind === 'image') {
        next.response.preview = {
          ...next.response.preview,
          bytes: reviveBytes(next.response.preview.bytes),
        };
      }
      return next;
    };
    const responseRoutes = fixtureConfig.responseRoutes?.map((route) => ({ ...route, result: reviveResponse(route.result) }));
    const defaultResponse = fixtureConfig.defaultResponse ? reviveResponse(fixtureConfig.defaultResponse) : undefined;
    const configuredNodes = fixtureConfig.nodes ?? [];
    const persistedNodes = fixtureConfig.persistCollection
      ? (() => {
          try {
            const raw = window.localStorage.getItem('restiprocity:mock-collection-nodes');
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            return Array.isArray(parsed) ? parsed as MockCollectionNode[] : configuredNodes;
          } catch {
            return configuredNodes;
          }
        })()
      : configuredNodes;
    const initialEnvironments = clone(fixtureConfig.environments ?? []);
    const defaultSettings: AppSettings = {
      ...(initialEnvironments.some((environment) => environment.id === 'core') ? { activeEnvironmentId: 'core' } : {}),
      theme: 'dark',
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      defaultTimeout: 30_000,
      defaultFollowRedirect: true,
      autoSaveHistory: true,
      maxHistorySize: 1000,
      ...clone(fixtureConfig.settings ?? {}),
    };
    const state = {
      nodes: clone(persistedNodes),
      environments: initialEnvironments,
      activeEnvironmentId: defaultSettings.activeEnvironmentId ?? null,
      responseQueue: clone(fixtureConfig.responses ?? []).map((result) => reviveResponse(result)),
      pendingOperations: new Map<string, PendingOperation>(),
      progressListeners: new Set<(progress: ResponseOperationProgressV2) => void>(),
      consoleListeners: new Set<(message: string) => void>(),
      cancelledOperations: [] as string[],
      createdRequests: [] as MockCollectionNode[],
      historyEntries: clone(fixtureConfig.historyEntries ?? []),
      historyDetails: clone(fixtureConfig.historyDetails ?? {}),
      settings: defaultSettings,
      updateStatus: clone(fixtureConfig.updateStatus ?? { kind: 'unsupported', currentVersion: '0.2.2' } as UpdateStatus),
      updateCheckResult: clone(fixtureConfig.updateCheckResult ?? fixtureConfig.updateStatus ?? { kind: 'unsupported', currentVersion: '0.2.2' } as UpdateStatus),
      updateApplyResult: clone(fixtureConfig.updateApplyResult ?? fixtureConfig.updateStatus ?? { kind: 'unsupported', currentVersion: '0.2.2' } as UpdateStatus),
      lastSendRequest: undefined as RequestOperationPayload | undefined,
      lastCollectionUpdate: undefined as { id: string; payload: unknown } | undefined,
      collectionCreateAttempts: 0,
      collectionUpdateAttempts: 0,
      collectionDeleteAttempts: 0,
      collectionExportAttempts: 0,
      historyGetAttempts: 0,
      saveAsRequests: [] as ResponseFileActionPayload[],
      openExternalRequests: [] as ResponseFileActionPayload[],
      curlExportRequests: [] as IpcRequestPayload[],
      exportFileRequests: [] as (string | undefined)[],
    };

    const fallbackRequest = (): Request => ({
      id: 'clipboard-request',
      name: 'Clipboard Request',
      method: 'GET',
      url: 'https://example.test/clipboard',
      headers: [],
      parameters: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      settings: { followRedirect: true, timeout: 30_000, cookiesEnabled: true },
      scripts: {},
      createdAt: 1,
      updatedAt: 1,
    });

    const fallbackResult = (payload: RequestOperationPayload): ResponseOperationResultV2 => createFallbackResult(payload);

    function createFallbackResult(payload: RequestOperationPayload): ResponseOperationResultV2 {
      const text = '{}';
      const response: ResponseV2 = {
        version: 2,
        id: `response-${payload.request.id}`,
        requestId: payload.request.id,
        status: 200,
        statusText: 'OK',
        headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
        preview: {
          kind: 'text',
          format: 'json',
          text,
          parseState: 'valid',
          charset: 'utf-8',
          decodeError: false,
          capturedBytes: 2,
          totalBytes: 2,
          truncated: false,
          completeness: 'complete',
        },
        timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 1, total: 2 },
        timestamp: Date.now(),
        size: 2,
        cookies: [],
      };
      return { version: 2, operationId: payload.operationId, kind: 'response', response };
    }

    function withOperationId(result: ResponseOperationResultV2, operationId: string): ResponseOperationResultV2 {
      return { ...clone(result), operationId };
    }

    function routeMatches(route: MockResponseRoute, payload: RequestOperationPayload): boolean {
      const { match } = route;
      if (match.urlIncludes && !payload.request.url.includes(match.urlIncludes)) return false;
      if (match.method && payload.request.method !== match.method) return false;
      if (
        match.allowInsecureCertificates !== undefined
        && payload.request.settings.allowInsecureCertificates !== match.allowInsecureCertificates
      ) return false;
      return true;
    }

    function nextResult(payload: RequestOperationPayload): ResponseOperationResultV2 {
      const route = responseRoutes?.find((candidate) => routeMatches(candidate, payload));
      const template = route?.result ?? state.responseQueue.shift() ?? defaultResponse;
      return withOperationId(template ?? fallbackResult(payload), payload.operationId);
    }

    function persistCollectionNodes(): void {
      if (!fixtureConfig.persistCollection) return;
      window.localStorage.setItem('restiprocity:mock-collection-nodes', JSON.stringify(state.nodes));
    }

    function asRecord(value: unknown): Record<string, unknown> {
      return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    }

    // Defined here because this function body is serialized into the page. Only groups carry a `type`.
    function isMockGroup(node: MockCollectionNode | undefined): node is MockRequestGroup {
      return (node as { type?: unknown } | undefined)?.type === 'group';
    }

    const harness: MockApiHarness = {
      pendingOperations: new Map<string, RequestOperationPayload>(),
      progressListeners: new Set<(progress: ResponseOperationProgressV2) => void>(),
      cancelledOperations: state.cancelledOperations,
      sendAttempts: 0,
      createdRequests: state.createdRequests,
      saveAsRequests: state.saveAsRequests,
      openExternalRequests: state.openExternalRequests,
      curlExportRequests: state.curlExportRequests,
      exportFileRequests: state.exportFileRequests,
      importFileAttempts: 0,
      emitProgress: (progress) => {
        for (const listener of [...state.progressListeners]) listener(progress);
      },
      resolveOperation: (operationId, result) => {
        const pending = state.pendingOperations.get(operationId);
        if (!pending) return;
        state.pendingOperations.delete(operationId);
        harness.pendingOperations.delete(operationId);
        const resolved = withOperationId(result ?? nextResult(pending.payload), operationId);
        harness.lastResult = resolved;
        pending.resolve(resolved);
      },
      rejectOperation: (operationId, message = 'Mock operation failed') => {
        const pending = state.pendingOperations.get(operationId);
        if (!pending) return;
        state.pendingOperations.delete(operationId);
        harness.pendingOperations.delete(operationId);
        pending.reject(new Error(message));
      },
      queueResult: (result) => {
        state.responseQueue.push(clone(result));
      },
      collectionCreateAttempts: 0,
      collectionUpdateAttempts: 0,
      collectionDeleteAttempts: 0,
      collectionExportAttempts: 0,
      historyGetAttempts: 0,
      updateCheckAttempts: 0,
      updateApplyAttempts: 0,
    };

    const api: RendererApi = {
      sendRequest: async (payload) => {
        harness.sendAttempts += 1;
        state.lastSendRequest = clone(payload);
        browserWindow.__lastSendRequest = clone(payload);
        if (fixtureConfig.sendMode === 'pending') {
          return await new Promise<ResponseOperationResultV2>((resolve, reject) => {
            state.pendingOperations.set(payload.operationId, { payload: clone(payload), resolve, reject });
            harness.pendingOperations.set(payload.operationId, clone(payload));
          });
        }
        const result = nextResult(payload);
        harness.lastResult = result;
        return result;
      },
      updateCheck: async () => {
        harness.updateCheckAttempts += 1;
        state.updateStatus = clone(state.updateCheckResult);
        return clone(state.updateStatus);
      },
      updateApply: async () => {
        harness.updateApplyAttempts += 1;
        state.updateStatus = clone(state.updateApplyResult);
        return clone(state.updateStatus);
      },
      onUpdateStatus: (listener) => {
        listener(clone(state.updateStatus));
        return () => {};
      },
      cancelRequest: async (operationId) => {
        state.cancelledOperations.push(operationId);
        const pending = state.pendingOperations.get(operationId);
        if (pending) {
          state.pendingOperations.delete(operationId);
          harness.pendingOperations.delete(operationId);
          pending.resolve({ version: 2, operationId, kind: 'cancelled' });
        }
        return { version: 2, operationId, kind: 'cancelled' };
      },
      onRequestProgress: (listener) => {
        state.progressListeners.add(listener);
        harness.progressListeners.add(listener);
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          state.progressListeners.delete(listener);
          harness.progressListeners.delete(listener);
        };
      },
      importCurlFromClipboard: async () => clone(fixtureConfig.importedRequest ?? fallbackRequest()),
      saveResponseAs: async (payload) => {
        const cloned = clone(payload);
        state.saveAsRequests.push(cloned);
        browserWindow.__saveAsRequests = state.saveAsRequests;
        return clone(fixtureConfig.saveAsResult ?? { saved: true, path: 'C:\\mock\\response.txt' });
      },
      openResponseExternally: async (payload) => {
        const cloned = clone(payload);
        state.openExternalRequests.push(cloned);
        browserWindow.__openExternalRequests = state.openExternalRequests;
        return clone(fixtureConfig.openExternalResult ?? { opened: true, editor: 'notepad++' });
      },
      copyRequestAsCurl: async (payload) => {
        state.curlExportRequests.push(clone(payload));
        return clone(fixtureConfig.curlExportResult ?? { copied: true, command: `curl '${payload.request.url}'`, warnings: [] });
      },
      exportCollectionFile: async (id) => {
        state.exportFileRequests.push(id);
        return clone(fixtureConfig.exportFileResult ?? { saved: true, path: 'C:\\mock\\collection.restiprocity.json', requests: 1, groups: 0 });
      },
      importCollectionFile: async () => {
        harness.importFileAttempts += 1;
        const result = clone(fixtureConfig.importFileResult ?? { imported: true, requests: 0, groups: 0, environments: 0, warnings: [] });
        if (result.imported) {
          state.nodes.push(...clone(fixtureConfig.importFileNodes ?? []));
          state.environments.push(...clone(fixtureConfig.importFileEnvironments ?? []));
        }
        return result;
      },
      collectionList: async () => ({ nodes: clone(state.nodes) }),
      collectionCreate: async (data) => {
        harness.collectionCreateAttempts += 1;
        const candidate = asRecord(data);
        const isGroup = candidate.type === 'group' || candidate.nodeType === 'group';
        const created = {
          ...candidate,
          id: typeof candidate.id === 'string' ? candidate.id : `request-${Date.now()}`,
          ...(isGroup ? { type: 'group' } : {}),
          createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
        } as MockCollectionNode;
        // The real store persists requests without a `type`; only groups are normalized with one.
        if (!isGroup) delete (created as { type?: unknown }).type;
        state.nodes.push(created);
        if (!isMockGroup(created)) state.createdRequests.push(created);
        return clone(created);
      },
      collectionUpdate: async (id, data) => {
        harness.collectionUpdateAttempts += 1;
        const index = state.nodes.findIndex((node) => node.id === id);
        const existing = index >= 0 ? state.nodes[index] : undefined;
        const updated = {
          ...(existing ?? { id, name: id }),
          ...asRecord(data),
          updatedAt: Date.now(),
        } as MockCollectionNode;
        // A request never gains a `type`; a group keeps the one it was listed with.
        if (isMockGroup(existing)) (updated as MockRequestGroup).type = 'group';
        else delete (updated as { type?: unknown }).type;
        if (index >= 0) state.nodes[index] = updated;
        else state.nodes.push(updated);
        persistCollectionNodes();
        state.lastCollectionUpdate = { id, payload: clone(data) };
        browserWindow.__lastCollectionUpdate = clone(state.lastCollectionUpdate);
        return clone(updated);
      },
      collectionDelete: async (id) => {
        harness.collectionDeleteAttempts += 1;
        state.nodes = state.nodes.filter((node) => node.id !== id);
        persistCollectionNodes();
        return null;
      },
      collectionDuplicate: async (id) => {
        const original = state.nodes.find((node) => node.id === id);
        if (!original || isMockGroup(original)) return null;
        const copy = {
          ...clone(original),
          id: `request-copy-${Date.now()}`,
          name: `${original.name} (copy)`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as MockRequest;
        state.nodes.push(copy);
        return clone(copy);
      },
      collectionMoveRequest: async (data) => {
        const payload = asRecord(data);
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const targetParentId = typeof payload.targetParentId === 'string' ? payload.targetParentId : '';
        const targetIndex = typeof payload.targetIndex === 'number' ? payload.targetIndex : 0;
        const request = state.nodes.find((node): node is MockRequest => !isMockGroup(node) && node.id === requestId);
        const targetParent = state.nodes.find((node): node is MockRequestGroup => isMockGroup(node) && node.id === targetParentId);
        if (!request || !targetParent) return null;
        if (request.parentId === targetParentId) return null;

        const sourceParent = request.parentId
          ? state.nodes.find((node): node is MockRequestGroup => isMockGroup(node) && node.id === request.parentId)
          : undefined;

        if (sourceParent) {
          sourceParent.children = sourceParent.children.filter((childId) => childId !== request.id);
        }

        const nextChildren = [...targetParent.children];
        const clampedIndex = Math.min(Math.max(Math.trunc(targetIndex), 0), nextChildren.length);
        nextChildren.splice(clampedIndex, 0, request.id);
        targetParent.children = nextChildren;
        request.parentId = targetParentId;
        state.lastCollectionUpdate = { id: requestId, payload: clone(data) };
        browserWindow.__lastCollectionUpdate = clone(state.lastCollectionUpdate);
        return clone(request);
      },
      collectionReorder: async (data) => {
        const payload = asRecord(data);
        const parentId = typeof payload.parentId === 'string' ? payload.parentId : undefined;
        const children = Array.isArray(payload.children) ? payload.children.filter((id): id is string => typeof id === 'string') : [];
        const parent = state.nodes.find((node): node is MockRequestGroup => isMockGroup(node) && node.id === parentId);
        if (parent) parent.children = [...children];
        return null;
      },
      collectionExport: async (id) => {
        harness.collectionExportAttempts += 1;
        return clone(state.nodes.find((node) => node.id === id) ?? null);
      },
      collectionImport: async (data) => api.collectionCreate(data),
      // The main process never sends collection:changed, so the mock never fires it either.
      onCollectionChanged: () => {},
      envList: async () => clone(state.environments),
      envCreate: async (data) => {
        const candidate = asRecord(data);
        const environment = {
          id: `env-${String(candidate.name ?? 'new').toLowerCase().replace(/\s+/g, '-')}`,
          name: String(candidate.name ?? 'New Environment'),
          parentId: typeof candidate.parentId === 'string' ? candidate.parentId : state.activeEnvironmentId ?? 'core',
          variables: Array.isArray(candidate.variables) ? candidate.variables : [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as Environment;
        state.environments.push(environment);
        return clone(environment);
      },
      envUpdate: async (id, data) => {
        const index = state.environments.findIndex((environment) => environment.id === id);
        if (index < 0) return null;
        state.environments[index] = { ...state.environments[index], ...asRecord(data), updatedAt: Date.now() } as Environment;
        return clone(state.environments[index]);
      },
      envDelete: async (id) => {
        if (id === 'core') return state.activeEnvironmentId ?? 'core';
        const environment = state.environments.find((candidate) => candidate.id === id);
        if (!environment) throw new Error('Environment no longer exists. Refresh and retry.');
        const nextActiveId = state.activeEnvironmentId === id
          ? environment.parentId ?? 'core'
          : state.activeEnvironmentId ?? 'core';
        state.environments = state.environments.filter((candidate) => candidate.id !== id);
        state.activeEnvironmentId = nextActiveId;
        return nextActiveId;
      },
      envSwitch: async (id) => {
        const nextActiveId = id ?? 'core';
        if (!state.environments.some((environment) => environment.id === nextActiveId)) {
          throw new Error('Environment no longer exists. Refresh and retry.');
        }
        state.activeEnvironmentId = nextActiveId;
        state.settings = { ...state.settings, activeEnvironmentId: nextActiveId };
        return nextActiveId;
      },
      historyList: async () => clone(state.historyEntries),
      historyGet: async (id) => {
        harness.historyGetAttempts += 1;
        return clone(state.historyDetails[id] ?? null);
      },
      historyClear: async () => {
        state.historyEntries = [];
        state.historyDetails = {};
        return null;
      },
      settingsGet: async () => clone(state.settings),
      settingsSet: async (data) => {
        state.settings = { ...state.settings, ...clone(data) };
        if (state.settings.activeEnvironmentId) state.activeEnvironmentId = state.settings.activeEnvironmentId;
        return state.settings.activeEnvironmentId ?? 'core';
      },
      onConsoleLog: (listener) => {
        state.consoleListeners.add(listener);
      },
    };

    const browserWindow = window as BrowserWindow;
    browserWindow.api = api;
    browserWindow.__mockApi = harness;
    browserWindow.__createdRequests = state.createdRequests;
    browserWindow.__saveAsRequests = state.saveAsRequests;
    browserWindow.__openExternalRequests = state.openExternalRequests;
    Object.defineProperty(browserWindow, '__envState', {
      configurable: true,
      get: () => ({
        get list() { return state.environments; },
        get activeId() { return state.activeEnvironmentId; },
      }),
    });
  }, config);
}
