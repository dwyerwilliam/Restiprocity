import { useEffect, useSyncExternalStore } from 'react';
import type { Request, RequestOutputs } from '@shared/types';

/** Which saved request provides an output name. Read from the collection; values never reach the window. */
export interface RendererOutputEntry {
  requestId: string;
  requestName: string;
  enabled: boolean;
  refreshAfterSeconds: number;
}

export type RendererOutputIndex = ReadonlyMap<string, RendererOutputEntry>;

let snapshot: RendererOutputIndex = new Map();
const listeners = new Set<() => void>();

function isRequestWithOutputs(item: unknown): item is Request & { outputs: RequestOutputs } {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<Request> & { children?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.method === 'string' && candidate.children === undefined
    && !!candidate.outputs && Array.isArray(candidate.outputs.values);
}

/** Same rule as the main process: enabled names first, then a disabled name nobody enabled has; lowest ID wins a tie. */
export function buildRendererOutputIndex(items: readonly unknown[]): RendererOutputIndex {
  const requests = items.filter(isRequestWithOutputs).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const index = new Map<string, RendererOutputEntry>();
  for (const enabled of [true, false]) {
    for (const request of requests) {
      if ((request.outputs.enabled === true) !== enabled) continue;
      for (const value of request.outputs.values) {
        if (typeof value?.name !== 'string' || index.has(value.name)) continue;
        index.set(value.name, {
          requestId: request.id,
          requestName: request.name,
          enabled,
          refreshAfterSeconds: request.outputs.refreshAfterSeconds,
        });
      }
    }
  }
  return index;
}

/** Reloads output names from the collection; call after saving outputs. */
export async function refreshOutputIndex(): Promise<void> {
  if (typeof window.api?.collectionList !== 'function') return;
  const data = await window.api.collectionList();
  const items: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.nodes) ? data.nodes : [];
  snapshot = buildRendererOutputIndex(items);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useOutputIndex(): RendererOutputIndex {
  const index = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    void refreshOutputIndex().catch(() => {});
  }, []);
  return index;
}

/** Enabled output names, for preview and autocomplete. */
export function enabledOutputKeys(index: RendererOutputIndex): string[] {
  return [...index].filter(([, entry]) => entry.enabled).map(([name]) => name);
}
