import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createVariableContext } from '@shared/variableContext';
import { BUILT_IN_VARIABLE_KEYS } from '@shared/urlVariables';
import type { Environment, EnvironmentVariable } from '@shared/types';

type DraftVariable = EnvironmentVariable & { id: string };
type Props = {
  environments: Environment[];
  ready: boolean;
  draftId: string | null;
  draftName: string;
  parentId: string;
  variables: DraftVariable[];
  selected: DraftVariable;
  onApply: (value: string) => void;
  onCancel: () => void;
  onRetry: () => void;
};

export function InterpolationEditor({ environments, ready, draftId, draftName, parentId, variables, selected, onApply, onCancel, onRetry }: Props) {
  const [value, setValue] = useState(selected.value);
  const [target, setTarget] = useState(draftId ?? '__draft__');
  const [filter, setFilter] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [sample, setSample] = useState(() => ({ timestamp: Date.now(), randomInt: Math.floor(Math.random() * 1_000_000), uuid: crypto.randomUUID() }));
  const textarea = useRef<HTMLTextAreaElement>(null);
  const firstControl = useRef<HTMLSelectElement>(null);
  useEffect(() => { firstControl.current?.focus(); }, []);
  useEffect(() => {
    const hide = () => { setShowSecret(false); setShowPreview(false); };
    window.addEventListener('blur', hide);
    return () => window.removeEventListener('blur', hide);
  }, []);
  useEffect(() => { setShowSecret(false); setShowPreview(false); }, [target]);
  const effectiveData = useMemo(() => {
    const result = new Map<string, EnvironmentVariable & { source: string }>();
    const seen = new Set<string>();
    const layers: EnvironmentVariable[][] = [];
    const byId = new Map(environments.map(env => [env.id, env]));
    const visit = (id: string | undefined) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      if (id === '__draft__' || (draftId !== null && id === draftId)) {
        visit(parentId);
        layers.push(variables.map(variable => ({ ...variable, key: variable.key.trim(), value: variable.id === selected.id ? value : variable.value })));
        variables.forEach(variable => {
          const key = variable.key.trim();
          if (key) result.set(key, { ...variable, key, value: variable.id === selected.id ? value : variable.value, source: draftName });
        });
        return;
      }
      const environment = byId.get(id);
      if (!environment) return;
      visit(environment.parentId);
      layers.push(environment.variables);
      environment.variables.forEach(variable => result.set(variable.key, { ...variable, source: environment.name }));
    };
    visit(target);
    return { result, layers };
  }, [draftId, draftName, environments, parentId, selected.id, target, value, variables]);
  const { result: effective, layers } = effectiveData;
  useEffect(() => { setShowPreview(false); }, [effective]);
  const duplicate = new Set(variables.map(item => item.key.trim()).filter(Boolean)).size !== variables.filter(item => item.key.trim()).length;
  const key = selected.key.trim();
  const withoutTokens = value.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, '');
  const malformed = withoutTokens.includes('{{') || withoutTokens.includes('}}');
  const sensitiveKeys = new Set([...effective.values()].filter(item => item.type === 'secret').map(item => item.key));
  const preview = useMemo(() => {
    if (!ready) return { error: 'Environments are unavailable or loading. Retry loading before previewing.' };
    if (!key || /[{}\s]/.test(key)) return { error: 'Enter a valid variable key for a preview.' };
    let usesDraft = target === (draftId ?? '__draft__');
    if (draftId && !usesDraft) {
      const seen = new Set<string>();
      let ancestor = environments.find(env => env.id === target)?.parentId;
      while (ancestor && !seen.has(ancestor)) {
        if (ancestor === draftId) { usesDraft = true; break; }
        seen.add(ancestor);
        ancestor = environments.find(env => env.id === ancestor)?.parentId;
      }
    }
    if (duplicate && usesDraft) return { error: 'Resolve duplicate draft keys before previewing.' };
    try {
      const result = createVariableContext([...effective.values()].map(item => [item.key, item.value] as const), sample, sensitiveKeys, layers).resolve('{{' + key + '}}');
      return { result };
    } catch (error) { return { error: error instanceof Error ? error.message : 'Interpolation error.' }; }
  }, [draftId, draftName, duplicate, effective, layers, key, sample, target, ready, environments]);
  const requestClose = () => { if (value !== selected.value) setConfirmDiscard(true); else onCancel(); };
  const insert = (key: string) => {
    if (!textarea.current || (selected.type === 'secret' && !showSecret)) return;
    const input = textarea.current;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = '{{' + key + '}}';
    setValue(current => current.slice(0, start) + text + current.slice(end));
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start + text.length, start + text.length); });
  };
  const button = 'rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]';
  const options = [...new Set([...effective.keys(), ...BUILT_IN_VARIABLE_KEYS])].sort().filter(option => option.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div role="region" aria-label="Interpolation editor" className="space-y-3 p-4 text-sm text-[var(--color-text)]"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (confirmDiscard) setConfirmDiscard(false); else requestClose(); } }}>
      <h2 className="font-semibold">Edit interpolation: {key || 'Unsaved variable'}</h2>
      <label className="block text-xs">Preview environment
        <select ref={firstControl} value={target} onChange={event => setTarget(event.target.value)}
          className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm">
          {!draftId && <option value="__draft__">{draftName} (unsaved)</option>}
          {environments.map(env => <option key={env.id} value={env.id}>{env.id === draftId ? draftName + ' (draft)' : env.name}</option>)}
        </select>
      </label>
      <div className="space-y-1">
        <label htmlFor="interpolation-value" className="text-xs">Stored value</label>
        {selected.type === 'secret' && !showSecret ? (
          <div className="flex items-center gap-2"><span>••••••••</span><button type="button" className={button} onClick={() => setShowSecret(true)}>Reveal and edit</button></div>
        ) : (
          <><textarea ref={textarea} id="interpolation-value" aria-label="Stored value" value={value}
            onChange={event => { setValue(event.target.value); setShowPreview(false); }} rows={4}
            className="block w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-sm" />
            {selected.type === 'secret' && <button type="button" className={button} onClick={() => setShowSecret(false)}>Hide value</button>}</>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-xs">Insert variable</h3>
        <input aria-label="Filter variables" value={filter} onChange={event => setFilter(event.target.value)}
          className="mb-1 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-1 text-xs" placeholder="Filter variables" />
        <div className="max-h-28 overflow-auto rounded border border-[var(--color-border)] p-1">
          {options.length === 0 && <p className="p-2 text-xs">No matching variables.</p>}
          {options.map(option => {
            const valid = !/[{}\s]/.test(option);
            const isBuiltIn = (BUILT_IN_VARIABLE_KEYS as readonly string[]).includes(option);
            return <button key={option} type="button" disabled={!valid || (selected.type === 'secret' && !showSecret)}
              onMouseDown={event => event.preventDefault()} onClick={() => insert(option)}
              className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
              {'{{' + option + '}}'} — {isBuiltIn ? 'Built-in' + (effective.has(option) ? ' (overrides environment value)' : '') : effective.get(option)?.source}{!valid ? ' (cannot be referenced)' : ''}
            </button>;
          })}
        </div>
      </div>
      <div className="space-y-1 rounded border border-[var(--color-border)] p-2 text-xs">
        <div className="font-semibold">Request result (example)</div>
        {!ready && <button type="button" className={button} onClick={onRetry}>Retry environments</button>}
        {malformed && <p>Unmatched or malformed interpolation braces in the stored value.</p>}
        {key && <p>Source: {(BUILT_IN_VARIABLE_KEYS as readonly string[]).includes(key) ? 'Built-in' : effective.get(key)?.source ?? 'Not defined in this environment'}</p>}
        {'error' in preview ? <p role="alert">{preview.error}</p> : <>
          {preview.result && <><div className="break-all font-mono">{preview.result.sensitive && !showPreview ? '•••••••• (contains a secret)' : preview.result.value}</div>
            {preview.result.sensitive && <button type="button" className={button} onClick={() => setShowPreview(current => !current)}>{showPreview ? 'Hide preview' : 'Reveal preview'}</button>}
            <p>References: {preview.result.dependencies.join(', ') || 'none'}</p>
            {preview.result.missing.length > 0 && <p>Unresolved: {preview.result.missing.join(', ')}</p>}</>}
        </>}
        <p className="text-[var(--color-text-muted)]">Dynamic values are examples and may differ when sent.</p>
        <button type="button" className={button} onClick={() => setSample({ timestamp: Date.now(), randomInt: Math.floor(Math.random() * 1_000_000), uuid: crypto.randomUUID() })}>Refresh sample</button>
      </div>
      {confirmDiscard && <div role="alert">Discard changes to this value?
        <div className="mt-2 flex gap-2"><button type="button" className={button} onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          <button type="button" className={button} onClick={onCancel}>Discard value changes</button></div>
      </div>}
      <div className="flex justify-end gap-2">
        <button type="button" className={button} onClick={requestClose}>Cancel</button>
        <button type="button" className={button} onClick={() => onApply(value)}>Apply to draft</button>
      </div>
    </div>
  );
}
