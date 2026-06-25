import React, { useState, useMemo } from 'react';
import { useRequestStore } from '../stores';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return 'var(--color-success)';
  if (status >= 300 && status < 400) return 'var(--color-warning)';
  if (status >= 400 && status < 500) return 'var(--color-error)';
  return 'var(--color-error)';
}

function TimingBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-[var(--color-text-muted)]">{label}</span>
        <span className="text-[var(--color-text)]">{formatDuration(value)}</span>
      </div>
      <div className="h-2 bg-[var(--color-bg)] rounded overflow-hidden">
        <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function JsonViewer({ data }: { data: string }) {
  const formatted = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }, [data]);

  return (
    <pre className="text-xs font-mono text-[var(--color-text)] whitespace-pre-wrap break-all">
      {formatted}
    </pre>
  );
}

export function ResponseViewer() {
  const { currentResponse } = useRequestStore();
  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'timings' | 'cookies'>('body');

  const tabs = [
    { id: 'body' as const, label: 'Body' },
    { id: 'headers' as const, label: 'Headers' },
    { id: 'timings' as const, label: 'Timings' },
    { id: 'cookies' as const, label: 'Cookies' },
  ];

  if (!currentResponse) {
    return (
      <div className="flex flex-col bg-[var(--color-surface)]" style={{ height: '50%' }}>
        <div className="flex items-center justify-center flex-1 text-[var(--color-text-muted)] text-sm">
          Send a request to see the response
        </div>
      </div>
    );
  }

  const copyBody = () => {
    navigator.clipboard.writeText(currentResponse.body);
  };

  return (
    <div className="flex flex-col bg-[var(--color-surface)]" style={{ height: '50%' }}>
      {/* Status Bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-[var(--color-border)]">
        <span className="text-sm font-bold" style={{ color: getStatusColor(currentResponse.status) }}>
          {currentResponse.status} {currentResponse.statusText}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">Time: {formatDuration(currentResponse.timings.total)}</span>
        <span className="text-xs text-[var(--color-text-muted)]">Size: {formatSize(currentResponse.size)}</span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {new Date(currentResponse.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-border)]">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs border-b-2 transition-colors ${activeTab === tab.id ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'body' && (
          <div className="relative">
            <button onClick={copyBody} className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              Copy
            </button>
            <JsonViewer data={currentResponse.body} />
          </div>
        )}

        {activeTab === 'headers' && (
          <div className="space-y-1">
            {currentResponse.headers.map((h, i) => (
              <div key={i} className="flex gap-4 text-xs">
                <span className="text-[var(--color-text-muted)] min-w-[140px] text-truncate">{h.key}</span>
                <span className="text-[var(--color-text)] break-all">{h.value}</span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'timings' && (
          <div className="space-y-3">
            <TimingBar label="DNS" value={currentResponse.timings.dns} total={currentResponse.timings.total} color="var(--color-primary)" />
            <TimingBar label="TCP" value={currentResponse.timings.tcp} total={currentResponse.timings.total} color="var(--color-success)" />
            <TimingBar label="TLS" value={currentResponse.timings.tls} total={currentResponse.timings.total} color="var(--color-warning)" />
            <TimingBar label="TTFB" value={currentResponse.timings.ttfb} total={currentResponse.timings.total} color="var(--color-accent)" />
            <TimingBar label="Download" value={currentResponse.timings.download} total={currentResponse.timings.total} color="var(--color-error)" />
          </div>
        )}

        {activeTab === 'cookies' && (
          <div>
            {currentResponse.cookies.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">No cookies in response.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--color-text-muted)] text-left">
                    <th className="pb-2">Name</th><th className="pb-2">Value</th><th className="pb-2">Domain</th>
                    <th className="pb-2">Path</th><th className="pb-2">HTTP Only</th><th className="pb-2">Secure</th>
                  </tr>
                </thead>
                <tbody>
                  {currentResponse.cookies.map((c, i) => (
                    <tr key={i} className="text-[var(--color-text)]">
                      <td className="py-1">{c.name}</td><td>{c.value}</td><td>{c.domain}</td>
                      <td>{c.path}</td><td>{c.httpOnly ? '✓' : '✕'}</td><td>{c.secure ? '✓' : '✕'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
