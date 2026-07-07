import React from 'react';
import { useEnvironmentStore } from '../stores';
import { CORE_ENVIRONMENT_ID } from '@shared/types';
import { APP_VERSION } from '@shared/appVersion';

interface StatusBarProps {
  showHistory?: boolean;
  onToggleHistory?: () => void;
}

export function StatusBar({ showHistory, onToggleHistory }: StatusBarProps) {
  const { activeEnvironmentId, environments, openEditor } = useEnvironmentStore();
  const activeEnv = environments.find(e => e.id === activeEnvironmentId);
  const targetEnv = activeEnv ?? environments.find(e => e.id === CORE_ENVIRONMENT_ID);

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
        <button
          type="button"
          onClick={() => targetEnv && openEditor(targetEnv.id)}
          className="hover:text-[var(--color-text)]"
          title="Edit environment"
        >
          {targetEnv ? `Env: ${targetEnv.name}` : 'No Environment'}
        </button>
        <span>Restiprocity v{APP_VERSION}</span>
      </div>
    </div>
  );
}
