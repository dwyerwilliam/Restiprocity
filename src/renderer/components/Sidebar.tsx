import React, { useCallback, useEffect, useState } from 'react';
import { useUiStore, useRequestStore, useEnvironmentStore } from '../stores';
import { Request, RequestGroup, CollectionNode, Environment, HttpMethod } from '../../shared/types';
import { createId } from '../utils/id';

// ─── Inline SVG Icons ────────────────────────────────────────────

function IconFolder({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {open ? (
        <>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <path d="M2 10h20" />
        </>
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      )}
    </svg>
  );
}

function IconRequest({ method }: { method?: HttpMethod }) {
  const colorMap: Record<HttpMethod, string> = {
    GET: 'var(--color-success)',
    POST: 'var(--color-primary)',
    PUT: 'var(--color-warning)',
    PATCH: 'var(--color-accent)',
    DELETE: 'var(--color-error)',
    HEAD: 'var(--color-text-muted)',
    OPTIONS: 'var(--color-text-muted)',
  };
  const color = method ? colorMap[method] : 'var(--color-text-muted)';
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function IconMoveHandle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function IconDuplicate() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function IconCollapse() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

// ─── Context Menu ────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  nodeType: 'request' | 'group';
}

interface DragRequestState {
  requestId: string;
  parentId?: string;
}

interface DropTargetState {
  requestId: string;
  position: 'before' | 'after';
}

function ContextMenu({ x, y, nodeId, nodeName, nodeType, onClose, onRename, onAction, onDelete }: {
  x: number; y: number; nodeId: string; nodeName: string; nodeType: 'request' | 'group';
  onClose: () => void; onRename: (nodeId: string, name: string) => void; onAction: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const handleDelete = useCallback(async () => {
    await onDelete();
    onClose();
  }, [onClose, onDelete]);

  const handleDuplicate = useCallback(async () => {
    await window.api.collectionDuplicate(nodeId);
    onAction();
  }, [nodeId, onAction]);

  const handleRename = useCallback(() => {
    onRename(nodeId, nodeName);
  }, [nodeId, nodeName, onRename]);

  return (
    <div
      className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-lg py-1 min-w-[160px]"
      style={{ left: x, top: y }}
      onClick={onClose}
    >
      <button
        className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--color-surface-hover)]"
        onClick={handleRename}
      >
        <IconEdit /> Rename
      </button>
      <button
        className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--color-surface-hover)]"
        onClick={handleDuplicate}
      >
        <IconDuplicate /> Duplicate
      </button>
      <button
        className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-[var(--color-surface-hover)]"
        onClick={handleDelete}
      >
        <IconTrash /> Delete
      </button>
    </div>
  );
}

// ─── Tree Node ───────────────────────────────────────────────────

interface TreeNodeProps {
  node: CollectionNode;
  allNodes: Map<string, CollectionNode | Request | RequestGroup>;
  depth?: number;
  parentId?: string;
  siblingIds?: string[];
  onNodeChanged?: () => void;
  dragRequest?: DragRequestState | null;
  dropTarget?: DropTargetState | null;
  onDragRequestStart?: (state: DragRequestState) => void;
  onDragRequestOver?: (targetId: string, position: 'before' | 'after') => void;
  onDragRequestDrop?: (targetId: string, position: 'before' | 'after') => Promise<void>;
  onDragRequestEnd?: () => void;
  filterText?: string;
}

function TreeNode({
  node,
  allNodes,
  depth = 0,
  parentId,
  siblingIds = [],
  onNodeChanged,
  dragRequest,
  dropTarget,
  onDragRequestStart,
  onDragRequestOver,
  onDragRequestDrop,
  onDragRequestEnd,
  filterText,
}: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const { selectedNodeId, setSelectedNodeId } = useUiStore();
  const { setCurrentRequest } = useRequestStore();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const isGroup = node.type === 'group';
  const isSelected = selectedNodeId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const isEditing = editingNodeId === node.id;
  const siblingIndex = siblingIds.indexOf(node.id);
  const canDragRequest = !isGroup && siblingIndex !== -1;
  const isDragSource = dragRequest?.requestId === node.id;
  const showDropBefore = dropTarget?.requestId === node.id && dropTarget.position === 'before';
  const showDropAfter = dropTarget?.requestId === node.id && dropTarget.position === 'after';

  const handleClick = useCallback(() => {
    if (isGroup) {
      setIsOpen(prev => !prev);
    }
    setSelectedNodeId(node.id);

    if (!isGroup) {
      const req = allNodes.get(node.id) as Request | undefined;
      if (req) {
        setCurrentRequest(req);
      }
    }
  }, [isGroup, node.id, setSelectedNodeId, setCurrentRequest, allNodes]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, nodeType: node.type });
  }, [node.id, node.type]);

  const handleDelete = useCallback(async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    await window.api.collectionDelete(node.id);
    if (selectedNodeId === node.id) {
      setSelectedNodeId(null);
      setCurrentRequest(null);
    }
    onNodeChanged?.();
  }, [node.id, onNodeChanged, selectedNodeId, setCurrentRequest, setSelectedNodeId]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const startRename = useCallback((nodeId: string, name: string) => {
    setContextMenu(null);
    setEditingNodeId(nodeId);
    setEditingName(name);
  }, []);

  const finishRename = useCallback(async (nodeId: string, name: string) => {
    if (name.trim()) {
      await window.api.collectionUpdate(nodeId, { name: name.trim(), nodeType: node.type });
    }
    setEditingNodeId(null);
    setEditingName('');
    onNodeChanged?.();
  }, [node.type, onNodeChanged]);

  const startDragRequest = useCallback((e: React.DragEvent) => {
    if (!canDragRequest || !onDragRequestStart) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.dropEffect = 'move';
    e.dataTransfer.setData('text/plain', node.id);
    onDragRequestStart({ requestId: node.id, parentId });
  }, [canDragRequest, node.id, onDragRequestStart, parentId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!canDragRequest || !dragRequest || dragRequest.parentId !== parentId || dragRequest.requestId === node.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const bounds = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    onDragRequestOver?.(node.id, position);
  }, [canDragRequest, dragRequest, node.id, onDragRequestOver, parentId]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!canDragRequest || !dropTarget || dropTarget.requestId !== node.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    await onDragRequestDrop?.(node.id, dropTarget.position);
  }, [canDragRequest, dropTarget, node.id, onDragRequestDrop]);

  const childNodes = (node.children ?? []).map(id => allNodes.get(id)).filter(Boolean) as CollectionNode[];
  const childRequestIds = childNodes.filter(child => child.type === 'request').map(child => child.id);
  const canUseGroupEdgeDrop = isGroup && dragRequest?.parentId === node.id && childRequestIds.length > 0;

  /* ── Request name filtering ──────────────────────────────────── */
  const requestMatches = (item: { name: string }) =>
    !filterText || item.name.toLowerCase().includes(filterText.toLowerCase());

  const groupHasMatchingChildren = (groupNode: { children?: string[] }): boolean => {
    for (const childId of groupNode.children ?? []) {
      const child = allNodes.get(childId);
      if (!child) continue;
      if ('type' in child) {
        if (child.type === 'request' && requestMatches(child)) return true;
        if (child.type === 'group' && groupHasMatchingChildren(child)) return true;
        continue;
      }
      if ('children' in child && groupHasMatchingChildren(child)) return true;
    }
    return false;
  };

  const showNode = !filterText ||
    (isGroup ? groupHasMatchingChildren(node) : requestMatches(node));

  // Auto-expand groups when filtering so matches are visible
  const effectiveOpen = filterText ? (isGroup ? true : isOpen) : isOpen;

  const handleGroupEdgeDragOver = useCallback((targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    if (!canUseGroupEdgeDrop || dragRequest?.requestId === targetId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    onDragRequestOver?.(targetId, position);
  }, [canUseGroupEdgeDrop, dragRequest?.requestId, onDragRequestOver]);

  const handleGroupEdgeDrop = useCallback(async (targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    if (!canUseGroupEdgeDrop || !dropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    await onDragRequestDrop?.(targetId, position);
  }, [canUseGroupEdgeDrop, dropTarget, onDragRequestDrop]);

  return (
    <>
      <div className="select-none">
        {showDropBefore && <div className="h-0.5 rounded-full bg-[var(--color-primary)]" style={{ marginLeft: `${depth * 12 + 8}px` }} />}
        <div
          className={`flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer text-sm
            ${isDragSource ? 'opacity-50' : ''}
            ${isSelected ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]' : 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'}`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {isGroup && hasChildren && <IconChevron open={isOpen} />}
          {isGroup && !hasChildren && <span className="w-3" />}
          {isGroup ? <IconFolder open={isOpen} /> : (
            <button
              type="button"
              title="Drag to reorder request"
              aria-label={`Drag ${node.name} to reorder`}
              draggable={canDragRequest}
              className="p-0.5 rounded cursor-grab active:cursor-grabbing hover:bg-[var(--color-surface-active)]"
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
              onDragStart={startDragRequest}
              onDragEnd={onDragRequestEnd}
            >
              <IconMoveHandle />
            </button>
          )}
          {isEditing ? (
            <input
              type="text"
              value={editingName}
              onChange={e => setEditingName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') finishRename(node.id, editingName);
                if (e.key === 'Escape') { setEditingNodeId(null); setEditingName(''); }
              }}
              onBlur={() => finishRename(node.id, editingName)}
              className="flex-1 px-1 py-0 text-xs bg-[var(--color-bg)] border border-[var(--color-primary)] rounded text-[var(--color-text)] focus:outline-none"
              autoFocus
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
            />
          ) : (
            <span className="text-truncate">{node.name}</span>
          )}
        </div>
        {showDropAfter && <div className="h-0.5 rounded-full bg-[var(--color-primary)]" style={{ marginLeft: `${depth * 12 + 8}px` }} />}

        {isGroup && isOpen && (
          <div>
            {canUseGroupEdgeDrop && (
              <div
                className="h-3"
                onDragOver={e => handleGroupEdgeDragOver(childRequestIds[0], 'before', e)}
                onDrop={e => handleGroupEdgeDrop(childRequestIds[0], 'before', e)}
              />
            )}
            {childNodes.map(child => (
              <TreeNode
                key={child.id}
                node={child}
                allNodes={allNodes}
                depth={depth + 1}
                parentId={node.id}
                siblingIds={node.children ?? []}
                onNodeChanged={onNodeChanged}
                dragRequest={dragRequest}
                dropTarget={dropTarget}
                onDragRequestStart={onDragRequestStart}
                onDragRequestOver={onDragRequestOver}
                onDragRequestDrop={onDragRequestDrop}
                onDragRequestEnd={onDragRequestEnd}
              />
            ))}
            {canUseGroupEdgeDrop && (
              <div
                className="h-5"
                onDragOver={e => handleGroupEdgeDragOver(childRequestIds[childRequestIds.length - 1], 'after', e)}
                onDrop={e => handleGroupEdgeDrop(childRequestIds[childRequestIds.length - 1], 'after', e)}
              />
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          nodeId={contextMenu.nodeId} nodeName={node.name} nodeType={contextMenu.nodeType}
          onClose={() => setContextMenu(null)}
          onRename={startRename}
          onAction={() => { onNodeChanged?.(); setContextMenu(null); }}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}

// ─── Sidebar Component ──────────────────────────────────────────

function findFirstRequest(items: (CollectionNode | Request | RequestGroup)[]): Request | null {
  for (const item of items) {
    if ('method' in item) {
      return item as Request;
    }

    if ('children' in item && item.children) {
      const childNodes = item.children
        .map(id => items.find(candidate => candidate.id === id))
        .filter(Boolean) as (CollectionNode | Request | RequestGroup)[];
      const firstChild = findFirstRequest(childNodes);
      if (firstChild) return firstChild;
    }
  }

  return null;
}

export function Sidebar() {
  const [nodes, setNodes] = useState<CollectionNode[]>([]);
  const [nodeMap, setNodeMap] = useState<Map<string, CollectionNode | Request | RequestGroup>>(new Map());
  const [dragRequest, setDragRequest] = useState<DragRequestState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null);
  const [envSearch, setEnvSearch] = useState('');
  const { selectedNodeId, sidebarCollapsed, toggleSidebar, setSelectedNodeId } = useUiStore();
  const { currentRequest, setCurrentRequest } = useRequestStore();
  const { environments, activeEnvironmentId, setActiveEnvironment } = useEnvironmentStore();

  useEffect(() => {
    loadCollection();
  }, []);

  async function loadCollection() {
    try {
      const data = await window.api.collectionList();
      const collectionItems = Array.isArray(data) ? data : data?.nodes;
      if (collectionItems) {
        const map = new Map<string, CollectionNode | Request | RequestGroup>();
        const childIds = new Set<string>();

        for (const item of collectionItems as (CollectionNode | Request | RequestGroup)[]) {
          map.set(item.id, item);
          if ('children' in item && item.children) {
            item.children.forEach(id => childIds.add(id));
          }
        }

        const rootNodes = (collectionItems as CollectionNode[]).filter(item => !childIds.has(item.id));

        setNodes(rootNodes);
        setNodeMap(map);

        if (!selectedNodeId && !currentRequest) {
          const firstRequest = findFirstRequest(collectionItems);
          if (firstRequest) {
            setSelectedNodeId(firstRequest.id);
            setCurrentRequest(firstRequest);
          }
        }
      }
    } catch (err) {
      console.error('Failed to load collection:', err);
    }
  }

  const getSiblingIds = useCallback((parentId?: string) => {
    if (!parentId) return nodes.map(node => node.id);

    const parent = nodeMap.get(parentId);
    if (!parent || !('children' in parent) || !parent.children) return [];

    return parent.children;
  }, [nodeMap, nodes]);

  const reorderRequest = useCallback(async (targetId: string, position: 'before' | 'after') => {
    if (!dragRequest || dragRequest.requestId === targetId) return;

    const siblingIds = getSiblingIds(dragRequest.parentId);
    const draggedIndex = siblingIds.indexOf(dragRequest.requestId);
    const targetIndex = siblingIds.indexOf(targetId);
    if (draggedIndex === -1 || targetIndex === -1) return;

    const children = siblingIds.filter(id => id !== dragRequest.requestId);
    const targetIndexAfterRemoval = children.indexOf(targetId);
    const insertIndex = position === 'before' ? targetIndexAfterRemoval : targetIndexAfterRemoval + 1;
    children.splice(insertIndex, 0, dragRequest.requestId);

    await window.api.collectionReorder({ parentId: dragRequest.parentId, children });
    setDragRequest(null);
    setDropTarget(null);
    await loadCollection();
  }, [dragRequest, getSiblingIds]);

  const finishDragRequest = useCallback(() => {
    setDragRequest(null);
    setDropTarget(null);
  }, []);

  const getLastDropTargetId = useCallback(() => {
    if (!dragRequest) return null;

    const siblingIds = getSiblingIds(dragRequest.parentId).filter(id => id !== dragRequest.requestId);
    return siblingIds.at(-1) ?? null;
  }, [dragRequest, getSiblingIds]);

  const handleTreeEmptyAreaDragOver = useCallback((e: React.DragEvent) => {
    if (!dragRequest) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const targetId = getLastDropTargetId();
    if (!targetId) return;
    setDropTarget({ requestId: targetId, position: 'after' });
  }, [dragRequest, getLastDropTargetId]);

  const handleTreeEmptyAreaDrop = useCallback(async (e: React.DragEvent) => {
    if (!dragRequest) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const targetId = getLastDropTargetId();
    if (!targetId) return;
    await reorderRequest(targetId, 'after');
  }, [dragRequest, getLastDropTargetId, reorderRequest]);

  const keepDragMoveFeedback = useCallback((e: React.DragEvent) => {
    if (!dragRequest) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [dragRequest]);

  const rootRequestIds = nodes.filter(node => node.type === 'request').map(node => node.id);
  const canUseRootEdgeDrop = dragRequest?.parentId === undefined && rootRequestIds.length > 0;

  const handleRootEdgeDragOver = useCallback((targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!canUseRootEdgeDrop || dragRequest?.requestId === targetId) return;
    setDropTarget({ requestId: targetId, position });
  }, [canUseRootEdgeDrop, dragRequest?.requestId]);

  const handleRootEdgeDrop = useCallback(async (targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!canUseRootEdgeDrop) return;
    await reorderRequest(targetId, position);
  }, [canUseRootEdgeDrop, reorderRequest]);

  const filteredEnvs = environments.filter(e =>
    e.name.toLowerCase().includes(envSearch.toLowerCase())
  );

  return (
    <div
      data-testid="sidebar"
      className={`flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)] transition-all duration-200 ${sidebarCollapsed ? 'w-0 overflow-hidden' : 'w-64'}`}
      onDragOver={keepDragMoveFeedback}
      onDragEnter={keepDragMoveFeedback}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Collections</h2>
        <button
          onClick={toggleSidebar}
          className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]"
          title="Collapse sidebar"
        >
          <IconCollapse />
        </button>
      </div>

      {/* Environment Selector */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1 mb-1">
          <IconGlobe />
          <span className="text-xs text-[var(--color-text-muted)]">Environment</span>
        </div>
        <input
          type="text"
          value={envSearch}
          onChange={e => setEnvSearch(e.target.value)}
          placeholder="Search environments..."
          className="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
        />
        <div className="mt-1 max-h-24 overflow-y-auto">
          {filteredEnvs.map(env => (
            <button
              key={env.id}
              className={`w-full text-left px-2 py-1 text-xs rounded truncate ${
                activeEnvironmentId === env.id
                  ? 'bg-[var(--color-surface-active)] text-[var(--color-primary)]'
                  : 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'
              }`}
              onClick={() => {
                setActiveEnvironment(env.id);
                window.api.envSwitch(env.id);
              }}
            >
              {env.name}
            </button>
          ))}
          {environments.length === 0 && (
            <span className="text-xs text-[var(--color-text-muted)] px-2">No environments</span>
          )}
        </div>
      </div>

      {/* Tree */}
      <div
        data-testid="collection-tree"
        className="flex-1 overflow-y-auto py-1"
        onDragOver={handleTreeEmptyAreaDragOver}
        onDrop={handleTreeEmptyAreaDrop}
      >
        {nodes.length === 0 && (
          <div className="px-3 py-4 text-xs text-[var(--color-text-muted)] text-center">
            No collections yet
          </div>
        )}
        {canUseRootEdgeDrop && (
          <div
            className="h-3"
            onDragOver={e => handleRootEdgeDragOver(rootRequestIds[0], 'before', e)}
            onDrop={e => handleRootEdgeDrop(rootRequestIds[0], 'before', e)}
          />
        )}
        {nodes.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            allNodes={nodeMap}
            siblingIds={nodes.map(rootNode => rootNode.id)}
            onNodeChanged={loadCollection}
            dragRequest={dragRequest}
            dropTarget={dropTarget}
            onDragRequestStart={setDragRequest}
            onDragRequestOver={(requestId, position) => setDropTarget({ requestId, position })}
            onDragRequestDrop={reorderRequest}
            onDragRequestEnd={finishDragRequest}
          />
        ))}
        {canUseRootEdgeDrop && (
          <div
            className="h-16"
            onDragOver={e => handleRootEdgeDragOver(rootRequestIds[rootRequestIds.length - 1], 'after', e)}
            onDrop={e => handleRootEdgeDrop(rootRequestIds[rootRequestIds.length - 1], 'after', e)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-[var(--color-border)]">
        <button
          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] text-[var(--color-text)] rounded transition-colors"
          onClick={async () => {
            const now = Date.now();
            const defaultRequest: Request = {
              id: createId(),
              name: 'New Request',
              method: 'GET',
              url: '',
              headers: [],
              parameters: [],
              body: { type: 'none' },
              auth: { type: 'none' },
              settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
              scripts: {},
              createdAt: now,
              updatedAt: now,
            };
            const created = await window.api.collectionCreate({ ...defaultRequest, nodeType: 'request' });
            await loadCollection();
            if (created?.id) {
              setSelectedNodeId(created.id);
              setCurrentRequest({ ...defaultRequest, ...created });
            } else {
              setCurrentRequest(defaultRequest);
            }
          }}
        >
          <IconPlus /> New Request
        </button>
      </div>
    </div>
  );
}
