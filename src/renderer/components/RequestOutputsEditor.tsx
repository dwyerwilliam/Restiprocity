import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultRequestOutputs, OUTPUT_LIMITS, siblingPointer, validateRequestOutputs } from '@shared/requestOutputs';
import type { Environment, Request, RequestOutputs, RequestOutputSource, RequestOutputStatus } from '@shared/types';
import { useEnvironmentStore, useRequestStore } from '../stores';
import { refreshOutputIndex, useOutputIndex } from '../hooks/useOutputIndex';

type SourceKind = RequestOutputSource['kind'];

interface FormRow { name: string; kind: SourceKind; path: string }
interface Form {
  enabled: boolean;
  rows: FormRow[];
  seconds: string;
  expiresIn: string;
  resendOn401: boolean;
}

const inputClass = 'w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] font-mono';
const STATUS_POLL_MS = 1000;

function formOf(outputs: RequestOutputs | undefined): Form | null {
  if (!outputs) return null;
  return {
    enabled: outputs.enabled,
    rows: outputs.values.map(value => ({
      name: value.name,
      kind: value.source.kind,
      path: value.source.kind === 'json' ? value.source.pointer : value.source.kind === 'header' ? value.source.name : '',
    })),
    seconds: String(outputs.refreshAfterSeconds),
    expiresIn: outputs.expiresInPointer ?? '',
    resendOn401: outputs.resendOn401,
  };
}

function outputsOf(form: Form): unknown {
  return {
    enabled: form.enabled,
    values: form.rows.map(row => ({
      name: row.name.trim(),
      source: row.kind === 'json' ? { kind: 'json', pointer: row.path.trim() }
        : row.kind === 'header' ? { kind: 'header', name: row.path.trim() }
        : { kind: 'body' },
    })),
    refreshAfterSeconds: /^\d+$/.test(form.seconds.trim()) ? Number(form.seconds.trim()) : Number.NaN,
    expiresInPointer: form.expiresIn.trim() === '' ? null : form.expiresIn.trim(),
    resendOn401: form.resendOn401,
  };
}

/** Electron prefixes errors that cross IPC; the store's own sentence is what the user needs. */
function storeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function environmentChain(environments: Environment[], activeId: string | null): Environment[] {
  const byId = new Map(environments.map(environment => [environment.id, environment]));
  const chain: Environment[] = [];
  const seen = new Set<string>();
  for (let id = activeId ?? undefined; id && !seen.has(id); id = byId.get(id)?.parentId) {
    seen.add(id);
    const environment = byId.get(id);
    if (environment) chain.push(environment);
  }
  return chain;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusText(status: RequestOutputStatus | null, environmentName: string): string {
  if (!status) return '';
  switch (status.state) {
    case 'fresh':
      return `${environmentName}: fetched ${formatTime(status.fetchedAt!)} · refreshes after ${formatTime(status.refreshAt!)}`;
    case 'stale':
      return `${environmentName}: expired at ${formatTime(status.refreshAt!)}. The next request that uses it fetches again.`;
    case 'fetching':
      return `${environmentName}: fetching…`;
    case 'failed':
      return `${environmentName}: last fetch failed. ${status.error?.message ?? ''}`.trim();
    default:
      return `${environmentName}: not fetched yet. The first request that uses these values fetches them.`;
  }
}

/**
 * The Outputs tab: values taken from this request's response that every request can use as {{name}}. The form is
 * kept here; only a valid definition the store accepts reaches the request, so other edits never resend a bad one.
 */
export function RequestOutputsEditor({ request }: { request: Request }) {
  const updateRequest = useRequestStore(state => state.updateRequest);
  const origin = useRequestStore(state => state.currentOrigin);
  const environments = useEnvironmentStore(state => state.environments);
  const activeEnvironmentId = useEnvironmentStore(state => state.activeEnvironmentId);
  const environmentReady = useEnvironmentStore(state => state.environmentReady);
  const outputIndex = useOutputIndex();
  const [form, setForm] = useState<Form | null>(() => formOf(request.outputs));
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RequestOutputStatus | null>(null);
  const saveSequence = useRef(0);
  const canSave = origin?.kind === 'collection' && origin.requestId === request.id;
  const environmentId = environmentReady ? activeEnvironmentId ?? undefined : undefined;
  const chain = useMemo(() => environmentChain(environments, activeEnvironmentId), [environments, activeEnvironmentId]);
  const environmentName = chain[0]?.name ?? 'Current environment';

  const loadStatus = useCallback(async () => {
    if (typeof window.api.outputsStatus !== 'function' || !request.outputs?.enabled) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await window.api.outputsStatus({ requestId: request.id, ...(environmentId ? { environmentId } : {}) }));
    } catch {
      setStatus(null);
    }
  }, [environmentId, request.id, request.outputs?.enabled]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => { void loadStatus(); }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const problem = useMemo((): string | null => {
    if (!form) return null;
    const checked = validateRequestOutputs(outputsOf(form));
    if (!checked.ok) return checked.message;
    if (checked.outputs.enabled) {
      for (const value of checked.outputs.values) {
        const owner = outputIndex.get(value.name);
        if (owner?.enabled && owner.requestId !== request.id) {
          return `"${value.name}" is already an output of "${owner.requestName}". Choose another name.`;
        }
      }
    }
    return null;
  }, [form, outputIndex, request.id]);

  const shadowed = useMemo(() => {
    if (!form?.enabled) return [];
    const keys = new Map<string, string>();
    for (const environment of chain) for (const variable of environment.variables) if (!keys.has(variable.key)) keys.set(variable.key, environment.name);
    return form.rows.flatMap(row => keys.has(row.name.trim()) ? [{ name: row.name.trim(), environment: keys.get(row.name.trim())! }] : []);
  }, [chain, form]);

  const commit = useCallback(async (next: Form) => {
    const checked = validateRequestOutputs(outputsOf(next));
    if (!checked.ok || !canSave) return;
    const base = useRequestStore.getState().currentRequest;
    if (!base || base.id !== request.id) return;
    const sequence = ++saveSequence.current;
    try {
      await window.api.collectionUpdate(base.id, { ...base, outputs: checked.outputs, nodeType: 'request' });
      if (sequence !== saveSequence.current) return;
      updateRequest({ outputs: checked.outputs });
      setError(null);
      void refreshOutputIndex().catch(() => {});
    } catch (caught) {
      if (sequence !== saveSequence.current) return;
      // The request keeps the last definition the store accepted.
      setError(storeMessage(caught));
    }
  }, [canSave, request.id, updateRequest]);

  const change = (next: Form) => {
    setForm(next);
    setError(null);
    const checked = validateRequestOutputs(outputsOf(next));
    const clash = checked.ok && checked.outputs.enabled
      && checked.outputs.values.some(value => {
        const owner = outputIndex.get(value.name);
        return owner?.enabled && owner.requestId !== request.id;
      });
    if (checked.ok && !clash) void commit(next);
  };

  const toggle = (enabled: boolean) => {
    if (!form) {
      const initial = formOf({ ...defaultRequestOutputs(), enabled })!;
      change(initial);
      return;
    }
    change({ ...form, enabled });
  };

  const updateRow = (index: number, patch: Partial<FormRow>) => {
    if (!form) return;
    const rows = form.rows.map((row, at) => (at === index ? { ...row, ...patch } : row));
    let expiresIn = form.expiresIn;
    // Keep the expiry field next to the first JSON field while it still points at the old sibling.
    const before = form.rows[index];
    if (index === form.rows.findIndex(row => row.kind === 'json') && before.kind === 'json' && patch.path !== undefined) {
      try {
        if (expiresIn === siblingPointer(before.path, 'expires_in')) expiresIn = siblingPointer(patch.path, 'expires_in');
      } catch {
        // An unfinished pointer leaves the expiry field as it is.
      }
    }
    change({ ...form, rows, expiresIn });
  };

  const clearCached = async () => {
    if (typeof window.api.outputsClear !== 'function') return;
    await window.api.outputsClear({ requestId: request.id });
    await loadStatus();
  };

  const shownError = error ?? problem;
  const enabled = form?.enabled === true;

  return (
    <div className="p-4 space-y-4 text-xs text-[var(--color-text)]" data-testid="request-outputs">
      <label className="flex items-center gap-2">
        <input type="checkbox" data-testid="request-outputs-enabled" checked={enabled} disabled={!canSave} onChange={event => toggle(event.target.checked)} />
        Use this request&apos;s response as variables
      </label>
      <p className="text-[var(--color-text-muted)]">
        Any request can use these values as {'{{name}}'}, for example as its Bearer token. A request that needs them fetches
        them by sending this request first, and again once they are older than the refresh time. Values are kept in memory only.
      </p>
      {!canSave && <p className="text-[var(--color-warning)]">Save this request to the collection to give it outputs.</p>}
      {form && (
        <div className={`space-y-4 ${enabled ? '' : 'opacity-60'}`}>
          <div className="space-y-2" role="group" aria-label="Output values">
            <div className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,1.4fr)_auto] gap-2 text-[var(--color-text-muted)]">
              <span>Variable name</span><span>From</span><span>JSON field or header name</span><span />
            </div>
            {form.rows.map((row, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,1.4fr)_auto] gap-2 items-center">
                <input className={inputClass} data-testid={`request-output-name-${index}`} aria-label={`Output name ${index + 1}`} value={row.name}
                  placeholder="api_token" onChange={event => updateRow(index, { name: event.target.value })} />
                <select className={inputClass} data-testid={`request-output-source-${index}`} aria-label={`Output source ${index + 1}`} value={row.kind}
                  onChange={event => {
                    const kind = event.target.value as SourceKind;
                    updateRow(index, { kind, path: kind === 'json' ? '/access_token' : kind === 'header' ? '' : '' });
                  }}>
                  <option value="json">JSON field</option>
                  <option value="header">Response header</option>
                  <option value="body">Whole body</option>
                </select>
                {row.kind === 'body'
                  ? <span className="text-[var(--color-text-muted)]">The whole response body, trimmed</span>
                  : <input className={inputClass} data-testid={`request-output-path-${index}`} aria-label={`Output ${row.kind === 'json' ? 'JSON field' : 'header name'} ${index + 1}`}
                      value={row.path} placeholder={row.kind === 'json' ? '/access_token' : 'X-Session-Token'}
                      onChange={event => updateRow(index, { path: event.target.value })} />}
                <button type="button" className="px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
                  aria-label={`Remove output ${index + 1}`} onClick={() => change({ ...form, rows: form.rows.filter((_, at) => at !== index) })}>
                  Remove
                </button>
              </div>
            ))}
            {form.rows.length < OUTPUT_LIMITS.maxValues && (
              <button type="button" data-testid="request-outputs-add" className="px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-primary)]"
                onClick={() => change({ ...form, rows: [...form.rows, { name: '', kind: 'json', path: '' }] })}>
                Add output
              </button>
            )}
          </div>

          <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-x-3 gap-y-2 items-center">
            <label htmlFor="request-outputs-refresh-seconds">Refresh after (seconds)</label>
            <input id="request-outputs-refresh-seconds" className={`${inputClass} max-w-[140px]`} data-testid="request-outputs-refresh-seconds" inputMode="numeric"
              value={form.seconds} onChange={event => change({ ...form, seconds: event.target.value })} />
            <label htmlFor="request-outputs-expires-pointer">Expiry field (seconds)</label>
            <div className="space-y-1">
              <input id="request-outputs-expires-pointer" className={inputClass} data-testid="request-outputs-expires-pointer" placeholder="Leave empty to use only the refresh time"
                value={form.expiresIn} onChange={event => change({ ...form, expiresIn: event.target.value })} />
              <p className="text-[var(--color-text-muted)]">When the response gives a shorter lifetime here (such as expires_in), values are fetched again sooner.</p>
            </div>
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" data-testid="request-outputs-resend-401" checked={form.resendOn401} onChange={event => change({ ...form, resendOn401: event.target.checked })} />
            After HTTP 401, get new values and send the request once more
          </label>

          {shownError && <div role="alert" data-testid="request-outputs-error" className="px-3 py-2 rounded border border-[var(--color-error)] text-[var(--color-error)]">{shownError} Not saved.</div>}
          {shadowed.map(item => (
            <p key={item.name} className="text-[var(--color-warning)]" data-testid="request-outputs-shadow">
              {`{{${item.name}}}`} is also set in environment &ldquo;{item.environment}&rdquo;. Requests use the fetched value.
            </p>
          ))}

          {request.outputs?.enabled && (
            <div className="flex items-center gap-3">
              <div role="status" data-testid="request-outputs-status" className="flex-1 text-[var(--color-text-muted)]">{statusText(status, environmentName)}</div>
              <button type="button" data-testid="request-outputs-clear" className="px-2 py-1 rounded border border-[var(--color-border)]" onClick={() => { void clearCached(); }}>
                Clear cached values
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
