import React, { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { RequestEditor } from './components/RequestEditor';
import { ResponseViewer } from './components/ResponseViewer';
import { HistoryViewer } from './components/HistoryViewer';
import { StatusBar } from './components/StatusBar';
import { useUiStore, useEnvironmentStore } from './stores';

function App() {
  const { responsePanelVisible } = useUiStore();
  const { setEnvironments } = useEnvironmentStore();
  const [showHistory, setShowHistory] = useState(false);

  // Load initial data on mount
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
    <div className="flex flex-col h-full bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Main content area */}
      <div className="flex flex-1-min overflow-hidden">
        {/* Sidebar */}
        <Sidebar />

        {/* Main panel */}
        <div className="flex flex-col flex-1-min overflow-hidden">
          {/* Request Editor */}
          <RequestEditor />

          {/* Response Viewer */}
          {responsePanelVisible && <ResponseViewer />}

          {/* History Viewer */}
          {showHistory && <HistoryViewer />}
        </div>
      </div>

      {/* Status Bar */}
      <StatusBar showHistory={showHistory} onToggleHistory={() => setShowHistory(v => !v)} />
    </div>
  );
}

export default App;
