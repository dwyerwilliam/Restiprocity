import { create } from 'zustand';
import { Request, Response, Environment, HttpMethod, Header, QueryParameter, RequestBody, AuthConfig, AppSettings, HistoryEntry } from '@shared/types';
import { createId } from '../utils/id';

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
  currentResponse: Response | null;
  isSending: boolean;
  sendError: string | null;

  setCurrentRequest: (request: Request | null) => void;
  updateRequest: (updates: Partial<Request>) => void;
  setCurrentResponse: (response: Response | null) => void;
  setIsSending: (sending: boolean) => void;
  setSendError: (error: string | null) => void;
  resetResponse: () => void;
}

export const useRequestStore = create<RequestEditorState>((set) => ({
  currentRequest: null,
  currentResponse: null,
  isSending: false,
  sendError: null,

  setCurrentRequest: (request) => set({
    currentRequest: request,
    currentResponse: request?.lastResponse ?? null,
    isSending: false,
    sendError: null,
  }),
  updateRequest: (updates) => set((s) => {
    const currentRequest = s.currentRequest ?? createDraftRequest();

    return {
      currentRequest: { ...currentRequest, ...updates, updatedAt: Date.now() },
    };
  }),
  setCurrentResponse: (response) => set({ currentResponse: response }),
  setIsSending: (sending) => set({ isSending: sending, sendError: null }),
  setSendError: (error) => set({ sendError: error, isSending: false }),
  resetResponse: () => set({ currentResponse: null, sendError: null }),
}));

// ─── Environment Store ─────────────────────────────────────────
interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;

  setEnvironments: (envs: Environment[]) => void;
  setActiveEnvironment: (id: string | null) => void;
  resolveVariables: (text: string) => string;
}

export const useEnvironmentStore = create<EnvironmentState>((set, get) => ({
  environments: [],
  activeEnvironmentId: null,

  setEnvironments: (envs) => set({ environments: envs }),
  setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),

  resolveVariables: (text: string) => {
    const activeId = get().activeEnvironmentId;
    const envs = get().environments;
    const activeEnv = envs.find(e => e.id === activeId);

    if (!activeEnv) return text;

    // Merge base + sub environment variables
    const vars = new Map<string, string>();
    const resolveEnv = (env: Environment) => {
      for (const v of env.variables) {
        vars.set(v.key, v.value);
      }
      if (env.parentId) {
        const parent = envs.find(e => e.id === env.parentId);
        if (parent) resolveEnv(parent);
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
