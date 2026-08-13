import React, { useState, useEffect, useRef } from 'react';
import { useRequestStore } from '../stores';
import type { RequestFlightPhase } from '../stores';

const PHASE_LABELS: Record<string, string> = {
  preparing: 'Preparing request…',
  'waiting-headers': 'Waiting for response headers…',
  receiving: 'Receiving response preview…',
  'awaiting-destination': 'Choose a download destination…',
  downloading: 'Downloading response…',
  publishing: 'Publishing download…',
  saved: 'Download saved',
  cancelled: 'Request cancelled',
  failed: 'Request failed',
};

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RequestInFlight({
  requestStartTime,
  requestPhase,
  activeOperationId,
}: {
  requestStartTime: number | null;
  requestPhase: RequestFlightPhase | null;
  activeOperationId: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const setRequestWaitingHeaders = useRequestStore(state => state.setRequestWaitingHeaders);
  const cancelRequestOperation = useRequestStore(state => state.cancelRequestOperation);

  useEffect(() => {
    if (activeOperationId) stopButtonRef.current?.focus();
  }, [activeOperationId]);

  // Rising timer: update every 100ms
  useEffect(() => {
    if (!requestStartTime) {
      setElapsed(0);
      return;
    }

    const tick = () => setElapsed(Date.now() - requestStartTime);
    tick();

    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [requestStartTime]);

  useEffect(() => {
    if (!requestStartTime) return;

    const toWaiting = setTimeout(() => setRequestWaitingHeaders(), 500);

    return () => {
      clearTimeout(toWaiting);
    };
  }, [requestStartTime, setRequestWaitingHeaders]);

  const label = requestPhase ? PHASE_LABELS[requestPhase] : '';

  const handleStop = () => {
    if (cancelRequestOperation(activeOperationId)) return;
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-surface)]/90 px-4 text-center backdrop-blur-[2px]">
      <div className="flex flex-col items-center gap-4">
        {/* Spinning ring indicator */}
        <div className="relative w-14 h-14">
          <div className="absolute inset-0 rounded-full border-2 border-[var(--color-border)]/40" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--color-primary)] animate-spin" />
        </div>

        {/* Timer */}
        <div className="text-3xl font-mono font-bold text-[var(--color-text)] tabular-nums">
          {formatElapsed(elapsed)}
        </div>

        {/* Phase label */}
        <div aria-live="polite" className="max-w-full break-words text-sm text-[var(--color-text-muted)] animate-pulse">
          {label}
        </div>

        <button
          type="button"
          ref={stopButtonRef}
          data-testid="stop-request"
          aria-label="Stop request"
          onClick={handleStop}
          disabled={!activeOperationId}
          className="rounded border border-[var(--color-error)] px-4 py-2 text-sm font-semibold text-[var(--color-error)] transition-colors hover:bg-[var(--color-error)]/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Stop
        </button>
      </div>
    </div>
  );
}
