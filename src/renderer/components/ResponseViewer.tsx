import React, { useState } from 'react';
import { useEnvironmentStore, useRequestStore } from '../stores';
import { RequestInFlight } from './RequestInFlight';
import { BodyPreview } from './response/BodyPreview';
import type { RequestErrorKind, ResponseConnectionTiming, ResponseCookie, ResponseTiming } from '@shared/types';
import { CORE_ENVIRONMENT_ID } from '@shared/types';
import { toPersistedResponseV2 } from '@shared/responseContracts';

const ERROR_KIND_LABELS: Record<RequestErrorKind, string> = {
  body: 'Request body error',
  interpolation: 'Interpolation error',
  transport: 'Transport error',
  certificate: 'Certificate error',
  timeout: 'Timeout',
  cancelled: 'Cancelled',
  authentication: 'Authentication',
};

const ERROR_ACTIONS: Record<RequestErrorKind, string> = {
  body: 'Check the multipart fields and local files, then send again.',
  interpolation: 'Fix the environment variables or request, then send again.',
  transport: 'Check the URL, DNS, proxy, VPN, firewall, and whether the host is accepting connections.',
  certificate: 'Inspect the certificate chain, hostname, expiry, and trust store. Only bypass verification for systems you trust.',
  timeout: 'Increase the request timeout or verify that the server can accept and complete the request.',
  cancelled: 'Send the request again if cancellation was accidental.',
  authentication: 'Sign in with OAuth or update the client credentials, then send again.',
};

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatBoolean(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function formatCookieExpiry(expires: number | undefined): string {
  if (expires === undefined) return 'Session';

  const date = new Date(expires);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function CookieObservations({ cookies }: { cookies: ResponseCookie[] }) {
  if (cookies.length === 0) {
    return (
      <div className="space-y-1 text-xs text-[var(--color-text-muted)]" data-testid="response-cookies-empty" role="status">
        <div className="text-[var(--color-text)]">No cookies received</div>
        <p data-testid="response-cookies-redacted">
          No live cookies are available for this response. Restored snapshots are redacted and do not reconstruct jar contents.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-text-muted)]" data-testid="response-cookies-live-note">
        Raw cookie values are available for the current live response only, not saved snapshots.
      </p>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">
          <caption className="sr-only">Cookies received in the current live response</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
              <th scope="col" className="px-2 py-1 font-medium">Name</th>
              <th scope="col" className="px-2 py-1 font-medium">Value</th>
              <th scope="col" className="px-2 py-1 font-medium">Domain</th>
              <th scope="col" className="px-2 py-1 font-medium">Path</th>
              <th scope="col" className="px-2 py-1 font-medium">Expires</th>
              <th scope="col" className="px-2 py-1 font-medium">HTTP Only</th>
              <th scope="col" className="px-2 py-1 font-medium">Secure</th>
              <th scope="col" className="px-2 py-1 font-medium">SameSite</th>
            </tr>
          </thead>
          <tbody>
            {cookies.map((cookie, index) => (
              <tr key={`${cookie.name}-${cookie.domain}-${cookie.path}-${index}`} className="border-b border-[var(--color-border)]">
                <td className="px-2 py-1">{cookie.name}</td>
                <td className="px-2 py-1 break-all">{cookie.value}</td>
                <td className="px-2 py-1">{cookie.domain}</td>
                <td className="px-2 py-1">{cookie.path}</td>
                <td className="px-2 py-1">{formatCookieExpiry(cookie.expires)}</td>
                <td className="px-2 py-1">{formatBoolean(cookie.httpOnly)}</td>
                <td className="px-2 py-1">{formatBoolean(cookie.secure)}</td>
                <td className="px-2 py-1">{cookie.sameSite}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function getStatusColor(status: number): string {
  return status >= 200 && status < 300 ? 'var(--color-success)' : status >= 300 && status < 400 ? 'var(--color-warning)' : 'var(--color-error)';
}

function getSendEnvironmentId(): string | undefined {
  const { activeEnvironmentId, environments } = useEnvironmentStore.getState();
  return activeEnvironmentId ?? (environments.some(env => env.id === CORE_ENVIRONMENT_ID) ? CORE_ENVIRONMENT_ID : undefined);
}

/** `note` replaces the duration when the phase has no meaningful value (unmeasured, reused, not used). */
function TimingBar({ label, value, total, color, note }: { label: string; value: number; total: number; color: string; note?: string }) {
  const width = note === undefined && total > 0 ? (value / total) * 100 : 0;
  return <div className="mb-2" data-testid={`timing-${label.toLowerCase().replace(/\s+/g, '-')}`}><div className="mb-1 flex justify-between text-xs"><span className="text-[var(--color-text-muted)]">{label}</span><span className={note === undefined ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)] italic'}>{note ?? formatDuration(value)}</span></div><div className="h-2 overflow-hidden rounded bg-[var(--color-bg)]"><div className="h-full rounded" style={{ width: `${width}%`, backgroundColor: color }} /></div></div>;
}

const CONNECTION_SUMMARY: Record<ResponseConnectionTiming, string> = {
  'new-tcp': 'New TCP connection',
  'new-quic': 'New QUIC (HTTP/3) connection — TLS is the combined QUIC handshake',
  reused: 'Reused an existing connection — no DNS, TCP, or TLS setup was needed',
  unmeasured: 'DNS, TCP, and TLS weren’t measured for this response',
};

function ConnectionTimings({ timings }: { timings: ResponseTiming }) {
  const connection = timings.connection ?? 'unmeasured';
  const phaseNote = connection === 'unmeasured' ? 'Not measured' : undefined;
  const setupNote = connection === 'reused' ? 'Reused connection' : phaseNote;
  return (
    <>
      <p className="text-xs text-[var(--color-text-muted)]" data-testid="timing-connection" data-connection={connection}>{CONNECTION_SUMMARY[connection]}</p>
      <TimingBar label="DNS" value={timings.dns} total={timings.total} color="var(--color-primary)" note={phaseNote} />
      <TimingBar label="TCP" value={timings.tcp} total={timings.total} color="var(--color-success)" note={connection === 'new-quic' ? 'Not used (QUIC)' : setupNote} />
      <TimingBar label="TLS" value={timings.tls} total={timings.total} color="var(--color-warning)" note={setupNote} />
    </>
  );
}

export function ResponseViewer() {
  const { currentRequest, currentOrigin, currentResponse, currentResponseSource, sendError, isSending, requestStartTime, requestPhase, activeOperationId, updateRequest, setCurrentResponse, setSendError, beginRequestOperation, ownsRequestOperation, finishRequestOperation } = useRequestStore();
  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'timings' | 'cookies'>('body');

  const retryUnsafe = async () => {
    if (!currentRequest || currentOrigin?.kind !== 'collection' || currentOrigin.requestId !== currentRequest.id) return;
    const insecureRequest = { ...currentRequest, settings: { ...currentRequest.settings, allowInsecureCertificates: true } };
    const operationId = beginRequestOperation(insecureRequest.id);
    if (!operationId) return;
    try {
      const result = await window.api.sendRequest({ operationId, request: insecureRequest, environmentId: getSendEnvironmentId() });
      if (!ownsRequestOperation(operationId, insecureRequest.id)) return;
      if (result.kind === 'response' || result.kind === 'download') {
        setCurrentResponse(result.response);
        updateRequest({ lastResponse: toPersistedResponseV2(result.response) });
        finishRequestOperation(operationId, result.kind === 'download' && result.download.state === 'cancelled' ? 'cancelled' : 'saved');
      } else if (result.kind === 'cancelled') {
        finishRequestOperation(operationId, 'cancelled');
      } else if (result.kind === 'failed') {
        finishRequestOperation(operationId, 'failed');
        setSendError({ kind: result.error.kind, code: result.error.code, message: result.error.message, rawMessage: result.error.message, url: insecureRequest.url, retryable: result.error.retryable });
      } else {
        finishRequestOperation(operationId, 'failed');
        setSendError({ kind: 'transport', code: 'REQUEST_BUSY', message: 'Another request is already active', rawMessage: 'Another request is already active', url: insecureRequest.url, retryable: true });
      }
    } catch (error: unknown) {
      if (!ownsRequestOperation(operationId, insecureRequest.id)) return;
      finishRequestOperation(operationId, 'failed');
      setSendError(error instanceof Error ? error : 'Request denied', insecureRequest.url);
    }
  };

  if (sendError) {
    return <div className="flex h-full flex-col bg-[var(--color-surface)]"><div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2"><span className="font-semibold text-[var(--color-error)]">Request failed</span><span className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">{ERROR_KIND_LABELS[sendError.kind]}</span></div><div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm text-[var(--color-text)]"><div className="space-y-2"><div className="font-semibold text-[var(--color-error)]">{sendError.message}</div><div className="grid gap-1 text-xs text-[var(--color-text-muted)]"><div><span className="font-semibold text-[var(--color-text)]">Code:</span> <span data-testid="response-error-code">{sendError.code ?? 'Unknown'}</span></div><div><span className="font-semibold text-[var(--color-text)]">URL:</span> <span data-testid="response-error-url">{sendError.url}</span></div><div><span className="font-semibold text-[var(--color-text)]">Retryable:</span> <span data-testid="response-error-retryable">{formatBoolean(sendError.retryable)}</span></div></div><div className="text-xs text-[var(--color-text-muted)]">{ERROR_ACTIONS[sendError.kind]}</div></div><pre className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs font-mono whitespace-pre-wrap break-all">{sendError.rawMessage}</pre>{sendError.kind === 'certificate' && currentRequest && <button onClick={() => void retryUnsafe()} className="rounded bg-[var(--color-warning)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg)]">Send anyway (unsafe)</button>}</div></div>;
  }

  if (!currentResponse) return <div className="relative flex h-full flex-col bg-[var(--color-surface)]">{isSending ? <RequestInFlight requestStartTime={requestStartTime} requestPhase={requestPhase} activeOperationId={activeOperationId} /> : <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">Send a request to see the response</div>}</div>;

  const tabs = [{ id: 'body' as const, label: 'Body' }, { id: 'headers' as const, label: 'Headers' }, { id: 'timings' as const, label: 'Timings' }, { id: 'cookies' as const, label: 'Cookies' }];
  return (
    <div className="relative flex h-full flex-col bg-[var(--color-surface)]">
      <div className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-sm font-bold" style={{ color: getStatusColor(currentResponse.status) }}>
          {currentResponse.status} {currentResponse.statusText}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">Time: {formatDuration(currentResponse.timings.total)}</span>
        <span className="text-xs text-[var(--color-text-muted)]">Size: {formatSize(currentResponse.size)}</span>
        <span className="text-xs text-[var(--color-text-muted)]">{new Date(currentResponse.timestamp).toLocaleTimeString()}</span>
      </div>
      {currentResponseSource === 'history' && (
        <div role="status" data-testid="historical-response-notice" className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
          Historical response. {currentOrigin?.kind === 'deleted-history'
            ? 'The original collection request was deleted, so this is a temporary metadata-only request and cannot be sent.'
            : 'The request editor shows the current collection definition; reopening did not send a request.'}
        </div>
      )}
      <div className="flex border-b border-[var(--color-border)]">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 px-4 py-2 text-xs transition-colors ${activeTab === tab.id ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'body' && <BodyPreview response={currentResponse} />}
        {activeTab === 'headers' && (
          <div className="space-y-1">
            {currentResponse.headers.map((header, index) => (
              <div key={index} className="flex gap-4 text-xs">
                <span className="min-w-[140px] text-truncate text-[var(--color-text-muted)]">{header.key}</span>
                <span className="break-all text-[var(--color-text)]">{header.value}</span>
              </div>
            ))}
          </div>
        )}
        {activeTab === 'timings' && (
          <div className="space-y-3">
            <ConnectionTimings timings={currentResponse.timings} />
            <TimingBar label="Time to First Byte" value={currentResponse.timings.ttfb} total={currentResponse.timings.total} color="var(--color-primary)" />
            <TimingBar label="Download" value={currentResponse.timings.download} total={currentResponse.timings.total} color="var(--color-success)" />
          </div>
        )}
        {activeTab === 'cookies' && <CookieObservations cookies={currentResponse.cookies} />}
      </div>
    </div>
  );
}
