import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { buildRequestFromCurl } from '../../shared/curlImport';
import { useUiStore, useRequestStore, useEnvironmentStore } from '../stores';
import { CollectionNode, CORE_ENVIRONMENT_ID, HttpMethod, Request, RequestGroup } from '../../shared/types';
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

function IconExpand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
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

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

interface DropTargetState {
  targetId: string;
  parentId?: string;
  index: number;
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
  onDragRequestOver?: (targetId: string, parentId: string | undefined, index: number) => void;
  onDragRequestDrop?: (targetId: string, parentId: string | undefined, index: number) => Promise<void>;
  onDragRequestEnd?: () => void;
  filterText?: string;
  onAddRequestToFolder?: (folderId: string) => void;
  autoRenameNodeId?: string;
  onAutoRenameConsumed?: () => void;
  forceOpenGroupIds?: ReadonlySet<string>;
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
  onAddRequestToFolder,
  autoRenameNodeId,
  onAutoRenameConsumed,
  forceOpenGroupIds,
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
  const showDropBefore = dropTarget?.targetId === node.id && dropTarget.index === siblingIndex;
  const showDropAfter = dropTarget?.targetId === node.id && dropTarget.index === siblingIndex + 1;

  const handleClick = useCallback(async () => {
    if (isGroup) {
      setIsOpen(prev => !prev);
      setSelectedNodeId(node.id);
      return;
    }

    setSelectedNodeId(node.id);

    if (isGroup) return;

    const freshRequest = await window.api.collectionExport(node.id).catch(() => null);
    if (freshRequest) {
      setCurrentRequest(freshRequest as Request);
      return;
    }

    const req = allNodes.get(node.id) as Request | undefined;
    if (req) {
      setCurrentRequest(req);
    }
  }, [allNodes, isGroup, node.id, node.type, setCurrentRequest, setSelectedNodeId]);

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

  useEffect(() => {
    if (autoRenameNodeId && autoRenameNodeId === node.id) {
      startRename(node.id, node.name);
      onAutoRenameConsumed?.();
    }
  }, [autoRenameNodeId, node.id, node.name, onAutoRenameConsumed, startRename]);

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
    onDragRequestOver?.(node.id, parentId, position === 'before' ? siblingIndex : siblingIndex + 1);
  }, [canDragRequest, dragRequest, node.id, onDragRequestOver, parentId, siblingIndex]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    if (!canDragRequest || !dropTarget || dropTarget.targetId !== node.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    await onDragRequestDrop?.(node.id, parentId, dropTarget.index);
  }, [canDragRequest, dropTarget, node.id, onDragRequestDrop, parentId]);

  const childNodes = (node.children ?? []).map(id => allNodes.get(id)).filter(Boolean) as CollectionNode[];
  const childRequestIds = childNodes.filter(child => child.type === 'request').map(child => child.id);
  const canUseGroupEdgeDrop = isGroup && dragRequest?.parentId === node.id && childRequestIds.length > 0;
  const canDropIntoGroup = isGroup && !!dragRequest && dragRequest.requestId !== node.id;

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

  // Auto-expand groups when filtering or when revealing a freshly created request
  const isForcedOpen = isGroup && (forceOpenGroupIds?.has(node.id) ?? false);
  const effectiveOpen = isForcedOpen || (isGroup && !!filterText) || isOpen;

  const handleGroupRowDragOver = useCallback((e: React.DragEvent) => {
    if (!canDropIntoGroup) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    onDragRequestOver?.(node.id, node.id, (node.children?.length ?? 0));
  }, [canDropIntoGroup, node.children?.length, node.id, onDragRequestOver, parentId]);

  const handleGroupRowDrop = useCallback(async (e: React.DragEvent) => {
    if (!canDropIntoGroup) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    await onDragRequestDrop?.(node.id, node.id, (node.children?.length ?? 0));
  }, [canDropIntoGroup, node.children?.length, node.id, onDragRequestDrop, parentId]);

  return (
    <>
      <div className="select-none">
        {showDropBefore && <div className="h-0.5 rounded-full bg-[var(--color-primary)]" style={{ marginLeft: `${depth * 12 + 8}px` }} />}
        <div
          className={`group flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer text-sm border border-transparent
            ${isGroup ? 'font-medium bg-[var(--color-primary)]/5 text-[var(--color-primary)]/90 ring-1 ring-inset ring-[var(--color-primary)]/10' : ''}
            ${canDropIntoGroup ? 'border-dashed border-[var(--color-primary)]/60 bg-[var(--color-primary)]/8' : ''}
            ${isDragSource ? 'opacity-50' : ''}
            ${isSelected ? 'bg-[var(--color-surface-active)] text-[var(--color-text)]' : 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'}`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onDragOver={isGroup ? handleGroupRowDragOver : handleDragOver}
          onDrop={isGroup ? handleGroupRowDrop : handleDrop}
          data-droppable={canDropIntoGroup ? 'true' : undefined}
          data-folder-row={isGroup ? 'true' : undefined}
          data-testid={isGroup ? `sidebar-group-row-${node.id}` : `sidebar-request-row-${node.id}`}
        >
          {isGroup && hasChildren && <IconChevron open={effectiveOpen} />}
          {isGroup && !hasChildren && <span className="w-3" />}
          {isGroup ? <IconFolder open={effectiveOpen} /> : (
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
          {isGroup && onAddRequestToFolder && (
            <button
              type="button"
              aria-label={`Add request to ${node.name}`}
              className="ml-auto hidden shrink-0 items-center rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-active)] hover:text-[var(--color-text)] group-hover:flex"
              onClick={e => { e.stopPropagation(); onAddRequestToFolder(node.id); }}
              onMouseDown={e => e.stopPropagation()}
            >
              <IconPlus />
            </button>
          )}
        </div>
        {showDropAfter && <div className="h-0.5 rounded-full bg-[var(--color-primary)]" style={{ marginLeft: `${depth * 12 + 8}px` }} />}

        {isGroup && effectiveOpen && (
          <div>
            {canUseGroupEdgeDrop && <div className="h-3" onDragOver={handleGroupRowDragOver} onDrop={handleGroupRowDrop} />}
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
                onAddRequestToFolder={onAddRequestToFolder}
                autoRenameNodeId={autoRenameNodeId}
                onAutoRenameConsumed={onAutoRenameConsumed}
                forceOpenGroupIds={forceOpenGroupIds}
              />
            ))}
            {canUseGroupEdgeDrop && <div className="h-5" onDragOver={handleGroupRowDragOver} onDrop={handleGroupRowDrop} />}
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
  const [showEnvSearch, setShowEnvSearch] = useState(false);
  const [showNewRequestMenu, setShowNewRequestMenu] = useState(false);
  const [newRequestError, setNewRequestError] = useState<string | null>(null);
  const [autoRenameNodeId, setAutoRenameNodeId] = useState<string | null>(null);
  const [forceOpenGroupIds, setForceOpenGroupIds] = useState<ReadonlySet<string>>(new Set());
  const envListRef = useRef<HTMLDivElement>(null);
  const newRequestMenuRef = useRef<HTMLDivElement>(null);
  const { selectedNodeId, sidebarCollapsed, toggleSidebar, setSelectedNodeId } = useUiStore();
  const { currentRequest, setCurrentRequest } = useRequestStore();
  const { environments, activeEnvironmentId, setActiveEnvironment, setEnvironments, openEditor, openCreateEditor } = useEnvironmentStore();

  const loadCollection = useCallback(async () => {
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

        const seenRootIds = new Set<string>();
        const rootNodes = (collectionItems as CollectionNode[]).filter(item => !childIds.has(item.id) && !seenRootIds.has(item.id) && (seenRootIds.add(item.id), true));

        setNodes(rootNodes);
        setNodeMap(map);

        const { selectedNodeId, setSelectedNodeId } = useUiStore.getState();
        const { currentRequest, setCurrentRequest } = useRequestStore.getState();

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
  }, []);

  useEffect(() => {
    loadCollection();
  }, [loadCollection]);

  useEffect(() => {
    if (!currentRequest) return;

    setNodeMap(prev => {
      if (!prev.has(currentRequest.id)) return prev;

      const next = new Map(prev);
      next.set(currentRequest.id, currentRequest);
      return next;
    });
  }, [currentRequest]);

  useLayoutEffect(() => {
    const unsubscribe = window.api.onCollectionChanged?.(() => {
      loadCollection();
    });

    return unsubscribe;
  }, [loadCollection]);

  useEffect(() => {
    if (!showNewRequestMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (newRequestMenuRef.current?.contains(event.target as Node)) return;
      setShowNewRequestMenu(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [showNewRequestMenu]);

  const updateEnvSearchVisibility = useCallback(() => {
    const list = envListRef.current;
    if (!list) return;
    setShowEnvSearch(list.scrollHeight > list.clientHeight + 1);
  }, []);

  useLayoutEffect(() => {
    updateEnvSearchVisibility();
  }, [updateEnvSearchVisibility, environments.length]);

  useEffect(() => {
    const list = envListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => updateEnvSearchVisibility());
    observer.observe(list);

    return () => observer.disconnect();
  }, [updateEnvSearchVisibility]);

  const getSiblingIds = useCallback((parentId?: string) => {
    if (!parentId) return nodes.map(node => node.id);

    const parent = nodeMap.get(parentId);
    if (!parent || !('children' in parent) || !parent.children) return [];

    return parent.children;
  }, [nodeMap, nodes]);

  const reorderRequest = useCallback(async (targetId: string, targetParentId: string | undefined, targetIndex: number) => {
    if (!dragRequest || dragRequest.requestId === targetId) return;

    if (dragRequest.parentId !== targetParentId) {
      await window.api.collectionMoveRequest({
        requestId: dragRequest.requestId,
        targetParentId,
        targetIndex,
      });
    } else {
      const siblingIds = getSiblingIds(dragRequest.parentId);
      const draggedIndex = siblingIds.indexOf(dragRequest.requestId);
      const targetSiblingIndex = siblingIds.indexOf(targetId);
      if (draggedIndex === -1 || targetSiblingIndex === -1) return;

      const children = siblingIds.filter(id => id !== dragRequest.requestId);
      const insertIndex = targetIndex - (draggedIndex < targetSiblingIndex ? 1 : 0);
      children.splice(insertIndex, 0, dragRequest.requestId);

      await window.api.collectionReorder({ parentId: dragRequest.parentId, children });
    }
    setDragRequest(null);
    setDropTarget(null);
    await loadCollection();
  }, [dragRequest, getSiblingIds, loadCollection]);

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
    setDropTarget({ targetId, index: getSiblingIds(dragRequest.parentId).length });
  }, [dragRequest, getLastDropTargetId, getSiblingIds]);

  const handleTreeEmptyAreaDrop = useCallback(async (e: React.DragEvent) => {
    if (!dragRequest) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const targetId = getLastDropTargetId();
    if (!targetId) return;
    await reorderRequest(targetId, dragRequest.parentId, getSiblingIds(dragRequest.parentId).length);
  }, [dragRequest, getLastDropTargetId, getSiblingIds, reorderRequest]);

  const keepDragMoveFeedback = useCallback((e: React.DragEvent) => {
    if (!dragRequest) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, [dragRequest]);

  const rootNodeIds = nodes.map(node => node.id);
  const canUseRootEdgeDrop = !!dragRequest && rootNodeIds.length > 0;

  const handleRootEdgeDragOver = useCallback((targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!canUseRootEdgeDrop || dragRequest?.requestId === targetId) return;
    setDropTarget({ targetId, index: position === 'before' ? rootNodeIds.indexOf(targetId) : rootNodeIds.indexOf(targetId) + 1 });
  }, [canUseRootEdgeDrop, dragRequest?.requestId, rootNodeIds]);

  const handleRootEdgeDrop = useCallback(async (targetId: string, position: 'before' | 'after', e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (!canUseRootEdgeDrop) return;
    await reorderRequest(targetId, undefined, position === 'before' ? rootNodeIds.indexOf(targetId) : rootNodeIds.indexOf(targetId) + 1);
  }, [canUseRootEdgeDrop, reorderRequest, rootNodeIds]);

  const filteredEnvs = environments.filter(e =>
    e.name.toLowerCase().includes(envSearch.toLowerCase())
  );

  const activeEnv = environments.find(env => env.id === activeEnvironmentId) ?? environments.find(env => env.id === CORE_ENVIRONMENT_ID) ?? null;

  const handleOpenActiveEditor = useCallback(() => {
    if (!activeEnv) return;
    openEditor(activeEnv.id);
  }, [activeEnv, openEditor]);

  const handleCreateChildEnvironment = useCallback(() => {
    openCreateEditor(activeEnv?.id ?? CORE_ENVIRONMENT_ID);
  }, [activeEnv?.id, openCreateEditor]);

  const createAndSelectRequest = useCallback(async (request: Request, options?: { autoRename?: boolean }) => {
    const created = await window.api.collectionCreate({ ...request, nodeType: 'request' });
    await loadCollection();

    const createdId = created?.id ?? request.id;
    if (created?.id) {
      setSelectedNodeId(created.id);
      setCurrentRequest({ ...request, ...created });
    } else {
      setSelectedNodeId(createdId);
      setCurrentRequest(request);
    }

    if (!options?.autoRename) return;

    if (request.parentId) {
      const ancestorIds = [request.parentId];
      const seen = new Set<string>([request.parentId]);
      let cursor = request.parentId;
      while (cursor) {
        const ancestorParentId = nodeMap.get(cursor)?.parentId;
        if (!ancestorParentId || seen.has(ancestorParentId)) break;
        seen.add(ancestorParentId);
        ancestorIds.push(ancestorParentId);
        cursor = ancestorParentId;
      }
      setForceOpenGroupIds(prev => {
        const next = new Set(prev);
        for (const id of ancestorIds) next.add(id);
        return next;
      });
    }

    setAutoRenameNodeId(createdId);
  }, [loadCollection, nodeMap, setCurrentRequest, setSelectedNodeId]);

  const handleConsumeAutoRename = useCallback(() => {
    setAutoRenameNodeId(null);
  }, []);

  const handleCreateRequest = useCallback(async () => {
    const now = Date.now();
    const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : undefined;
    const parentId = selectedNode && 'type' in selectedNode && selectedNode.type === 'group'
      ? selectedNode.id
      : undefined;

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
      ...(parentId ? { parentId } : {}),
    };

    setShowNewRequestMenu(false);
    setNewRequestError(null);
    await createAndSelectRequest(defaultRequest, { autoRename: true });
  }, [createAndSelectRequest, nodeMap, selectedNodeId]);

  const handleAddRequestToFolder = useCallback(async (folderId: string) => {
    const now = Date.now();
    const request: Request = {
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
      parentId: folderId,
    };

    setShowNewRequestMenu(false);
    setNewRequestError(null);
    await createAndSelectRequest(request, { autoRename: true });
  }, [createAndSelectRequest]);

  const handleCreateRequestFromClipboard = useCallback(async () => {
    try {
      const importedRequest = await window.api.importCurlFromClipboard();

      setShowNewRequestMenu(false);
      setNewRequestError(null);
      await createAndSelectRequest(importedRequest);
    } catch (error) {
      setNewRequestError(error instanceof Error ? error.message : 'Could not import cURL from clipboard.');
    }
  }, [createAndSelectRequest]);

  const handleCreateFolder = useCallback(async () => {
    const now = Date.now();
    await window.api.collectionCreate({
      id: createId(),
      name: 'New Folder',
      children: [],
      nodeType: 'group',
      createdAt: now,
      updatedAt: now,
    });
    setShowNewRequestMenu(false);
    setNewRequestError(null);
    await loadCollection();
  }, [loadCollection]);

  return (
    <div
      data-testid="sidebar"
      className={`flex flex-col bg-[var(--color-surface)] border-r border-[var(--color-border)] transition-all duration-200 ${sidebarCollapsed ? 'w-14 flex-shrink-0' : 'w-64'}`}
      onDragOver={keepDragMoveFeedback}
      onDragEnter={keepDragMoveFeedback}
    >
      {sidebarCollapsed ? (
        <div className="flex flex-col items-center gap-2 px-2 py-2 h-full">
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 flex items-center justify-center rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <IconExpand />
          </button>
          <button
            onClick={handleCreateRequest}
            className="w-9 h-9 flex items-center justify-center rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="New Request"
            aria-label="New Request"
          >
            <IconPlus />
          </button>
        </div>
      ) : (
        <>
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
          <div className="flex items-center justify-between w-full gap-2">
            <div className="flex items-center gap-1 min-w-0">
              <IconGlobe />
              <span className="text-xs text-[var(--color-text-muted)]">Environment</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Edit selected environment"
                aria-label="Edit selected environment"
                onClick={handleOpenActiveEditor}
                className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <IconEdit />
              </button>
              <button
                type="button"
                title="Create child environment"
                aria-label="Create child environment"
                onClick={handleCreateChildEnvironment}
                className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <IconPlus />
              </button>
            </div>
          </div>
        </div>
        {showEnvSearch && (
          <input
            type="text"
            value={envSearch}
            onChange={e => setEnvSearch(e.target.value)}
            placeholder="Search environments..."
            className="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
          />
        )}
        <div ref={envListRef} className="mt-1 max-h-24 overflow-y-auto">
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
        {rootNodeIds.length > 0 && (
          <div
            className="h-3"
            onDragOver={e => handleRootEdgeDragOver(rootNodeIds[0], 'before', e)}
            onDrop={e => handleRootEdgeDrop(rootNodeIds[0], 'before', e)}
          />
        )}
        {nodes.map(node => (
          <TreeNode
            key={node.id}
            node={node}
            allNodes={nodeMap}
            siblingIds={rootNodeIds}
            onNodeChanged={loadCollection}
            dragRequest={dragRequest}
            dropTarget={dropTarget}
            onDragRequestStart={setDragRequest}
            onDragRequestOver={(targetId, parentId, index) => setDropTarget({ targetId, parentId, index })}
            onDragRequestDrop={reorderRequest}
            onDragRequestEnd={finishDragRequest}
            onAddRequestToFolder={handleAddRequestToFolder}
            autoRenameNodeId={autoRenameNodeId ?? undefined}
            onAutoRenameConsumed={handleConsumeAutoRename}
            forceOpenGroupIds={forceOpenGroupIds}
          />
        ))}
        {rootNodeIds.length > 0 && (
          <div
            className="h-16"
            onDragOver={e => handleRootEdgeDragOver(rootNodeIds[rootNodeIds.length - 1], 'after', e)}
            onDrop={e => handleRootEdgeDrop(rootNodeIds[rootNodeIds.length - 1], 'after', e)}
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-[var(--color-border)]">
        <div ref={newRequestMenuRef} className="relative">
          <button
            type="button"
            className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] text-[var(--color-text)] rounded transition-colors"
            onClick={() => {
              setNewRequestError(null);
              setShowNewRequestMenu(open => !open);
            }}
            aria-expanded={showNewRequestMenu}
          >
            <IconPlus />
            <span>New</span>
          </button>

          {showNewRequestMenu && (
            <div data-testid="new-request-menu" className="absolute bottom-full left-0 right-0 mb-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg overflow-hidden z-20">
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                onClick={handleCreateFolder}
              >
                New Folder
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                onClick={handleCreateRequest}
              >
                New Request
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
                onClick={handleCreateRequestFromClipboard}
              >
                New Request from Clipboard
              </button>
            </div>
          )}
        </div>
        {newRequestError && (
          <p className="mt-2 text-[11px] leading-4 text-[var(--color-error)]">{newRequestError}</p>
        )}
      </div>
        </>
      )}
    </div>
  );
}
