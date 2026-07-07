import React, { useEffect, useMemo, useState } from 'react';
import { CORE_ENVIRONMENT_ID, Environment, EnvironmentVariable } from '@shared/types';
import { useEnvironmentStore } from '../stores';
import { createId } from '../utils/id';

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

function isDescendantOf(candidateId: string, ancestorId: string, environments: Environment[]): boolean {
  if (candidateId === ancestorId) return true;

  const byId = new Map(environments.map(env => [env.id, env]));
  let current = byId.get(candidateId);
  const seen = new Set<string>();

  while (current?.parentId) {
    if (seen.has(current.id)) break;
    seen.add(current.id);

    if (current.parentId === ancestorId) return true;
    current = byId.get(current.parentId);
  }

  return false;
}

export function EnvironmentEditor() {
  const {
    editor,
    environments,
    activeEnvironmentId,
    closeEditor,
    openEditor,
    openCreateEditor,
    refreshEnvironments,
    setActiveEnvironment,
  } = useEnvironmentStore();

  const [draft, setDraft] = useState<DraftState>({
    name: '',
    parentId: CORE_ENVIRONMENT_ID,
    variables: [],
  });
  const [saving, setSaving] = useState(false);

  const currentEnvironment = useMemo(() => {
    if (editor.mode === 'edit' && editor.editingEnvironmentId) {
      return environments.find(env => env.id === editor.editingEnvironmentId) ?? null;
    }

    return null;
  }, [editor.editingEnvironmentId, editor.mode, environments]);

  const selectedParent = useMemo(() => {
    if (editor.mode === 'create') {
      return environments.find(env => env.id === draft.parentId) ?? null;
    }

    return environments.find(env => env.id === draft.parentId) ?? null;
  }, [draft.parentId, editor.mode, environments]);

  useEffect(() => {
    if (!editor.isOpen) return;

    if (editor.mode === 'edit' && currentEnvironment) {
      setDraft({
        name: currentEnvironment.name,
        parentId: currentEnvironment.parentId ?? CORE_ENVIRONMENT_ID,
        variables: currentEnvironment.variables.length > 0
          ? currentEnvironment.variables.map(variable => createDraftVariable(variable))
          : [createEmptyVariable()],
      });
      return;
    }

    if (editor.mode === 'create') {
      const parentId = editor.parentId ?? activeEnvironmentId ?? CORE_ENVIRONMENT_ID;
      const parent = environments.find(env => env.id === parentId);

      setDraft({
        name: `Child of ${parent?.name ?? 'Core'}`,
        parentId,
        variables: [createEmptyVariable()],
      });
    }
  }, [activeEnvironmentId, currentEnvironment, editor.isOpen, editor.mode, editor.parentId, environments]);

  if (!editor.isOpen) return null;

  const isCore = editor.mode === 'edit' && currentEnvironment?.id === CORE_ENVIRONMENT_ID;
  const parentOptions = editor.mode === 'edit'
    ? environments.filter(env => !currentEnvironment || !isDescendantOf(env.id, currentEnvironment.id, environments))
    : environments;

  const handleClose = () => {
    setSaving(false);
    closeEditor();
  };

  const handleSave = async () => {
    const name = draft.name.trim();
    if (!name || saving) return;

    setSaving(true);

    try {
      const variables = normalizeVariables(draft.variables);

      if (editor.mode === 'create') {
        const created = await window.api.envCreate({
          name,
          parentId: draft.parentId || CORE_ENVIRONMENT_ID,
          variables,
        });
        await refreshEnvironments();
        if (created?.id) {
          setActiveEnvironment(created.id);
          await window.api.envSwitch(created.id);
          openEditor(created.id);
        }
        return;
      }

      if (!currentEnvironment) return;

      await window.api.envUpdate(currentEnvironment.id, {
        name,
        parentId: currentEnvironment.id === CORE_ENVIRONMENT_ID ? undefined : draft.parentId || CORE_ENVIRONMENT_ID,
        variables,
      });

      await refreshEnvironments();
      openEditor(currentEnvironment.id);
    } catch (error) {
      console.error('Failed to save environment:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentEnvironment || isCore || saving) return;

    setSaving(true);
    try {
      await window.api.envDelete(currentEnvironment.id);
      await refreshEnvironments();
      setActiveEnvironment(CORE_ENVIRONMENT_ID);
      await window.api.envSwitch(CORE_ENVIRONMENT_ID);
      handleClose();
    } catch (error) {
      console.error('Failed to delete environment:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateChild = () => {
    openCreateEditor(currentEnvironment?.id ?? activeEnvironmentId ?? CORE_ENVIRONMENT_ID);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6" data-testid="environment-editor-overlay" onMouseDown={handleClose}>
      <div
        className="w-full max-w-5xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
        data-testid="environment-editor"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-[var(--color-text)]">
              {editor.mode === 'create' ? 'Create Environment' : 'Edit Environment'}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {editor.mode === 'create' ? 'Create a child environment' : (isCore ? 'Core is the root environment' : 'Edit environment variables and inheritance')}
            </div>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
            onClick={handleClose}
            data-testid="environment-editor-close"
          >
            Close
          </button>
        </div>

        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-xs text-[var(--color-text-muted)]">Name</span>
              <input
                data-testid="environment-editor-name"
                type="text"
                value={draft.name}
                onChange={e => setDraft(current => ({ ...current, name: e.target.value }))}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-[var(--color-text-muted)]">Parent</span>
              <select
                data-testid="environment-editor-parent"
                value={draft.parentId}
                disabled={isCore}
                onChange={e => setDraft(current => ({ ...current, parentId: e.target.value }))}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value={CORE_ENVIRONMENT_ID}>Core</option>
                {parentOptions
                  .filter(env => env.id !== CORE_ENVIRONMENT_ID)
                  .filter(env => editor.mode === 'create' || !currentEnvironment || env.id !== currentEnvironment.id)
                  .map(env => (
                    <option key={env.id} value={env.id}>{env.name}</option>
                  ))}
              </select>
            </label>

            {editor.mode === 'edit' && (
              <button
                type="button"
                onClick={handleCreateChild}
                className="w-full rounded border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
              >
                Create child environment
              </button>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-[var(--color-text-muted)]">Variables</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">Children inherit from parents, and child values override parent values.</div>
              </div>
              <button
                type="button"
                data-testid="environment-editor-add-variable"
                onClick={() => setDraft(current => ({ ...current, variables: [...current.variables, createEmptyVariable()] }))}
                className="rounded bg-[var(--color-surface-hover)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-active)]"
              >
                + Add variable
              </button>
            </div>

            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1" data-testid="environment-editor-variables">
              {draft.variables.map((variable, index) => (
                <div key={variable.id} className="grid gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)_110px_auto]">
                  <input
                    aria-label={`Variable key ${index + 1}`}
                    placeholder="Key"
                    value={variable.key}
                    onChange={e => setDraft(current => {
                      const next = [...current.variables];
                      next[index] = { ...next[index], key: e.target.value };
                      return { ...current, variables: next };
                    })}
                    className="min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                  />
                  <input
                    aria-label={`Variable value ${index + 1}`}
                    placeholder="Value"
                    type={variable.type === 'secret' ? 'password' : 'text'}
                    value={variable.value}
                    onChange={e => setDraft(current => {
                      const next = [...current.variables];
                      next[index] = { ...next[index], value: e.target.value };
                      return { ...current, variables: next };
                    })}
                    className="min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                  />
                  <select
                    aria-label={`Variable type ${index + 1}`}
                    value={variable.type}
                    onChange={e => setDraft(current => {
                      const next = [...current.variables];
                      next[index] = { ...next[index], type: e.target.value as EnvironmentVariable['type'] };
                      return { ...current, variables: next };
                    })}
                    className="min-w-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
                  >
                    <option value="standard">Standard</option>
                    <option value="secret">Secret</option>
                  </select>
                  <button
                    type="button"
                    aria-label={`Remove variable ${index + 1}`}
                    onClick={() => setDraft(current => ({
                      ...current,
                      variables: current.variables.filter((_, currentIndex) => currentIndex !== index),
                    }))}
                    className="rounded px-2 py-1 text-sm text-[var(--color-error)] hover:bg-[var(--color-surface-hover)]"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] px-4 py-3">
          <div className="text-xs text-[var(--color-text-muted)]">
            {selectedParent ? `Parent: ${selectedParent.name}` : 'No parent selected'}
          </div>
          <div className="flex items-center gap-2">
            {!isCore && editor.mode === 'edit' && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="rounded border border-[var(--color-error)] px-3 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={handleClose}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.name.trim()}
              className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : editor.mode === 'create' ? 'Create Environment' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
