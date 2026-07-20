import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { HistoryViewer } from './components/HistoryViewer';
import { StatusBar } from './components/StatusBar';
import { EnvironmentEditor } from './components/EnvironmentEditor';
import { useUiStore, useEnvironmentStore } from './stores';
import { CORE_ENVIRONMENT_ID } from '@shared/types';

const EDITOR_PANE_SPLIT_STORAGE_KEY = 'restiprocity:editor-pane-split-percent';
const MIN_EDITOR_PANE_PERCENT = 25;
const MAX_EDITOR_PANE_PERCENT = 75;

function clampEditorPanePercent(value: number) {
  return Math.min(MAX_EDITOR_PANE_PERCENT, Math.max(MIN_EDITOR_PANE_PERCENT, value));
}

function getSavedEditorPanePercent() {
  const savedValue = window.localStorage.getItem(EDITOR_PANE_SPLIT_STORAGE_KEY);
  const savedPercent = savedValue ? Number(savedValue) : 50;

  return Number.isFinite(savedPercent) ? clampEditorPanePercent(savedPercent) : 50;
}

class DevErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  state = { hasError: false, error: '' };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[Dev Error]', {
        type: 'react-render-error',
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        timestamp: new Date().toISOString(),
      });
    }
  }
  render() {
    if (this.state.hasError && import.meta.env.DEV) {
      return (
        <div className="flex items-center justify-center h-full bg-[var(--color-bg)] text-[var(--color-error)] p-8">
          <div className="max-w-xl text-center">
            <div className="text-lg font-bold mb-2">Something went wrong</div>
            <pre className="text-xs text-[var(--color-text-muted)] bg-[var(--color-surface)] p-3 rounded text-left overflow-auto">
              {this.state.error}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const { responsePanelVisible } = useUiStore();
  const { setEnvironments, setActiveEnvironment } = useEnvironmentStore();

  useEffect(() => {
    loadInitialData();
    setupConsoleListener();
  }, []);

  async function loadInitialData() {
    try {
      const envs = await window.api.envList();
      const environments = envs || [];
      setEnvironments(environments);
      if (environments.some((env: { id: string }) => env.id === CORE_ENVIRONMENT_ID)) {
        setActiveEnvironment(CORE_ENVIRONMENT_ID);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }

  function setupConsoleListener() {
    window.api.onConsoleLog((message: string) => {
      console.log('[Main]', message);
    });
  }

  return (
    <DevErrorBoundary>
      <AppContent responsePanelVisible={responsePanelVisible} />
    </DevErrorBoundary>
  );
}

function AppContent({ responsePanelVisible }: { responsePanelVisible: boolean }) {
  const mainColumnRef = useRef<HTMLDivElement>(null);
  const [editorPanePercent, setEditorPanePercent] = useState(getSavedEditorPanePercent);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_PANE_SPLIT_STORAGE_KEY, String(editorPanePercent));
  }, [editorPanePercent]);

  const resizeTo = useCallback((clientX: number) => {
    const mainColumn = mainColumnRef.current;
    if (!mainColumn) return;

    const rect = mainColumn.getBoundingClientRect();
    const nextPercent = ((clientX - rect.left) / rect.width) * 100;
    setEditorPanePercent(clampEditorPanePercent(nextPercent));
  }, []);

  const startPaneResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeTo(event.clientX);

    const handleMouseMove = (moveEvent: MouseEvent) => resizeTo(moveEvent.clientX);
    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [resizeTo]);

  const nudgePaneSize = useCallback((direction: -1 | 1) => {
    setEditorPanePercent(value => clampEditorPanePercent(value + direction * 5));
  }, []);

  const responsePanePercent = 100 - editorPanePercent;

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex flex-1-min overflow-hidden">
        <Sidebar />
        <div ref={mainColumnRef} className="flex flex-1-min overflow-hidden">
          <div className="flex flex-col overflow-hidden" style={{ width: responsePanelVisible ? `${editorPanePercent}%` : '100%' }}>
            <RequestEditor />
          </div>
          {responsePanelVisible && (
            <>
              <div
                role="separator"
                aria-label="Resize editor and response panes"
                aria-orientation="vertical"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(editorPanePercent)}
                tabIndex={0}
                className="relative w-2 flex-shrink-0 cursor-col-resize bg-[var(--color-border)]/60 hover:bg-[var(--color-primary)] focus:outline-none focus:bg-[var(--color-primary)] transition-colors"
                onMouseDown={startPaneResize}
                onKeyDown={event => {
                  if (event.key === 'ArrowLeft') nudgePaneSize(-1);
                  if (event.key === 'ArrowRight') nudgePaneSize(1);
                }}
              >
                <div className="absolute left-1/2 top-1/2 w-0.5 h-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-text-muted)]/60" />
              </div>
              <div className="flex flex-col overflow-hidden" style={{ width: `${responsePanePercent}%` }}>
                {showHistory ? (
                  <>
                    <div className="flex-1-min overflow-hidden">
                      <ResponseViewer />
                    </div>
                    <div className="flex-1-min overflow-hidden">
                      <HistoryViewer />
                    </div>
                  </>
                ) : (
                  <div className="h-full overflow-hidden">
                    <ResponseViewer />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar showHistory={showHistory} onToggleHistory={() => setShowHistory(v => !v)} />
      <EnvironmentEditor />
    </div>
  );
}

export default App;
