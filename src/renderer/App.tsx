import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { HistoryViewer } from './components/HistoryViewer';
import { StatusBar } from './components/StatusBar';
import { useUiStore, useEnvironmentStore } from './stores';

const REQUEST_PANE_SPLIT_STORAGE_KEY = 'restiprocity:request-pane-split-percent';
const MIN_REQUEST_PANE_PERCENT = 25;
const MAX_REQUEST_PANE_PERCENT = 75;

function clampRequestPanePercent(value: number) {
  return Math.min(MAX_REQUEST_PANE_PERCENT, Math.max(MIN_REQUEST_PANE_PERCENT, value));
}

function getSavedRequestPanePercent() {
  const savedValue = window.localStorage.getItem(REQUEST_PANE_SPLIT_STORAGE_KEY);
  const savedPercent = savedValue ? Number(savedValue) : 50;

  return Number.isFinite(savedPercent) ? clampRequestPanePercent(savedPercent) : 50;
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
  const { setEnvironments } = useEnvironmentStore();
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    loadInitialData();
    setupConsoleListener();
  }, []);

  async function loadInitialData() {
    try {
      const envs = await window.api.envList();
      setEnvironments(envs || []);
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
      <AppContent
        responsePanelVisible={responsePanelVisible}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory(v => !v)}
      />
    </DevErrorBoundary>
  );
}

function AppContent({
  responsePanelVisible,
  showHistory,
  onToggleHistory,
}: {
  responsePanelVisible: boolean;
  showHistory: boolean;
  onToggleHistory: () => void;
}) {
  const editorColumnRef = useRef<HTMLDivElement>(null);
  const [requestPanePercent, setRequestPanePercent] = useState(getSavedRequestPanePercent);

  useEffect(() => {
    window.localStorage.setItem(REQUEST_PANE_SPLIT_STORAGE_KEY, String(requestPanePercent));
  }, [requestPanePercent]);

  const resizeTo = useCallback((clientY: number) => {
    const editorColumn = editorColumnRef.current;
    if (!editorColumn) return;

    const rect = editorColumn.getBoundingClientRect();
    const nextPercent = ((clientY - rect.top) / rect.height) * 100;
    setRequestPanePercent(clampRequestPanePercent(nextPercent));
  }, []);

  const startPaneResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeTo(event.clientY);

    const handleMouseMove = (moveEvent: MouseEvent) => resizeTo(moveEvent.clientY);
    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [resizeTo]);

  const nudgePaneSize = useCallback((direction: -1 | 1) => {
    setRequestPanePercent(value => clampRequestPanePercent(value + direction * 5));
  }, []);

  const responsePanePercent = 100 - requestPanePercent;

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex flex-1-min overflow-hidden">
        <Sidebar />
        <div ref={editorColumnRef} className="flex flex-col flex-1-min overflow-hidden">
          <RequestEditor heightPercent={responsePanelVisible ? requestPanePercent : 100} />
          {responsePanelVisible && (
            <>
              <div
                role="separator"
                aria-label="Resize request and response panes"
                aria-orientation="horizontal"
                aria-valuemin={25}
                aria-valuemax={75}
                aria-valuenow={Math.round(requestPanePercent)}
                tabIndex={0}
                className="relative h-2 flex-shrink-0 cursor-row-resize bg-[var(--color-border)]/60 hover:bg-[var(--color-primary)] focus:outline-none focus:bg-[var(--color-primary)] transition-colors"
                onMouseDown={startPaneResize}
                onKeyDown={event => {
                  if (event.key === 'ArrowUp') nudgePaneSize(-1);
                  if (event.key === 'ArrowDown') nudgePaneSize(1);
                }}
              >
                <div className="absolute left-1/2 top-1/2 h-0.5 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--color-text-muted)]/60" />
              </div>
              <ResponseViewer heightPercent={responsePanePercent} />
            </>
          )}
          {showHistory && <HistoryViewer />}
        </div>
      </div>
      <StatusBar showHistory={showHistory} onToggleHistory={onToggleHistory} />
    </div>
  );
}

export default App;
