import React, { useEffect, useState } from 'react';
import { useEnvironmentStore } from '../stores';
import { CORE_ENVIRONMENT_ID, UpdateStatus } from '@shared/types';
import { APP_VERSION } from '@shared/appVersion';

interface StatusBarProps {
  showHistory?: boolean;
  onToggleHistory?: () => void;
}

export function StatusBar({ showHistory, onToggleHistory }: StatusBarProps) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const { activeEnvironmentId, environments, openEditor } = useEnvironmentStore();
  const activeEnv = environments.find(e => e.id === activeEnvironmentId);
  const targetEnv = activeEnv ?? environments.find(e => e.id === CORE_ENVIRONMENT_ID);

  useEffect(() => {
    const api = window.api;
    if (!api?.onUpdateStatus) return;

    return api.onUpdateStatus(setUpdateStatus);
  }, []);

  const updateVisible = updateStatus && updateStatus.kind !== 'unsupported';
  const updateLabel = updateStatus ? getUpdateLabel(updateStatus) : null;
  const canCheck = updateStatus?.kind === 'idle' || updateStatus?.kind === 'no-update' || updateStatus?.kind === 'error';
  const isError = updateStatus?.kind === 'error';

  async function checkForUpdates() {
    if (window.api?.updateCheck) setUpdateStatus(await window.api.updateCheck());
  }

  async function applyUpdate() {
    if (updateStatus?.kind === 'downloaded' && window.api?.updateApply) {
      setUpdateStatus(await window.api.updateApply());
    }
  }

  return (
    <div className="flex items-center justify-between px-3 py-1 bg-[var(--color-surface)] border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]" style={{ height: 28 }}>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[var(--color-success)]" />
          SQLite Ready
        </span>
      </div>
      <div className="flex items-center gap-3">
        {updateVisible && (
          <span className={`flex items-center gap-1.5 max-w-[min(42vw,360px)] text-truncate ${isError ? 'text-[var(--color-error)]' : updateStatus.kind === 'downloaded' ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}`} title={getUpdateTitle(updateStatus)}>
            <span className="text-truncate">{updateLabel}</span>
            {canCheck && (
              <button type="button" onClick={() => void checkForUpdates()} className="shrink-0 underline underline-offset-2 hover:text-[var(--color-text)]">
                Check
              </button>
            )}
            {updateStatus.kind === 'downloaded' && (
              <button type="button" onClick={() => void applyUpdate()} className="shrink-0 rounded bg-[var(--color-success)] px-1.5 py-0.5 font-medium text-[var(--color-bg)] hover:brightness-110">
                Restart to update
              </button>
            )}
          </span>
        )}
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

function getUpdateLabel(status: UpdateStatus): string {
  switch (status.kind) {
    case 'idle': return 'Updates ready to check';
    case 'checking': return 'Checking for updates…';
    case 'no-update': return `You’re up to date (v${status.currentVersion})`;
    case 'available': return `Update v${status.latestVersion} available · downloading automatically`;
    case 'downloading': return `Downloading v${status.latestVersion} · ${Math.round(status.progress.percent)}%`;
    case 'downloaded': return `Update v${status.latestVersion} ready · UAC may show “Unknown publisher”`;
    case 'installing': return 'Installing update…';
    case 'error': return `Update ${status.stage} failed: ${status.message}`;
    case 'unsupported': return '';
  }
}

function getUpdateTitle(status: UpdateStatus | null): string | undefined {
  if (!status || status.kind === 'unsupported') return undefined;
  if (status.kind === 'downloaded') return 'Unsigned Windows installers may show an Unknown publisher warning before UAC approval.';
  return undefined;
}
