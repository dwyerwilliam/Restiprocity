import { create } from 'zustand';
import { normalizeResponseSnapshotV2, toPersistedResponseV2, toRendererResponseV2 } from '@shared/responseContracts';
import { Request, ResponseV2, ResponseOperationProgressV2, Environment, HttpMethod, Header, QueryParameter, RequestBody, AuthConfig, AppSettings, HistoryEntry, RequestError, CORE_ENVIRONMENT_ID } from '@shared/types';
import { createId } from '../utils/id';

function normalizeRequestError(error: RequestError | string | Error | null, url = ''): RequestError | null {
  if (!error) {
    return null;
  }

  if (typeof error === 'object' && 'kind' in error && 'rawMessage' in error) {
    return error as RequestError;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);

  return {
    kind: 'transport',
    message: rawMessage,
    rawMessage,
    code: null,
    url,
    retryable: true,
  };
}

function createDraftRequest(): Request {
  const now = Date.now();

  return {
    id: createId(),
    name: 'New Request',
    method: 'GET',
    url: '',
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
  };
}

export type RequestWorkbenchOrigin =
  | { kind: 'collection'; requestId: string }
  | { kind: 'deleted-history'; historyId: string; requestId: string };

export type ResponseSource = 'live' | 'history';

export type HistoryReopenEntry = Pick<HistoryEntry, 'id' | 'requestId' | 'requestName' | 'method' | 'url'>;

const HISTORY_SENSITIVE_QUERY_KEYS = new Set([
  'access_token', 'api_key', 'apikey', 'client_secret', 'key', 'password', 'passwd', 'refresh_token', 'token',
]);

export function sanitizeHistoryUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (HISTORY_SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }

    return url.toString();
  } catch {
    return '';
  }
}

export function createDeletedHistoryRequest(entry: Pick<HistoryEntry, 'id' | 'requestName' | 'method' | 'url'>): {
  request: Request;
  origin: Extract<RequestWorkbenchOrigin, { kind: 'deleted-history' }>;
} {
  const now = Date.now();
  const requestId = createId();

  return {
    request: {
      id: requestId,
      name: entry.requestName || 'Deleted history request',
      method: entry.method,
      url: sanitizeHistoryUrl(entry.url),
      headers: [],
      parameters: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
      scripts: {},
      createdAt: now,
      updatedAt: now,
    },
    origin: { kind: 'deleted-history', historyId: entry.id, requestId },
  };
}

function historyReopenErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';

  return message
    ? `Unable to reopen this history response: ${message} Refresh history and retry.`
    : 'Unable to reopen this history response. Refresh history and retry.';
}

function mergeCurrentRequestWithDraft(request: Request, draft: Request | undefined): Request {
  if (!draft) return request;
  return { ...request, ...draft, id: request.id };
}

function invalidateHistoryReopen(state: { workbenchRevision: number }) {
  return {
    historyReopenPending: false,
    historyReopenError: null,
    historyReopenToken: null,
    workbenchRevision: state.workbenchRevision + 1,
  };
}

const REQUEST_DRAFTS_STORAGE_KEY = 'restiprocity:request-drafts';
let requestDraftCache: Record<string, Request> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersistedResponseV2(value: unknown): value is Record<string, unknown> & { version: 2 } {
  return isRecord(value) && value.version === 2;
}

function hydrateRequestDraft(value: unknown): { request: Request | null; changed: boolean } {
  if (!isRecord(value)) {
    return { request: null, changed: false };
  }

  const request = value as unknown as Request;
  if (value.lastResponse === undefined) {
    return { request, changed: false };
  }

  if (!isPersistedResponseV2(value.lastResponse)) {
    const { lastResponse: _unsupportedLastResponse, ...cleaned } = request;
    return { request: cleaned, changed: true };
  }

  try {
    const snapshot = normalizeResponseSnapshotV2(value.lastResponse);
    return {
      request: {
        ...request,
        lastResponse: snapshot,
      },
      changed: false,
    };
  } catch {
    const { lastResponse: _discardedLastResponse, ...cleaned } = request;
    return { request: cleaned, changed: true };
  }
}

function hydrateRequestDrafts(value: unknown): { drafts: Record<string, Request>; changed: boolean } {
  if (!isRecord(value)) {
    return { drafts: {}, changed: false };
  }

  let changed = false;
  const drafts = Object.fromEntries(
    Object.entries(value).flatMap(([id, draft]) => {
      const hydrated = hydrateRequestDraft(draft);
      changed = changed || hydrated.changed;
      return hydrated.request ? [[id, hydrated.request]] : [];
    }),
  );

  return { drafts, changed };
}

function projectRequestDraft(request: Request): Record<string, unknown> {
  const { lastResponse, ...requestData } = request;
  return lastResponse === undefined
    ? requestData
    : { ...requestData, lastResponse: toPersistedResponseV2(lastResponse) };
}

function loadRequestDrafts(): Record<string, Request> {
  if (Object.keys(requestDraftCache).length > 0) {
    return requestDraftCache;
  }

  try {
    const raw = window.localStorage.getItem(REQUEST_DRAFTS_STORAGE_KEY);
    if (!raw) {
      requestDraftCache = {};
      return requestDraftCache;
    }

    const { drafts, changed } = hydrateRequestDrafts(JSON.parse(raw) as unknown);
    requestDraftCache = drafts;
    if (changed) {
      const persistedDrafts = Object.fromEntries(
        Object.entries(requestDraftCache).map(([id, draft]) => [id, projectRequestDraft(draft)]),
      );
      window.localStorage.setItem(REQUEST_DRAFTS_STORAGE_KEY, JSON.stringify(persistedDrafts));
    }
    return requestDraftCache;
  } catch {
    requestDraftCache = {};
    return requestDraftCache;
  }
}

function saveRequestDrafts(drafts: Record<string, Request>): Record<string, Request> {
  const { drafts: hydratedDrafts } = hydrateRequestDrafts(drafts);
  requestDraftCache = hydratedDrafts;

  try {
    const persistedDrafts = Object.fromEntries(
      Object.entries(hydratedDrafts).map(([id, draft]) => [id, projectRequestDraft(draft)]),
    );
    window.localStorage.setItem(REQUEST_DRAFTS_STORAGE_KEY, JSON.stringify(persistedDrafts));
  } catch {
    return hydratedDrafts;
  }

  return hydratedDrafts;
}

// ─── UI State Store ────────────────────────────────────────────
interface UiState {
  selectedNodeId: string | null;
  activeResponseTab: 'body' | 'headers' | 'timings' | 'cookies';
  activeEditorTab: 'headers' | 'params' | 'body' | 'auth' | 'settings';
  sidebarCollapsed: boolean;
  responsePanelVisible: boolean;

  setSelectedNodeId: (id: string | null) => void;
  setActiveResponseTab: (tab: 'body' | 'headers' | 'timings' | 'cookies') => void;
  setActiveEditorTab: (tab: 'headers' | 'params' | 'body' | 'auth' | 'settings') => void;
  toggleSidebar: () => void;
  toggleResponsePanel: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedNodeId: null,
  activeResponseTab: 'body',
  activeEditorTab: 'headers',
  sidebarCollapsed: false,
  responsePanelVisible: true,

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  setActiveResponseTab: (tab) => set({ activeResponseTab: tab }),
  setActiveEditorTab: (tab) => set({ activeEditorTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleResponsePanel: () => set((s) => ({ responsePanelVisible: !s.responsePanelVisible })),
}));

// ─── Request Editor Store ──────────────────────────────────────
export type RequestFlightPhase =
  | 'preparing'
  | 'waiting-headers'
  | 'receiving'
  | 'awaiting-destination'
  | 'downloading'
  | 'publishing'
  | 'saved'
  | 'cancelled'
  | 'failed';

interface RequestEditorState {
  currentRequest: Request | null;
  currentOrigin: RequestWorkbenchOrigin | null;
  requestDrafts: Record<string, Request>;
  currentResponse: ResponseV2 | null;
  currentResponseSource: ResponseSource | null;
  isSending: boolean;
  sendError: RequestError | null;
  requestStartTime: number | null;
  requestPhase: RequestFlightPhase | null;
  requestProgress: ResponseOperationProgressV2 | null;
  activeOperationId: string | null;
  activeOperationRequestId: string | null;
  workbenchRevision: number;
  historyReopenPending: boolean;
  historyReopenError: string | null;
  historyReopenToken: string | null;

  setCurrentRequest: (request: Request | null, origin?: RequestWorkbenchOrigin) => void;
  setDeletedHistoryRequest: (entry: Pick<HistoryEntry, 'id' | 'requestName' | 'method' | 'url'>) => Request;
  reopenHistory: (entry: HistoryReopenEntry) => Promise<boolean>;
  updateRequest: (updates: Partial<Request>) => void;
  setCurrentResponse: (response: ResponseV2 | null) => void;
  setIsSending: (sending: boolean) => void;
  setSendError: (error: RequestError | string | Error | null, url?: string) => void;
  resetResponse: () => void;
  setRequestStart: () => void;
  setRequestWaitingHeaders: () => void;
  clearRequestFlight: () => void;
  beginRequestOperation: (requestId: string) => string | null;
  cancelRequestOperation: (operationId: string | null) => boolean;
  ownsRequestOperation: (operationId: string, requestId: string) => boolean;
  applyRequestProgress: (progress: ResponseOperationProgressV2) => void;
  finishRequestOperation: (operationId: string, phase: Extract<RequestFlightPhase, 'saved' | 'cancelled' | 'failed'>) => boolean;
}

export const useRequestStore = create<RequestEditorState>((set, get) => ({
  currentRequest: null,
  currentOrigin: null,
  requestDrafts: typeof window !== 'undefined' ? loadRequestDrafts() : {},
  currentResponse: null,
  currentResponseSource: null,
  isSending: false,
  sendError: null,
  requestStartTime: null,
  requestPhase: null,
  requestProgress: null,
  activeOperationId: null,
  activeOperationRequestId: null,
  workbenchRevision: 0,
  historyReopenPending: false,
  historyReopenError: null,
  historyReopenToken: null,

  setCurrentRequest: (request, origin) => set((state) => {
    const outgoing = state.currentRequest;
    const historyReopenState = invalidateHistoryReopen(state);
    const nextOrigin = request
      ? origin ?? (outgoing?.id === request.id ? state.currentOrigin : { kind: 'collection', requestId: request.id })
      : null;
    const operationContinues = Boolean(
      state.activeOperationId
      && request
      && state.activeOperationRequestId === request.id,
    );
    if (state.activeOperationId && !operationContinues && typeof window !== 'undefined') {
      const cancelRequest = window.api?.cancelRequest;
      if (typeof cancelRequest === 'function') void cancelRequest(state.activeOperationId).catch(() => undefined);
    }
    let outgoingDrafts = state.requestDrafts;
    if (outgoing && state.currentOrigin?.kind === 'collection') {
      outgoingDrafts = {
        ...state.requestDrafts,
        [outgoing.id]: outgoing,
      };
      outgoingDrafts = saveRequestDrafts(outgoingDrafts);
    }

    const persistedDrafts = typeof window !== 'undefined' ? loadRequestDrafts() : {};
    const draft = request && nextOrigin?.kind === 'collection'
      ? outgoingDrafts[request.id] ?? persistedDrafts[request.id]
      : null;
    const nextRequest = request && nextOrigin?.kind === 'deleted-history'
      ? {
          id: nextOrigin.requestId,
          name: request.name,
          method: request.method,
          url: sanitizeHistoryUrl(request.url),
          headers: [],
          parameters: [],
          body: { type: 'none' as const },
          auth: { type: 'none' as const },
          settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
          scripts: {},
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
        }
      : request && draft?.lastResponse
        ? { ...request, lastResponse: draft.lastResponse }
        : request ?? draft;
    const restoredSnapshot = draft?.lastResponse ?? nextRequest?.lastResponse ?? null;
    const restoredResponse = restoredSnapshot ? toRendererResponseV2(restoredSnapshot) : null;

    if (request && draft && !outgoingDrafts[request.id]) {
      const nextDrafts = saveRequestDrafts({ ...outgoingDrafts, [request.id]: draft });

      return {
        ...historyReopenState,
        currentRequest: nextRequest,
        currentOrigin: nextOrigin,
        requestDrafts: nextDrafts,
        currentResponse: restoredResponse,
        currentResponseSource: null,
        isSending: operationContinues ? state.isSending : false,
        sendError: operationContinues ? state.sendError : null,
        requestStartTime: operationContinues ? state.requestStartTime : null,
        requestPhase: operationContinues ? state.requestPhase : null,
        requestProgress: operationContinues ? state.requestProgress : null,
        activeOperationId: operationContinues ? state.activeOperationId : null,
        activeOperationRequestId: operationContinues ? state.activeOperationRequestId : null,
      };
    }

    return {
      ...historyReopenState,
      currentRequest: nextRequest,
      currentOrigin: nextOrigin,
      currentResponse: restoredResponse,
      currentResponseSource: null,
      isSending: operationContinues ? state.isSending : false,
      sendError: operationContinues ? state.sendError : null,
      requestDrafts: outgoingDrafts,
      requestStartTime: operationContinues ? state.requestStartTime : null,
      requestPhase: operationContinues ? state.requestPhase : null,
      requestProgress: operationContinues ? state.requestProgress : null,
      activeOperationId: operationContinues ? state.activeOperationId : null,
      activeOperationRequestId: operationContinues ? state.activeOperationRequestId : null,
    };
  }),
  setDeletedHistoryRequest: (entry) => {
    const created = createDeletedHistoryRequest(entry);
    get().setCurrentRequest(created.request, created.origin);
    return created.request;
  },
  reopenHistory: async (entry) => {
    const initialState = get();
    if (initialState.isSending || initialState.activeOperationId) {
      set({ historyReopenError: 'Finish the active request before reopening history.' });
      return false;
    }
    if (initialState.historyReopenPending) return false;

    const token = createId();
    const revision = initialState.workbenchRevision;
    const selectedNodeId = useUiStore.getState().selectedNodeId;
    set({ historyReopenPending: true, historyReopenError: null, historyReopenToken: token });

    try {
      const [detail, currentDefinitionValue] = await Promise.all([
        window.api.historyGet(entry.id),
        window.api.collectionExport(entry.requestId),
      ]);

      if (!detail) {
        throw new Error('The saved response is no longer available.');
      }

      const historicalResponse = toRendererResponseV2(detail);
      const readyState = get();
      const stale =
        readyState.historyReopenToken !== token
        || readyState.workbenchRevision !== revision
        || useUiStore.getState().selectedNodeId !== selectedNodeId
        || readyState.isSending
        || readyState.activeOperationId;
      if (stale) {
        if (readyState.historyReopenToken === token) {
          set({ historyReopenPending: false, historyReopenError: null, historyReopenToken: null });
        }
        return false;
      }

      const outgoing = readyState.currentRequest;
      let outgoingDrafts = readyState.requestDrafts;
      if (outgoing && readyState.currentOrigin?.kind === 'collection') {
        outgoingDrafts = saveRequestDrafts({
          ...outgoingDrafts,
          [outgoing.id]: outgoing,
        });
      }

      const currentDefinition = currentDefinitionValue as Request | null;
      let nextRequest: Request;
      let nextOrigin: RequestWorkbenchOrigin;
      if (currentDefinition) {
        const persistedDrafts = loadRequestDrafts();
        const draft = outgoingDrafts[currentDefinition.id] ?? persistedDrafts[currentDefinition.id];
        nextRequest = mergeCurrentRequestWithDraft(currentDefinition, draft);
        nextOrigin = { kind: 'collection', requestId: currentDefinition.id };
      } else {
        const created = createDeletedHistoryRequest(entry);
        nextRequest = created.request;
        nextOrigin = created.origin;
      }

      const commitState = get();
      if (
        commitState.historyReopenToken !== token
        || commitState.workbenchRevision !== revision
        || useUiStore.getState().selectedNodeId !== selectedNodeId
      ) {
        if (commitState.historyReopenToken === token) {
          set({ historyReopenPending: false, historyReopenError: null, historyReopenToken: null });
        }
        return false;
      }

      set({
        currentRequest: nextRequest,
        currentOrigin: nextOrigin,
        requestDrafts: outgoingDrafts,
        currentResponse: historicalResponse,
        currentResponseSource: 'history',
        isSending: false,
        sendError: null,
        requestStartTime: null,
        requestPhase: null,
        requestProgress: null,
        activeOperationId: null,
        activeOperationRequestId: null,
        historyReopenPending: false,
        historyReopenError: null,
        historyReopenToken: null,
        workbenchRevision: revision + 1,
      });
      useUiStore.getState().setSelectedNodeId(currentDefinition ? currentDefinition.id : null);
      return true;
    } catch (error: unknown) {
      if (get().historyReopenToken !== token) return false;
      set({
        historyReopenPending: false,
        historyReopenError: historyReopenErrorMessage(error),
        historyReopenToken: null,
      });
      return false;
    }
  },
  updateRequest: (updates) => set((s) => {
    const currentRequest = s.currentRequest ?? createDraftRequest();
    const nextRequest = { ...currentRequest, ...updates, updatedAt: Date.now() };
    if (s.currentRequest && s.currentOrigin?.kind === 'deleted-history') {
      return { ...invalidateHistoryReopen(s), currentRequest: nextRequest };
    }

    const nextDrafts = saveRequestDrafts({
      ...s.requestDrafts,
      [nextRequest.id]: nextRequest,
    });

    return {
      ...invalidateHistoryReopen(s),
      currentRequest: nextDrafts[nextRequest.id] ?? nextRequest,
      requestDrafts: nextDrafts,
    };
  }),
  setCurrentResponse: (response) => set((state) => ({
    ...invalidateHistoryReopen(state),
    currentResponse: response,
    currentResponseSource: response ? 'live' : null,
    requestStartTime: null,
    requestPhase: null,
  })),
  setIsSending: (sending) => set((state) => ({
    ...invalidateHistoryReopen(state),
    isSending: sending,
    sendError: sending ? null : state.sendError,
    requestStartTime: sending ? state.requestStartTime : null,
    requestPhase: sending ? state.requestPhase : null,
  })),
  setSendError: (error, url) => set({
    sendError: normalizeRequestError(error, url),
    isSending: false,
    requestStartTime: null,
    requestPhase: null,
  }),
  resetResponse: () => set((state) => ({
    ...invalidateHistoryReopen(state),
    currentResponse: null,
    currentResponseSource: null,
    sendError: null,
    requestStartTime: null,
    requestPhase: null,
  })),
  setRequestStart: () => set({ requestStartTime: Date.now(), requestPhase: 'preparing' }),
  setRequestWaitingHeaders: () => set((state) => state.isSending && state.requestPhase === 'preparing'
    ? { requestPhase: 'waiting-headers' }
    : state),
  clearRequestFlight: () => set({ requestStartTime: null, requestPhase: null }),
  beginRequestOperation: (requestId) => {
    const state = get();
    if (state.activeOperationId) return null;
    const operationId = createId();
    set({
      ...invalidateHistoryReopen(state),
      activeOperationId: operationId,
      activeOperationRequestId: requestId,
      requestProgress: null,
      currentResponse: null,
      currentResponseSource: null,
      sendError: null,
      isSending: true,
      requestStartTime: Date.now(),
      requestPhase: 'preparing',
    });
    return operationId;
  },
  cancelRequestOperation: (operationId) => {
    if (!operationId || get().activeOperationId !== operationId) return false;

    set({
      activeOperationId: null,
      activeOperationRequestId: null,
      requestProgress: null,
      isSending: false,
      requestStartTime: null,
      requestPhase: 'cancelled',
    });

    if (typeof window !== 'undefined') {
      const cancelRequest = window.api?.cancelRequest;
      if (typeof cancelRequest === 'function') void cancelRequest(operationId).catch(() => undefined);
    }

    return true;
  },
  ownsRequestOperation: (operationId, requestId) => {
    const state = get();
    return state.activeOperationId === operationId
      && state.activeOperationRequestId === requestId
      && state.currentRequest?.id === requestId;
  },
  applyRequestProgress: (progress) => set((state) => {
    if (
      state.activeOperationId !== progress.operationId
      || state.activeOperationRequestId !== state.currentRequest?.id
    ) return state;
    return {
      requestProgress: progress,
      requestPhase: progress.phase,
    };
  }),
  finishRequestOperation: (operationId, phase) => {
    if (get().activeOperationId !== operationId) return false;
    set({
      activeOperationId: null,
      activeOperationRequestId: null,
      requestProgress: null,
      isSending: false,
      requestStartTime: null,
      requestPhase: phase,
    });
    return true;
  },
}));

if (typeof window !== 'undefined') {
  (window as any).__requestStore = useRequestStore;
}

// ─── Environment Store ─────────────────────────────────────────
interface EnvironmentEditorState {
  isOpen: boolean;
  mode: 'create' | 'edit';
  editingEnvironmentId: string | null;
  parentId: string | null;
}

interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;
  environmentReady: boolean;
  environmentPending: boolean;
  environmentError: string | null;
  editor: EnvironmentEditorState;

  setEnvironments: (envs: Environment[]) => void;
  setActiveEnvironment: (id: string | null) => Promise<string | null>;
  deleteEnvironment: (id: string) => Promise<string | null>;
  getInheritedVariables: () => ReadonlyMap<string, string>;
  openEditor: (envId: string) => void;
  openCreateEditor: (parentId?: string | null) => void;
  closeEditor: () => void;
  refreshEnvironments: () => Promise<boolean>;
}

let environmentQueue: Promise<unknown> = Promise.resolve();
let environmentOperations = 0;

function queueEnvironmentOperation<T>(
  operation: () => Promise<T>,
  failure: string,
  options: { invalidateOnFailure?: boolean; restoreReadyOnFailure?: boolean } = {},
): Promise<T | null> {
  environmentOperations += 1;
  useEnvironmentStore.setState({ environmentPending: true, environmentError: null });
  const result = environmentQueue.then(async () => {
    try {
      const value = await operation();
      useEnvironmentStore.setState({ environmentError: null });
      return value;
    } catch {
      useEnvironmentStore.setState({
        environmentError: failure,
        ...(options.invalidateOnFailure
          ? { environmentReady: false }
          : options.restoreReadyOnFailure
            ? { environmentReady: true }
            : {}),
      });
      return null;
    } finally {
      environmentOperations -= 1;
      useEnvironmentStore.setState({
        environmentPending: environmentOperations > 0,
        ...(environmentOperations > 0 ? { environmentReady: false } : {}),
      });
    }
  });
  environmentQueue = result;
  return result;
}

async function readEnvironmentSnapshot() {
  const environments: Environment[] = await window.api.envList();
  const settings = await window.api.settingsGet();
  const activeEnvironmentId = settings.activeEnvironmentId ?? null;
  if (activeEnvironmentId !== null && !environments.some(environment => environment.id === activeEnvironmentId)) {
    throw new Error('Invalid environment snapshot');
  }
  if (activeEnvironmentId === null && environments.length > 0) {
    throw new Error('Invalid environment snapshot');
  }
  return { environments, activeEnvironmentId, environmentReady: true };
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  environments: [],
  activeEnvironmentId: null,
  environmentReady: false,
  environmentPending: true,
  environmentError: null,
  editor: { isOpen: false, mode: 'edit', editingEnvironmentId: null, parentId: null },

  setEnvironments: (envs) => set({ environments: envs }),
  setActiveEnvironment: (id) => {
    const restoreReadyOnFailure = get().environmentReady;
    set({ environmentReady: false });
    return queueEnvironmentOperation(async () => {
      const activeEnvironmentId = await window.api.envSwitch(id ?? CORE_ENVIRONMENT_ID);
      const environments: Environment[] = await window.api.envList();
      if (!environments.some(environment => environment.id === activeEnvironmentId)) throw new Error('Invalid selection acknowledgement');
      set({ environments, activeEnvironmentId, environmentReady: true });
      return activeEnvironmentId;
    }, 'Unable to switch environment. Please retry.', { restoreReadyOnFailure });
  },
  deleteEnvironment: (id) => {
    const restoreReadyOnFailure = get().environmentReady;
    set({ environmentReady: false });
    return queueEnvironmentOperation(async () => {
      const activeEnvironmentId = await window.api.envDelete(id);
      const environments: Environment[] = await window.api.envList();
      if (!environments.some(environment => environment.id === activeEnvironmentId)) throw new Error('Invalid deletion acknowledgement');
      set({ environments, activeEnvironmentId, environmentReady: true });
      return activeEnvironmentId;
    }, 'Unable to delete environment. Refresh and retry.', { restoreReadyOnFailure });
  },
  openEditor: (envId) => set({ editor: { isOpen: true, mode: 'edit', editingEnvironmentId: envId, parentId: null } }),
  openCreateEditor: (parentId) => set({ editor: { isOpen: true, mode: 'create', editingEnvironmentId: null, parentId: parentId ?? CORE_ENVIRONMENT_ID } }),
  closeEditor: () => set({ editor: { isOpen: false, mode: 'edit', editingEnvironmentId: null, parentId: null } }),
  refreshEnvironments: () => {
    set({ environmentReady: false });
    return queueEnvironmentOperation(async () => {
      set(await readEnvironmentSnapshot());
      return true;
    }, 'Unable to load environments. Please retry.', { invalidateOnFailure: true }).then(result => result === true);
  },

  getInheritedVariables: () => {
    const activeId = get().activeEnvironmentId;
    const envs = get().environments;
    const activeEnv = envs.find(e => e.id === activeId);

    const vars = new Map<string, string>();
    const resolveEnv = (env: Environment, seen = new Set<string>()) => {
      if (seen.has(env.id)) return;
      seen.add(env.id);

      if (env.parentId) {
        const parent = envs.find(e => e.id === env.parentId);
        if (parent) resolveEnv(parent, seen);
      }

      const variables = Array.isArray(env.variables) ? env.variables : [];
      for (const v of variables) {
        vars.set(v.key, v.value);
      }
    };
    if (activeEnv) resolveEnv(activeEnv);

    return vars;
  },
}));

// ─── Settings Store ────────────────────────────────────────────
interface SettingsState {
  settings: AppSettings;

  setSettings: (settings: AppSettings) => void;
  updateSettings: (updates: Partial<AppSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: {
    theme: 'dark',
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    defaultTimeout: 30000,
    defaultFollowRedirect: true,
    autoSaveHistory: true,
    maxHistorySize: 1000,
  },

  setSettings: (settings) => set({ settings }),
  updateSettings: (updates) => set((s) => ({ settings: { ...s.settings, ...updates } })),
}));

// ─── Console Store ─────────────────────────────────────────────
interface ConsoleState {
  logs: string[];

  addLog: (message: string) => void;
  clearLogs: () => void;
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  logs: [],

  addLog: (message) => set((s) => ({ logs: [...s.logs, `${new Date().toISOString()} - ${message}`] })),
  clearLogs: () => set({ logs: [] }),
}));

// ─── History Store ─────────────────────────────────────────────
interface HistoryFilters {
  status?: number;
  url?: string;
  dateFrom?: number;
  dateTo?: number;
}

interface HistoryState {
  entries: HistoryEntry[];
  filters: HistoryFilters;
  loading: boolean;

  setEntries: (entries: HistoryEntry[]) => void;
  setFilters: (filters: Partial<HistoryFilters>) => void;
  clearEntries: () => void;
  setLoading: (loading: boolean) => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  entries: [],
  filters: {},
  loading: false,

  setEntries: (entries) => set({ entries }),
  setFilters: (filters) => set((s) => ({ filters: { ...s.filters, ...filters } })),
  clearEntries: () => set({ entries: [], filters: {} }),
  setLoading: (loading) => set({ loading }),
}));
