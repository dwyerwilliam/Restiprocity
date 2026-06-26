import React, { useEffect, useMemo, useState } from 'react';
import { useHistoryStore } from '../stores';
import { HttpMethod } from '../../shared/types';

function IconHistory() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 1 20.49 15" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function methodColor(method: HttpMethod): string {
  const map: Record<HttpMethod, string> = {
    GET: 'var(--color-success)',
    POST: 'var(--color-primary)',
    PUT: 'var(--color-warning)',
    PATCH: 'var(--color-accent)',
    DELETE: 'var(--color-error)',
    HEAD: 'var(--color-text-muted)',
    OPTIONS: 'var(--color-text-muted)',
  };
  return map[method] ?? 'var(--color-text-muted)';
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'var(--color-success)';
  if (status >= 300 && status < 400) return 'var(--color-warning)';
  if (status >= 400 && status < 500) return 'var(--color-accent)';
  return 'var(--color-error)';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function HistoryViewer() {
  const { entries, filters, setEntries, setFilters, clearEntries, setLoading } = useHistoryStore();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<number | undefined>();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const data = await window.api.historyList({ status: statusFilter, url: search || undefined });
      setEntries(data ?? []);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const filteredEntries = useMemo(() => {
    if (!search && statusFilter === undefined) return entries;
    return entries.filter(e => {
      const urlMatch = !search || e.url.toLowerCase().includes(search.toLowerCase());
      const statusMatch = statusFilter === undefined || e.status === statusFilter;
      return urlMatch && statusMatch;
    });
  }, [entries, search, statusFilter]);

  const handleClear = async () => {
    await window.api.historyClear();
    clearEntries();
  };

  const handleResetFilters = () => {
    setSearch('');
    setStatusFilter(undefined);
    setFilters({});
  };

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] border-t border-[var(--color-border)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <IconHistory />
          <h2 className="text-sm font-semibold text-[var(--color-text)]">History</h2>
          <span className="text-xs text-[var(--color-text-muted)]">({filteredEntries.length})</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={loadHistory}
            className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"
            title="Refresh"
          >
            <IconRefresh />
          </button>
          <button
            onClick={handleClear}
            className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-error)]"
            title="Clear history"
          >
            <IconTrash />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1 flex-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2">
          <IconSearch />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by URL..."
            className="flex-1 text-xs bg-transparent text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none py-1"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <IconClose />
            </button>
          )}
        </div>
        <select
          value={statusFilter ?? ''}
          onChange={e => setStatusFilter(e.target.value ? Number(e.target.value) : undefined)}
          className="text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded px-2 py-1 text-[var(--color-text)] focus:outline-none"
        >
          <option value="">All statuses</option>
          <option value="200">2xx Success</option>
          <option value="404">4xx Client Error</option>
          <option value="500">5xx Server Error</option>
        </select>
        {(search || statusFilter) && (
          <button
            onClick={handleResetFilters}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Reset
          </button>
        )}
      </div>

      {/* History list */}
      <div className="flex-1 overflow-y-auto">
        {filteredEntries.length === 0 ? (
          <div className="px-3 py-4 text-xs text-[var(--color-text-muted)] text-center">
            No history entries
          </div>
        ) : (
          filteredEntries.map(entry => (
            <div key={entry.id}>
              <div
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-[var(--color-border)]/50 hover:bg-[var(--color-surface-hover)] ${
                  expandedId === entry.id ? 'bg-[var(--color-surface)]' : ''
                }`}
                onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              >
                {/* Method badge */}
                <span
                  className="text-xs font-mono font-bold px-1.5 py-0.5 rounded"
                  style={{ color: methodColor(entry.method) }}
                >
                  {entry.method}
                </span>

                {/* Status code */}
                <span
                  className="text-xs font-mono"
                  style={{ color: statusColor(entry.status) }}
                >
                  {entry.status}
                </span>

                {/* URL */}
                <span className="text-xs text-[var(--color-text)] truncate flex-1">
                  {entry.url}
                </span>

                {/* Duration */}
                <span className="text-xs text-[var(--color-text-muted)]">
                  {formatDuration(entry.duration)}
                </span>

                {/* Size */}
                <span className="text-xs text-[var(--color-text-muted)]">
                  {formatSize(entry.size)}
                </span>

                {/* Timestamp */}
                <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
                  {formatTimestamp(entry.timestamp)}
                </span>
              </div>

              {/* Expanded details */}
              {expandedId === entry.id && (
                <div className="px-3 py-2 bg-[var(--color-surface)] border-b border-[var(--color-border)]/50">
                  <div className="text-xs text-[var(--color-text-muted)] space-y-1">
                    <div>Request: {entry.requestName}</div>
                    <div>Duration: {formatDuration(entry.duration)}</div>
                    <div>Size: {formatSize(entry.size)}</div>
                    <div>Timestamp: {new Date(entry.timestamp).toISOString()}</div>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
