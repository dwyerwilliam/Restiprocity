import React from 'react';
import { useEnvironmentStore } from '../stores';

interface StatusBarProps {
  showHistory?: boolean;
  onToggleHistory?: () => void;
}

export function StatusBar({ showHistory, onToggleHistory }: StatusBarProps) {
  const { activeEnvironmentId, environments } = useEnvironmentStore();
  const activeEnv = environments.find(e => e.id === activeEnvironmentId);

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[var(--color-surface)] border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]" style={{ height: 28 }}>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--color-success)]" />
          SQLite Ready
        </span>
      </div>
      <div className="flex items-center gap-3">
        {onToggleHistory && (
          <button
            onClick={onToggleHistory}
            className={`hover:text-[var(--color-text)] ${showHistory ? 'text-[var(--color-primary)]' : ''}`}
          >
            {showHistory ? 'Hide History' : 'Show History'}
          </button>
        )}
        <span>{activeEnv ? `Env: ${activeEnv.name}` : 'No Environment'}</span>
        <span>Restiprocity v0.1.0</span>
      </div>
    </div>
  );
}
