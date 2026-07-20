import React, { useState } from 'react';
import { useEnvironmentStore, useRequestStore } from '../stores';
import { RequestInFlight } from './RequestInFlight';
import { BodyPreview } from './response/BodyPreview';
import type { RequestErrorKind } from '@shared/types';
import { CORE_ENVIRONMENT_ID } from '@shared/types';
import { toPersistedResponseV2 } from '@shared/responseContracts';

const ERROR_KIND_LABELS: Record<RequestErrorKind, string> = { transport: 'Transport error', certificate: 'Certificate error', timeout: 'Timeout', cancelled: 'Cancelled' };
const ERROR_ACTIONS: Record<RequestErrorKind, string> = {
  transport: 'Check the URL, DNS, proxy, VPN, firewall, and whether the host is accepting connections.',
  certificate: 'Inspect the certificate chain, hostname, expiry, and trust store. Only bypass verification for systems you trust.',
  timeout: 'Increase the request timeout or verify that the server can accept and complete the request.',
  cancelled: 'Send the request again if cancellation was accidental.',
};

function formatSize(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function formatDuration(ms: number): string { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`; }
function getStatusColor(status: number): string { return status >= 200 && status < 300 ? 'var(--color-success)' : status >= 300 && status < 400 ? 'var(--color-warning)' : 'var(--color-error)'; }
function getSendEnvironmentId(): string | undefined {
  const { activeEnvironmentId, environments } = useEnvironmentStore.getState();
  return activeEnvironmentId ?? (environments.some(env => env.id === CORE_ENVIRONMENT_ID) ? CORE_ENVIRONMENT_ID : undefined);
}

function TimingBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  return <div className="mb-2"><div className="mb-1 flex justify-between text-xs"><span className="text-[var(--color-text-muted)]">{label}</span><span className="text-[var(--color-text)]">{formatDuration(value)}</span></div><div className="h-2 overflow-hidden rounded bg-[var(--color-bg)]"><div className="h-full rounded" style={{ width: `${total > 0 ? (value / total) * 100 : 0}%`, backgroundColor: color }} /></div></div>;
}

export function ResponseViewer() {
  const {
    currentRequest,
    currentResponse,
    sendError,
    isSending,
    requestStartTime,
    requestPhase,
    updateRequest,
    setCurrentResponse,
    setSendError,
    beginRequestOperation,
    ownsRequestOperation,
    finishRequestOperation,
  } = useRequestStore();
  const [activeTab, setActiveTab] = useState<'body' | 'headers' | 'timings' | 'cookies'>('body');

  const retryUnsafe = async () => {
    if (!currentRequest) return;
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
        setSendError({
          kind: result.error.kind,
          code: result.error.code,
          message: result.error.message,
          rawMessage: result.error.message,
          url: insecureRequest.url,
          retryable: result.error.retryable,
        });
      } else {
        finishRequestOperation(operationId, 'failed');
        setSendError({
          kind: 'transport',
          code: 'REQUEST_BUSY',
          message: 'Another request is already active',
          rawMessage: 'Another request is already active',
          url: insecureRequest.url,
          retryable: true,
        });
      }
    } catch (error: unknown) {
      if (!ownsRequestOperation(operationId, insecureRequest.id)) return;
      finishRequestOperation(operationId, 'failed');
      setSendError(error instanceof Error ? error : 'Request denied', insecureRequest.url);
    }
  };

  if (sendError) return <div className="flex h-full flex-col bg-[var(--color-surface)]"><div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-2"><span className="font-semibold text-[var(--color-error)]">Request failed</span><span className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] text-[var(--color-text-muted)]">{ERROR_KIND_LABELS[sendError.kind]}</span></div><div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm text-[var(--color-text)]"><div className="space-y-1"><div className="font-semibold text-[var(--color-error)]">{sendError.message}</div><div className="text-xs text-[var(--color-text-muted)]">{ERROR_ACTIONS[sendError.kind]}</div></div><pre className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs font-mono whitespace-pre-wrap break-all">{sendError.rawMessage}</pre>{sendError.kind === 'certificate' && currentRequest && <button onClick={() => void retryUnsafe()} className="rounded bg-[var(--color-warning)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg)]">Send anyway (unsafe)</button>}</div></div>;
  if (!currentResponse) return <div className="relative flex h-full flex-col bg-[var(--color-surface)]">{isSending ? <RequestInFlight requestStartTime={requestStartTime} requestPhase={requestPhase} /> : <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">Send a request to see the response</div>}</div>;

  const tabs = [{ id: 'body' as const, label: 'Body' }, { id: 'headers' as const, label: 'Headers' }, { id: 'timings' as const, label: 'Timings' }, { id: 'cookies' as const, label: 'Cookies' }];
  return <div className="relative flex h-full flex-col bg-[var(--color-surface)]"><div className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-2"><span className="text-sm font-bold" style={{ color: getStatusColor(currentResponse.status) }}>{currentResponse.status} {currentResponse.statusText}</span><span className="text-xs text-[var(--color-text-muted)]">Time: {formatDuration(currentResponse.timings.total)}</span><span className="text-xs text-[var(--color-text-muted)]">Size: {formatSize(currentResponse.size)}</span><span className="text-xs text-[var(--color-text-muted)]">{new Date(currentResponse.timestamp).toLocaleTimeString()}</span></div><div className="flex border-b border-[var(--color-border)]">{tabs.map(tab => <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`border-b-2 px-4 py-2 text-xs transition-colors ${activeTab === tab.id ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>{tab.label}</button>)}</div><div className="flex-1 overflow-y-auto p-4">{activeTab === 'body' && <BodyPreview response={currentResponse} />}{activeTab === 'headers' && <div className="space-y-1">{currentResponse.headers.map((header, index) => <div key={index} className="flex gap-4 text-xs"><span className="min-w-[140px] text-truncate text-[var(--color-text-muted)]">{header.key}</span><span className="break-all text-[var(--color-text)]">{header.value}</span></div>)}</div>}{activeTab === 'timings' && <div className="space-y-3"><TimingBar label="DNS" value={currentResponse.timings.dns} total={currentResponse.timings.total} color="var(--color-primary)" /><TimingBar label="TCP" value={currentResponse.timings.tcp} total={currentResponse.timings.total} color="var(--color-success)" /><TimingBar label="TLS" value={currentResponse.timings.tls} total={currentResponse.timings.total} color="var(--color-warning)" /><TimingBar label="Time to First Byte" value={currentResponse.timings.ttfb} total={currentResponse.timings.total} color="var(--color-accent)" /><TimingBar label="Download" value={currentResponse.timings.download} total={currentResponse.timings.total} color="var(--color-error)" /></div>}{activeTab === 'cookies' && (currentResponse.cookies.length === 0 ? <p className="text-xs text-[var(--color-text-muted)]">No cookies in response.</p> : <table className="w-full text-xs"><thead><tr className="text-left text-[var(--color-text-muted)]"><th className="pb-2">Name</th><th className="pb-2">Value</th><th className="pb-2">Domain</th><th className="pb-2">Path</th></tr></thead><tbody>{currentResponse.cookies.map((cookie, index) => <tr key={index}><td className="py-1">{cookie.name}</td><td>{cookie.value}</td><td>{cookie.domain}</td><td>{cookie.path}</td></tr>)}</tbody></table>)}</div>{isSending && <RequestInFlight requestStartTime={requestStartTime} requestPhase={requestPhase} />}</div>;
}
