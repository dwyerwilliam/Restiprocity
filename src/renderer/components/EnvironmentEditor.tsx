import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CORE_ENVIRONMENT_ID, Environment, EnvironmentVariable } from '@shared/types';
import { useEnvironmentStore } from '../stores';
import { createId } from '../utils/id';
import { InterpolationEditor } from './InterpolationEditor';

type DraftState = {
  name: string;
  parentId: string;
  variables: DraftVariable[];
};

type DraftVariable = EnvironmentVariable & { id: string };

function createEmptyVariable(): DraftVariable {
  return { id: createId(), key: '', value: '', type: 'standard' };
}

function createDraftVariable(variable: EnvironmentVariable): DraftVariable {
  return { id: createId(), ...variable };
}

function normalizeVariables(variables: DraftVariable[]): EnvironmentVariable[] {
  return variables
    .map(variable => ({
      key: variable.key.trim(),
      value: variable.value,
      type: variable.type,
    }))
    .filter(variable => variable.key.length > 0);
}

type EnvironmentTreeNode = {
  environment: Environment;
  children: EnvironmentTreeNode[];
};

function buildEnvironmentTree(environments: Environment[]): EnvironmentTreeNode[] {
  const byId = new Map(environments.map(environment => [environment.id, environment]));
  const childrenByParent = new Map<string, Environment[]>();

  for (const environment of environments) {
    const parentId = environment.parentId ?? '';
    const nextChildren = childrenByParent.get(parentId) ?? [];
    nextChildren.push(environment);
    childrenByParent.set(parentId, nextChildren);
  }

  const sortEnvironments = (items: Environment[]) => [...items].sort((left, right) => {
    if (left.id === CORE_ENVIRONMENT_ID) return -1;
    if (right.id === CORE_ENVIRONMENT_ID) return 1;
    return left.name.localeCompare(right.name);
  });

  const buildNode = (environment: Environment, seen = new Set<string>()): EnvironmentTreeNode => {
    if (seen.has(environment.id)) {
      return { environment, children: [] };
    }

    const nextSeen = new Set(seen);
    nextSeen.add(environment.id);

    return {
      environment,
      children: sortEnvironments(childrenByParent.get(environment.id) ?? [])
        .map(child => buildNode(child, nextSeen)),
    };
  };

  const roots = sortEnvironments(
    environments.filter(environment => !environment.parentId || !byId.has(environment.parentId)),
  );

  return roots.map(root => buildNode(root));
}

function EnvironmentTreeItem({
  node,
  selectedId,
  activeId,
  onSelect,
  depth = 0,
}: {
  node: EnvironmentTreeNode;
  selectedId: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const isSelected = node.environment.id === selectedId;

  return (
    <div>
      <button
        type="button"
        data-testid={`environment-editor-tree-item-${node.environment.id}`}
        aria-current={isSelected ? 'true' : undefined}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
          isSelected
            ? 'bg-[var(--color-primary)] text-[var(--color-bg)]'
            : 'text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node.environment.id)}
      >
        <span className={`inline-flex h-4 w-4 items-center justify-center text-[10px] ${isSelected ? 'text-[var(--color-bg)]' : 'text-[var(--color-text-muted)]'}`}>
          {node.environment.id === CORE_ENVIRONMENT_ID ? '◉' : '•'}
        </span>
        <span className="min-w-0 flex-1 truncate">{node.environment.name}</span>
        {node.environment.id === activeId && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${isSelected ? 'bg-white/20 text-[var(--color-bg)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-primary)]'}`}>
            active
          </span>
        )}
        {node.environment.id === CORE_ENVIRONMENT_ID && node.environment.id !== activeId && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${isSelected ? 'bg-white/15 text-[var(--color-bg)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'}`}>
            root
          </span>
        )}
      </button>
      {node.children.length > 0 && (
        <div className="ml-2 border-l border-[var(--color-border)] pl-2">
          {node.children.map(child => (
            <EnvironmentTreeItem
              key={child.environment.id}
              node={child}
              selectedId={selectedId}
              activeId={activeId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function EnvironmentEditor() {
  const { editor } = useEnvironmentStore();
  const dialogRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!editor.isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { previousFocus?.focus(); };
  }, [editor.isOpen]);

  if (!editor.isOpen) return null;

  return (
    <div ref={dialogRef} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ) ?? []).filter(element => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }}>
      <EnvironmentForm key={editor.mode + ':' + (editor.editingEnvironmentId ?? editor.parentId)} />
    </div>
  );
}

function EnvironmentForm() {
  const {
    editor, environments, activeEnvironmentId, environmentReady, environmentPending, environmentError,
    closeEditor, openEditor, openCreateEditor, saveEnvironment, setActiveEnvironment,
    deleteEnvironment, refreshEnvironments,
  } = useEnvironmentStore();
  const currentEnvironment = environments.find(env => env.id === editor.editingEnvironmentId);
  const initialDraft = (): DraftState => ({
    name: editor.mode === 'create'
      ? `Child of ${environments.find(env => env.id === editor.parentId)?.name ?? 'Core'}`
      : currentEnvironment?.name ?? '',
    parentId: editor.mode === 'create'
      ? editor.parentId ?? CORE_ENVIRONMENT_ID
      : currentEnvironment?.parentId ?? '',
    variables: currentEnvironment?.variables.length
      ? currentEnvironment.variables.map(createDraftVariable)
      : [createEmptyVariable()],
  });
  const [draft, setDraft] = useState(initialDraft);
  const serializeDraft = (value: DraftState) => JSON.stringify({
    ...value, variables: value.variables.map(({ key, value, type }) => ({ key, value, type })),
  });
  const [baseline, setBaseline] = useState(() => serializeDraft(draft));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [validationError, setValidationError] = useState('');
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [showInherited, setShowInherited] = useState(true);
  const [interpolationId, setInterpolationId] = useState<string | null>(null);
  const interpolationTrigger = useRef<HTMLButtonElement | null>(null);
  const closeInterpolation = () => { setInterpolationId(null); requestAnimationFrame(() => interpolationTrigger.current?.focus()); };
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);
  const busy = saving || environmentPending;
  const dirty = baseline !== serializeDraft(draft);
  const isCore = currentEnvironment?.id === CORE_ENVIRONMENT_ID;
  const selectedId = currentEnvironment?.id ?? draft.parentId;
  const hasChildren = environments.some(env => env.parentId === currentEnvironment?.id);
  const environmentTree = useMemo(() => buildEnvironmentTree(environments), [environments]);
  const parent = environments.find(env => env.id === draft.parentId);
  const inherited = useMemo(() => {
    const values = new Map<string, EnvironmentVariable & { source: string }>();
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const env = environments.find(item => item.id === id);
      if (!env) return;
      if (env.parentId) visit(env.parentId);
      env.variables.forEach(variable => values.set(variable.key, { ...variable, source: env.name }));
    };
    if (draft.parentId) visit(draft.parentId);
    return [...values.values()];
  }, [draft.parentId, environments]);

  const navigate = (action: () => void) => {
    if (busy) return;
    if (dirty) setPendingNavigation(() => action);
    else action();
  };
  const handleSave = async () => {
    if (busy || !draft.name.trim()) return;
    const keys = new Set<string>();
    for (const variable of draft.variables) {
      const key = variable.key.trim();
      if (!key && variable.value) {
        setValidationError('Enter a key for every variable that has a value.');
        return;
      }
      if (key && keys.has(key)) {
        setValidationError('Variable keys must be unique within this environment.');
        return;
      }
      if (key) keys.add(key);
    }
    setValidationError('');
    setStatus('');
    setSaving(true);
    try {
      const saved = await saveEnvironment(currentEnvironment?.id ?? null, {
        name: draft.name.trim(),
        ...(draft.parentId ? { parentId: draft.parentId } : {}),
        variables: normalizeVariables(draft.variables),
      });
      if (!saved) return;
      setBaseline(serializeDraft(draft));
      setStatus('Changes saved.');
      if (editor.mode === 'create') {
        // The create is committed. Open that record even if activating it fails,
        // so retrying never creates a second environment.
        openEditor(saved.id);
        await setActiveEnvironment(saved.id);
      }
    } finally {
      setSaving(false);
    }
  };
  const handleDelete = async () => {
    if (!currentEnvironment || isCore || hasChildren || busy) return;
    setSaving(true);
    try {
      const nextId = await deleteEnvironment(currentEnvironment.id);
      if (nextId) openEditor(nextId);
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  };
  const updateVariable = (id: string, patch: Partial<EnvironmentVariable>) => {
    setStatus('');
    setDraft(current => ({
      ...current, variables: current.variables.map(variable => variable.id === id ? { ...variable, ...patch } : variable),
    }));
  };
  const buttonClass = 'rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50';
  const inputClass = 'min-w-0 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-3 py-4"
      data-testid="environment-editor-overlay" onMouseDown={() => { if (!interpolationId) navigate(closeEditor); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="environment-editor-title"
        className="max-h-full w-full max-w-5xl overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        data-testid="environment-editor" onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (pendingNavigation) setPendingNavigation(null);
            else if (confirmDelete) setConfirmDelete(false);
            else navigate(closeEditor);
          }
        }}>
        <fieldset hidden={interpolationId !== null} disabled={busy} className="min-w-0">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <h2 id="environment-editor-title" className="text-sm font-semibold text-[var(--color-text)]">
                {editor.mode === 'create' ? 'Create Environment' : 'Edit Environment'}
              </h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Use {'{{key}}'} in requests. Child variables override inherited values.
              </p>
            </div>
            <button type="button" className={buttonClass} data-testid="environment-editor-close"
              onClick={() => navigate(closeEditor)}>Close</button>
          </div>

          {pendingNavigation && (
            <div role="alert" className="m-4 space-y-2 rounded border border-[var(--color-border)] p-3 text-sm text-[var(--color-text)]">
              <p>You have unsaved changes. Discard them to continue?</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={buttonClass} onClick={() => setPendingNavigation(null)}>Keep editing</button>
                <button type="button" className={buttonClass} onClick={() => {
                  const action = pendingNavigation;
                  setPendingNavigation(null);
                  action();
                }}>Discard changes</button>
              </div>
            </div>
          )}
          {(validationError || environmentError) && (
            <div role="alert" className="mx-4 mt-3 space-y-2 text-sm text-[var(--color-error)]">
              <p>{validationError || environmentError}</p>
              {environmentError && <button type="button" className={buttonClass}
                onClick={() => void refreshEnvironments()}>Refresh environments</button>}
            </div>
          )}

          <div className="grid gap-4 p-4 md:grid-cols-[240px_minmax(0,1fr)]">
            <div className="min-w-0 space-y-3">
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <h3 className="text-xs font-semibold text-[var(--color-text)]">Environments</h3>
                <p className="mb-3 text-xs text-[var(--color-text-muted)]">Select one to edit. Use “Switch to environment” to activate it.</p>
                <div className="max-h-48 space-y-1 overflow-auto md:max-h-80" data-testid="environment-editor-tree">
                  {environmentTree.map(node => (
                    <EnvironmentTreeItem key={node.environment.id} node={node} selectedId={selectedId} activeId={activeEnvironmentId}
                      onSelect={id => { if (id !== currentEnvironment?.id) navigate(() => openEditor(id)); }} />
                  ))}
                </div>
              </div>
              <button type="button" className={buttonClass}
                onClick={() => navigate(() => openCreateEditor(selectedId ?? CORE_ENVIRONMENT_ID))}>
                Create child environment
              </button>
              <p className="text-xs text-[var(--color-text-muted)]">
                Active: {environments.find(env => env.id === activeEnvironmentId)?.name ?? 'None'}
              </p>
              {editor.mode === 'edit' && currentEnvironment && (
                <button type="button" className={buttonClass} disabled={activeEnvironmentId === currentEnvironment.id}
                  onClick={() => { setStatus(''); void setActiveEnvironment(currentEnvironment.id); }}>
                  {activeEnvironmentId === currentEnvironment.id ? 'Active environment' : 'Switch to environment'}
                </button>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-[var(--color-text-muted)]">Environment name</span>
                <input ref={nameRef} data-testid="environment-editor-name" className={inputClass} value={draft.name}
                  onChange={event => { setStatus(''); setDraft(current => ({ ...current, name: event.target.value })); }} />
              </label>
              <p className="text-xs text-[var(--color-text-muted)]">
                {isCore ? 'Core is the root environment.' : `Parent: ${parent?.name ?? 'None'}`}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[var(--color-text)]">Environment variables ({draft.variables.filter(variable => variable.key.trim()).length})</h3>
                <button type="button" className={buttonClass} data-testid="environment-editor-add-variable"
                  onClick={() => setDraft(current => ({ ...current, variables: [...current.variables, createEmptyVariable()] }))}>+ Add variable</button>
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">
                Secret values are masked here and stored as plain text in local environment files.
              </p>
              <div className="space-y-2" data-testid="environment-editor-variables">
                {draft.variables.map((variable, index) => (
                  <div key={variable.id} className="grid min-w-0 gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_110px_auto]">
                    <input className={inputClass} aria-label={`Variable key ${index + 1}`} placeholder="Key" value={variable.key}
                      onChange={event => updateVariable(variable.id, { key: event.target.value })} />
                    {/[\r\n]/.test(variable.value) ? (
                      <button type="button" className={inputClass + ' text-left'} aria-label={`Variable value ${index + 1}: multiline`}
                        onClick={event => { interpolationTrigger.current = event.currentTarget; setInterpolationId(variable.id); }}>
                        {variable.type === 'secret' ? '•••••••• (multiline)' : 'Multiline value — edit interpolation'}
                      </button>
                    ) : (
                      <input className={inputClass} aria-label={`Variable value ${index + 1}`} placeholder="Value"
                        type={variable.type === 'secret' && !revealed.has(variable.id) ? 'password' : 'text'}
                        autoComplete="off" spellCheck={false} value={variable.value}
                        onChange={event => updateVariable(variable.id, { value: event.target.value })} />
                    )}
                    <select className={inputClass} aria-label={`Variable type ${index + 1}`} value={variable.type}
                      onChange={event => {
                        setRevealed(current => { const next = new Set(current); next.delete(variable.id); return next; });
                        updateVariable(variable.id, { type: event.target.value as EnvironmentVariable['type'] });
                      }}>
                      <option value="standard">Standard</option>
                      <option value="secret">Secret</option>
                    </select>
                    <div className="flex flex-wrap gap-2">
                      {variable.type === 'secret' && <button type="button" className={buttonClass}
                        aria-label={`${revealed.has(variable.id) ? 'Hide' : 'Show'} secret ${index + 1}`}
                        onClick={() => setRevealed(current => {
                          const next = new Set(current);
                          if (next.has(variable.id)) next.delete(variable.id); else next.add(variable.id);
                          return next;
                        })}>{revealed.has(variable.id) ? 'Hide' : 'Show'}</button>}
                      <button type="button" className={buttonClass} aria-label={`Edit interpolation ${index + 1}`}
                        onClick={event => { interpolationTrigger.current = event.currentTarget; setInterpolationId(variable.id); }}>Edit interpolation</button>
                      <button type="button" className={buttonClass} aria-label={`Remove variable ${index + 1}`}
                        onClick={() => setDraft(current => ({ ...current, variables: current.variables.filter(item => item.id !== variable.id) }))}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
              {inherited.length > 0 && (
                <div className="space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]" data-testid="environment-editor-inherited">
                  <button type="button" aria-expanded={showInherited} className="font-semibold text-[var(--color-text)]" onClick={() => setShowInherited(value => !value)}>
                    {showInherited ? '▾' : '▸'} Inherited variables ({inherited.length})
                  </button>
                  {showInherited && inherited.map(variable => {
                    const overridden = draft.variables.some(own => own.key.trim() === variable.key);
                    return <div key={variable.key} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
                      <div className="min-w-0 break-all"><span className="font-mono font-medium text-[var(--color-text)]">{variable.key}</span>
                        <span className="font-mono"> = {variable.type === 'secret' ? '••••••••' : variable.value}</span>
                        <span className="ml-2 rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5">from {variable.source}</span>
                      </div>
                      {overridden ? <span className="text-[var(--color-warning)]">Overridden locally</span> :
                        <button type="button" className={buttonClass} onClick={() => setDraft(current => ({ ...current,
                          variables: [...current.variables.filter(item => item.key || item.value), createDraftVariable(variable)],
                        }))}>Override {variable.key}</button>}
                    </div>;
                  })}
                </div>
              )}
              {editor.mode === 'edit' && !isCore && currentEnvironment && (
                <div className="space-y-2">
                  <button type="button" className={buttonClass} disabled={hasChildren} onClick={() => setConfirmDelete(true)}>Delete environment</button>
                  {hasChildren && <p className="text-xs text-[var(--color-text-muted)]">Delete child environments first to preserve their inheritance.</p>}
                  {confirmDelete && <div role="alert" className="space-y-2 text-sm text-[var(--color-text)]">
                    <p>Delete “{currentEnvironment.name}”? Its variables will be removed.
                      {activeEnvironmentId === currentEnvironment.id ? ' The active environment will return to its parent or Core.' : ''}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={buttonClass} onClick={() => setConfirmDelete(false)}>Keep environment</button>
                      <button type="button" className={buttonClass} onClick={() => void handleDelete()}>Confirm delete</button>
                    </div>
                  </div>}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3">
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              {busy ? 'Saving environment selection or changes…' : dirty ? 'Unsaved changes' : status}
            </p>
            <div className="flex gap-2">
              <button type="button" className={buttonClass} onClick={() => navigate(closeEditor)}>Cancel</button>
              <button type="button" className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs text-[var(--color-bg)] disabled:opacity-50"
                disabled={!draft.name.trim() || (editor.mode === 'edit' && !currentEnvironment)}
                onClick={() => void handleSave()}>
                {saving ? 'Saving…' : editor.mode === 'create' ? 'Create Environment' : 'Save Changes'}
              </button>
            </div>
          </div>
        </fieldset>
        {interpolationId && draft.variables.find(variable => variable.id === interpolationId) && (
          <InterpolationEditor environments={environments} ready={environmentReady && !environmentPending} draftId={currentEnvironment?.id ?? null}
            draftName={draft.name || 'Untitled environment'} parentId={draft.parentId}
            variables={draft.variables} selected={draft.variables.find(variable => variable.id === interpolationId)!}
            onApply={value => { updateVariable(interpolationId, { value }); closeInterpolation(); }} onCancel={closeInterpolation} onRetry={() => void refreshEnvironments()} />
        )}
      </div>
    </div>
  );
}
