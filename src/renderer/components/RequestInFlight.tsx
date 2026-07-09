import React, { useState, useEffect, useCallback } from 'react';
import { useRequestStore } from '../stores';

const PHASE_LABELS: Record<string, string> = {
  preparing: 'Preparing request…',
  sent: 'Request sent ✓',
  waiting: 'Waiting for response…',
};

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RequestInFlight({
  requestStartTime,
  requestPhase,
}: {
  requestStartTime: number | null;
  requestPhase: 'preparing' | 'sent' | 'waiting' | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const setRequestSent = useRequestStore(state => state.setRequestSent);
  const setRequestWaiting = useRequestStore(state => state.setRequestWaiting);

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

  // Phase transitions: preparing → sent after 500ms, sent → waiting after 1500ms
  useEffect(() => {
    if (!requestStartTime) return;

    const toSent = setTimeout(() => setRequestSent(), 500);
    const toWaiting = setTimeout(() => setRequestWaiting(), 1500);

    return () => {
      clearTimeout(toSent);
      clearTimeout(toWaiting);
    };
  }, [requestStartTime, setRequestSent, setRequestWaiting]);

  const label = requestPhase ? PHASE_LABELS[requestPhase] : '';

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-surface)]/90 backdrop-blur-[2px]">
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
        <div className="text-sm text-[var(--color-text-muted)] animate-pulse">
          {label}
        </div>
      </div>
    </div>
  );
}
