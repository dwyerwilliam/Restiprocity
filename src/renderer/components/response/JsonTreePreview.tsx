import React, { useCallback, useMemo, useState } from 'react';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === 'string') return <span className="text-[var(--color-json-value)]">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-[var(--color-json-number)]">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-[var(--color-json-boolean)]">{String(value)}</span>;
  if (value === null) return <span className="text-[var(--color-json-null)]">null</span>;
  return <span className="text-[var(--color-text-muted)]">{String(value)}</span>;
}

function JsonTreeNode({ value, path, label, depth, collapsedPaths, onToggle }: {
  value: unknown; path: string; label?: string; depth: number; collapsedPaths: Set<string>; onToggle: (path: string) => void;
}) {
  const isArray = Array.isArray(value);
  const isObject = isPlainObject(value);
  const isContainer = isArray || isObject;
  const isCollapsed = collapsedPaths.has(path);
  const indentStyle = { paddingLeft: `${depth * 16}px` };

  if (!isContainer) {
    return <div className="leading-5 whitespace-pre-wrap break-all" style={indentStyle}>{label !== undefined && <span className="text-[var(--color-json-key)]">{label}: </span>}<JsonPrimitive value={value} /></div>;
  }

  const entries = isArray ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  if (entries.length === 0) {
    return <div className="leading-5 whitespace-pre-wrap break-all" style={indentStyle}>{label !== undefined && <span className="text-[var(--color-json-key)]">{label}: </span>}<span className="text-[var(--color-json-structural)]">{isArray ? '[]' : '{}'}</span></div>;
  }

  return <div>
    <button type="button" data-testid={`json-toggle-${path}`} onClick={() => onToggle(path)} className="flex w-full items-start gap-1 rounded text-left leading-5 whitespace-pre-wrap break-all hover:bg-[var(--color-surface-hover)]/40" style={indentStyle} aria-label={isCollapsed ? `Expand ${label ?? 'root'}` : `Collapse ${label ?? 'root'}`}>
      <span className="text-[var(--color-json-structural)]">{isCollapsed ? '▸' : '▾'}</span>
      {label !== undefined && <span className="text-[var(--color-json-key)]">{label}: </span>}
      <span className="text-[var(--color-json-structural)]">{isArray ? '[' : '{'}</span>
      {isCollapsed && <span className="text-[var(--color-text-muted)]">…</span>}
      {isCollapsed && <span className="text-[var(--color-text-muted)]">{entries.length}</span>}
      {isCollapsed && <span className="text-[var(--color-json-structural)]">{isArray ? ']' : '}'}</span>}
    </button>
    {!isCollapsed && <div>{entries.map(([childKey, childValue]) => <JsonTreeNode key={`${path}.${childKey}`} value={childValue} path={`${path}.${childKey}`} label={isArray ? childKey : JSON.stringify(childKey)} depth={depth + 1} collapsedPaths={collapsedPaths} onToggle={onToggle} />)}<div className="leading-5 whitespace-pre-wrap break-all" style={indentStyle}><span className="text-[var(--color-json-structural)]">{isArray ? ']' : '}'}</span></div></div>}
  </div>;
}

export function JsonTreePreview({ text }: { text: string }) {
  const value = useMemo(() => JSON.parse(text) as unknown, [text]);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const onToggle = useCallback((path: string) => setCollapsedPaths(current => {
    const next = new Set(current);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  }), []);

  return <div className="text-xs font-mono leading-5" data-testid="response-json-viewer"><JsonTreeNode value={value} path="root" depth={0} collapsedPaths={collapsedPaths} onToggle={onToggle} /></div>;
}
