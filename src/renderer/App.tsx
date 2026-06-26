import React, { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { HistoryViewer } from './components/HistoryViewer';
import { StatusBar } from './components/StatusBar';
import { useUiStore, useEnvironmentStore } from './stores';

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
  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="flex flex-1-min overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1-min overflow-hidden">
          <RequestEditor />
          {responsePanelVisible && <ResponseViewer />}
          {showHistory && <HistoryViewer />}
        </div>
      </div>
      <StatusBar showHistory={showHistory} onToggleHistory={onToggleHistory} />
    </div>
  );
}

export default App;
