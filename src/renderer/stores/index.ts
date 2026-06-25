import { create } from 'zustand';
import { Request, Response, Environment, HttpMethod, Header, QueryParameter, RequestBody, AuthConfig, AppSettings } from '@shared/types';

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

  setCurrentRequest: (request) => set({ currentRequest: request, currentResponse: null, sendError: null }),
  updateRequest: (updates) => set((s) => ({
    currentRequest: s.currentRequest ? { ...s.currentRequest, ...updates, updatedAt: Date.now() } : null,
  })),
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
    vars.set('uuid', crypto.randomUUID());

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
