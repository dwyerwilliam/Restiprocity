import { create } from 'zustand';
import { Request, Response, Environment, HttpMethod, Header, QueryParameter, RequestBody, AuthConfig, AppSettings, HistoryEntry, RequestError, CORE_ENVIRONMENT_ID } from '@shared/types';
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

function loadRequestDrafts(): Record<string, Request> {
  if (Object.keys(requestDraftCache).length > 0) {
    return requestDraftCache;
  }

  try {
    const raw = window.localStorage.getItem(REQUEST_DRAFTS_STORAGE_KEY);
    requestDraftCache = raw ? JSON.parse(raw) as Record<string, Request> : {};
    return requestDraftCache;
  } catch {
    return requestDraftCache;
  }
}

function saveRequestDrafts(drafts: Record<string, Request>): void {
  requestDraftCache = drafts;

  try {
    window.localStorage.setItem(REQUEST_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    return;
  }
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
interface RequestEditorState {
  currentRequest: Request | null;
  requestDrafts: Record<string, Request>;
  currentResponse: Response | null;
  isSending: boolean;
  sendError: RequestError | null;

  setCurrentRequest: (request: Request | null) => void;
  updateRequest: (updates: Partial<Request>) => void;
  setCurrentResponse: (response: Response | null) => void;
  setIsSending: (sending: boolean) => void;
  setSendError: (error: RequestError | string | Error | null, url?: string) => void;
  resetResponse: () => void;
}

export const useRequestStore = create<RequestEditorState>((set) => ({
  currentRequest: null,
  requestDrafts: typeof window !== 'undefined' ? loadRequestDrafts() : {},
  currentResponse: null,
  isSending: false,
  sendError: null,

  setCurrentRequest: (request) => set((state) => {
    const outgoing = state.currentRequest;
    const outgoingDrafts = outgoing
      ? {
          ...state.requestDrafts,
          [outgoing.id]: outgoing,
        }
      : state.requestDrafts;

    if (outgoing) {
      saveRequestDrafts(outgoingDrafts);
    }

    const persistedDrafts = typeof window !== 'undefined' ? loadRequestDrafts() : {};
    const draft = request ? outgoingDrafts[request.id] ?? persistedDrafts[request.id] : null;
    const nextRequest = request ?? draft;

    if (request && draft && !outgoingDrafts[request.id]) {
      const nextDrafts = { ...outgoingDrafts, [request.id]: draft };
      saveRequestDrafts(nextDrafts);

      return {
        currentRequest: nextRequest,
        requestDrafts: nextDrafts,
        currentResponse: nextRequest?.lastResponse ?? null,
        isSending: false,
        sendError: null,
      };
    }

    return {
      currentRequest: nextRequest,
      currentResponse: nextRequest?.lastResponse ?? null,
      isSending: false,
      sendError: null,
      requestDrafts: outgoingDrafts,
    };
  }),
  updateRequest: (updates) => set((s) => {
    const currentRequest = s.currentRequest ?? createDraftRequest();
    const nextRequest = { ...currentRequest, ...updates, updatedAt: Date.now() };
    const nextDrafts = {
      ...s.requestDrafts,
      [nextRequest.id]: nextRequest,
    };

    saveRequestDrafts(nextDrafts);

    return {
      currentRequest: nextRequest,
      requestDrafts: nextDrafts,
    };
  }),
  setCurrentResponse: (response) => set({ currentResponse: response }),
  setIsSending: (sending) => set((state) => ({
    isSending: sending,
    sendError: sending ? null : state.sendError,
  })),
  setSendError: (error, url) => set({ sendError: normalizeRequestError(error, url), isSending: false }),
  resetResponse: () => set({ currentResponse: null, sendError: null }),
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

      for (const v of env.variables) {
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
