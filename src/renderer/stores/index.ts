import { create } from 'zustand';
import { normalizeResponseSnapshotV2, toRendererResponseV2 } from '@shared/responseContracts';
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
    : { ...requestData, lastResponse: normalizeResponseSnapshotV2(lastResponse) };
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
  requestDrafts: Record<string, Request>;
  currentResponse: ResponseV2 | null;
  isSending: boolean;
  sendError: RequestError | null;
  requestStartTime: number | null;
  requestPhase: RequestFlightPhase | null;
  requestProgress: ResponseOperationProgressV2 | null;
  activeOperationId: string | null;
  activeOperationRequestId: string | null;

  setCurrentRequest: (request: Request | null) => void;
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
  requestDrafts: typeof window !== 'undefined' ? loadRequestDrafts() : {},
  currentResponse: null,
  isSending: false,
  sendError: null,
  requestStartTime: null,
  requestPhase: null,
  requestProgress: null,
  activeOperationId: null,
  activeOperationRequestId: null,

  setCurrentRequest: (request) => set((state) => {
    const outgoing = state.currentRequest;
    const operationContinues = Boolean(
      state.activeOperationId
      && request
      && state.activeOperationRequestId === request.id,
    );
    if (state.activeOperationId && !operationContinues && typeof window !== 'undefined') {
      const cancelRequest = window.api?.cancelRequest;
      if (typeof cancelRequest === 'function') void cancelRequest(state.activeOperationId).catch(() => undefined);
    }
    let outgoingDrafts = outgoing
      ? {
          ...state.requestDrafts,
          [outgoing.id]: outgoing,
        }
      : state.requestDrafts;

    if (outgoing) {
      outgoingDrafts = saveRequestDrafts(outgoingDrafts);
    }

    const persistedDrafts = typeof window !== 'undefined' ? loadRequestDrafts() : {};
    const draft = request ? outgoingDrafts[request.id] ?? persistedDrafts[request.id] : null;
    const nextRequest = request && draft?.lastResponse
      ? { ...request, lastResponse: draft.lastResponse }
      : request ?? draft;
    const restoredSnapshot = draft?.lastResponse ?? nextRequest?.lastResponse ?? null;
    const restoredResponse = restoredSnapshot ? toRendererResponseV2(restoredSnapshot) : null;

    if (request && draft && !outgoingDrafts[request.id]) {
      const nextDrafts = saveRequestDrafts({ ...outgoingDrafts, [request.id]: draft });

      return {
        currentRequest: nextRequest,
        requestDrafts: nextDrafts,
        currentResponse: restoredResponse,
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
      currentRequest: nextRequest,
      currentResponse: restoredResponse,
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
  updateRequest: (updates) => set((s) => {
    const currentRequest = s.currentRequest ?? createDraftRequest();
    const nextRequest = { ...currentRequest, ...updates, updatedAt: Date.now() };
    const nextDrafts = saveRequestDrafts({
      ...s.requestDrafts,
      [nextRequest.id]: nextRequest,
    });

    return {
      currentRequest: nextDrafts[nextRequest.id] ?? nextRequest,
      requestDrafts: nextDrafts,
    };
  }),
  setCurrentResponse: (response) => set({
    currentResponse: response,
    requestStartTime: null,
    requestPhase: null,
  }),
  setIsSending: (sending) => set((state) => ({
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
  resetResponse: () => set({ currentResponse: null, sendError: null, requestStartTime: null, requestPhase: null }),
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
      activeOperationId: operationId,
      activeOperationRequestId: requestId,
      requestProgress: null,
      currentResponse: null,
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
  editor: EnvironmentEditorState;

  setEnvironments: (envs: Environment[]) => void;
  setActiveEnvironment: (id: string | null) => void;
  resolveVariables: (text: string) => string;
  openEditor: (envId: string) => void;
  openCreateEditor: (parentId?: string | null) => void;
  closeEditor: () => void;
  refreshEnvironments: () => Promise<void>;
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  environments: [],
  activeEnvironmentId: null,
  editor: { isOpen: false, mode: 'edit', editingEnvironmentId: null, parentId: null },

  setEnvironments: (envs) => set((state) => ({
    environments: envs,
    activeEnvironmentId: state.activeEnvironmentId && envs.some(env => env.id === state.activeEnvironmentId)
      ? state.activeEnvironmentId
      : envs.some(env => env.id === CORE_ENVIRONMENT_ID)
        ? CORE_ENVIRONMENT_ID
        : state.activeEnvironmentId,
  })),
  setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),
  openEditor: (envId) => set({ editor: { isOpen: true, mode: 'edit', editingEnvironmentId: envId, parentId: null } }),
  openCreateEditor: (parentId) => set({ editor: { isOpen: true, mode: 'create', editingEnvironmentId: null, parentId: parentId ?? CORE_ENVIRONMENT_ID } }),
  closeEditor: () => set({ editor: { isOpen: false, mode: 'edit', editingEnvironmentId: null, parentId: null } }),
  refreshEnvironments: async () => {
    try {
      const envs = await window.api.envList();
      set({ environments: envs || [] });
    } catch (err) {
      console.error('Failed to refresh environments:', err);
    }
  },

  resolveVariables: (text: string) => {
    const activeId = get().activeEnvironmentId;
    const envs = get().environments;
    const activeEnv = envs.find(e => e.id === activeId);

    if (!activeEnv) return text;

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
    resolveEnv(activeEnv);

    // Add built-in variables
    vars.set('timestamp', Date.now().toString());
    vars.set('randomInt', Math.floor(Math.random() * 1000000).toString());
    vars.set('uuid', createId());

    // Interpolate {{variable}} tags
    return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      return vars.get(key) ?? `{{${key}}}`;
    });
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
