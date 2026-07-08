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
  onSelect,
  depth = 0,
}: {
  node: EnvironmentTreeNode;
  selectedId: string | null;
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
        {node.environment.id === CORE_ENVIRONMENT_ID && (
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

  const draftParentEnvironment = useMemo(() => environments.find(env => env.id === draft.parentId) ?? null, [draft.parentId, environments]);
  const selectedEnvironmentId = editor.mode === 'edit' ? currentEnvironment?.id ?? null : draft.parentId;
  const selectedEnvironment = useMemo(
    () => environments.find(env => env.id === selectedEnvironmentId) ?? null,
    [environments, selectedEnvironmentId],
  );
  const environmentTree = useMemo(() => buildEnvironmentTree(environments), [environments]);

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
      const nextEnvironmentId = currentEnvironment.parentId ?? CORE_ENVIRONMENT_ID;
      setActiveEnvironment(nextEnvironmentId);
      await window.api.envSwitch(nextEnvironmentId);
      openEditor(nextEnvironmentId);
    } catch (error) {
      console.error('Failed to delete environment:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateChild = () => {
    openCreateEditor(selectedEnvironment?.id ?? activeEnvironmentId ?? CORE_ENVIRONMENT_ID);
  };

  const handleSelectEnvironment = (environmentId: string) => {
    openEditor(environmentId);
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

        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-[var(--color-text)]">Hierarchy</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    Click any environment to edit it.
                  </div>
                </div>
                {editor.mode === 'edit' && selectedEnvironment && (
                  <button
                    type="button"
                    onClick={handleCreateChild}
                    className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                  >
                    Create child environment
                  </button>
                )}
              </div>

              <div className="mt-3 space-y-1" data-testid="environment-editor-tree">
                {environmentTree.map(node => (
                  <EnvironmentTreeItem
                    key={node.environment.id}
                    node={node}
                    selectedId={selectedEnvironmentId}
                    onSelect={handleSelectEnvironment}
                  />
                ))}
              </div>
            </div>

            <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              {editor.mode === 'create'
                ? `Creating child of ${draftParentEnvironment?.name ?? 'Core'}`
                : `Editing ${currentEnvironment?.name ?? 'environment'}`}
            </div>
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs text-[var(--color-text-muted)]">Name</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {editor.mode === 'create'
                    ? 'New environment inherits from the selected parent in the hierarchy.'
                    : 'Rename the selected environment and update its variables.'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {editor.mode === 'edit' && !isCore && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={saving}
                    className="rounded border border-[var(--color-error)] px-3 py-1.5 text-xs text-[var(--color-error)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Delete environment
                  </button>
                )}
                <button
                  type="button"
                  data-testid="environment-editor-add-variable"
                  onClick={() => setDraft(current => ({ ...current, variables: [...current.variables, createEmptyVariable()] }))}
                  className="rounded bg-[var(--color-surface-hover)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-active)]"
                >
                  + Add variable
                </button>
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-[var(--color-text-muted)]">Environment name</span>
              <input
                data-testid="environment-editor-name"
                type="text"
                value={draft.name}
                onChange={e => setDraft(current => ({ ...current, name: e.target.value }))}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
              />
            </label>

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
            {draftParentEnvironment ? `Parent: ${draftParentEnvironment.name}` : 'No parent selected'}
          </div>
          <div className="flex items-center gap-2">
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
