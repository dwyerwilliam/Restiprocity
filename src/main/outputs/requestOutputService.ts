import { computeOutputTtlMs } from '@shared/requestOutputs';
import type { Id, RequestOutputStatus, TokenErrorCode } from '@shared/types';
import { isTokenSourceError, TokenSourceError } from './tokenErrors';

/** Which token request, for which environment, as it is defined right now. */
export interface OutputBinding {
  requestId: Id;
  environmentId: Id | undefined;
  fingerprint: string;
  names: readonly string[];
  refreshAfterSeconds: number;
}

export interface ProducerResult {
  values: Record<string, string>;
  expiresInSeconds?: number;
}

export interface AcquiredOutputs {
  values: Readonly<Record<string, string>>;
  /** True when no fetch ran for this call: a 401 then means the cached value went bad and is worth replacing once. */
  fromCache: boolean;
  /** Pass back to `invalidate` so only the value this send used is dropped. */
  generation: number;
}

export interface RequestOutputClock {
  wallNow(): number;
  monotonicNow(): number;
}

interface StoredValue {
  values: Record<string, string>;
  fingerprint: string;
  fetchedWall: number;
  fetchedMono: number;
  ttlMs: number;
}

interface PendingFetch {
  fingerprint: string;
  generation: number;
  controller: AbortController;
  waiters: number;
  promise: Promise<AcquiredOutputs>;
}

interface Entry {
  requestId: Id;
  environmentId: Id | undefined;
  generation: number;
  lastUsed: number;
  value?: StoredValue;
  pending?: PendingFetch;
  lastError?: { code: TokenErrorCode | null; message: string; fingerprint: string };
}

const DEFAULT_MAX_ENTRIES = 100;

function keyOf(requestId: Id, environmentId: Id | undefined): string {
  return `${requestId}\u0000${environmentId ?? ''}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Request cancelled', 'AbortError');
}

function clearedError(): TokenSourceError {
  return new TokenSourceError('TOKEN_SOURCE_FAILED', 'The cached values were cleared while they were being fetched. Send again.');
}

/**
 * Values taken from token requests, held in memory only, one entry per token request and environment. A value is
 * fetched when a send needs it and none is fresh; there are no timers, so an idle app fetches nothing.
 */
export class RequestOutputService {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private generations = 0;
  private uses = 0;

  constructor(private readonly deps: { clock: RequestOutputClock; maxEntries?: number }) {
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  acquire(
    binding: OutputBinding,
    options: { signal: AbortSignal; run: (signal: AbortSignal) => Promise<ProducerResult> },
  ): Promise<AcquiredOutputs> {
    if (options.signal.aborted) return Promise.reject(abortReason(options.signal));
    const entry = this.entryFor(binding);
    if (entry.value && this.isFresh(entry.value, binding)) {
      return Promise.resolve({ values: entry.value.values, fromCache: true, generation: entry.generation });
    }
    if (entry.pending && entry.pending.fingerprint === binding.fingerprint) return this.wait(entry.pending, options.signal);

    // Stale, missing, or fetched for an older definition: never served again, and an older fetch is retired.
    entry.value = undefined;
    entry.pending?.controller.abort(clearedError());
    const generation = ++this.generations;
    entry.generation = generation;
    const controller = new AbortController();
    const pending: PendingFetch = { fingerprint: binding.fingerprint, generation, controller, waiters: 0, promise: Promise.resolve() as never };
    pending.promise = (async () => {
      try {
        const result = await options.run(controller.signal);
        if (entry.generation !== generation) throw clearedError();
        controller.signal.throwIfAborted();
        entry.value = {
          values: { ...result.values },
          fingerprint: binding.fingerprint,
          fetchedWall: this.deps.clock.wallNow(),
          fetchedMono: this.deps.clock.monotonicNow(),
          ttlMs: computeOutputTtlMs(binding.refreshAfterSeconds, result.expiresInSeconds),
        };
        entry.lastError = undefined;
        return { values: entry.value.values, fromCache: false, generation };
      } catch (error) {
        const failure = entry.generation !== generation ? clearedError() : error;
        if (entry.generation === generation && !controller.signal.aborted) {
          entry.lastError = {
            code: isTokenSourceError(error) ? error.code as TokenErrorCode : null,
            message: error instanceof Error ? error.message : 'The token request failed.',
            fingerprint: binding.fingerprint,
          };
        }
        throw failure;
      } finally {
        if (entry.pending === pending) entry.pending = undefined;
        this.evict();
      }
    })();
    pending.promise.catch(() => {});
    entry.pending = pending;
    return this.wait(pending, options.signal);
  }

  peek(binding: OutputBinding): AcquiredOutputs | null {
    const entry = this.entries.get(keyOf(binding.requestId, binding.environmentId));
    if (!entry?.value || !this.isFresh(entry.value, binding)) return null;
    entry.lastUsed = ++this.uses;
    return { values: entry.value.values, fromCache: true, generation: entry.generation };
  }

  invalidate(binding: OutputBinding, generation: number): void {
    const entry = this.entries.get(keyOf(binding.requestId, binding.environmentId));
    if (entry && entry.generation === generation) entry.value = undefined;
  }

  seed(binding: OutputBinding, result: ProducerResult): AcquiredOutputs {
    const entry = this.entryFor(binding);
    const generation = ++this.generations;
    entry.generation = generation;
    entry.value = {
      values: { ...result.values },
      fingerprint: binding.fingerprint,
      fetchedWall: this.deps.clock.wallNow(),
      fetchedMono: this.deps.clock.monotonicNow(),
      ttlMs: computeOutputTtlMs(binding.refreshAfterSeconds, result.expiresInSeconds),
    };
    entry.lastError = undefined;
    this.evict();
    return { values: entry.value.values, fromCache: false, generation };
  }

  status(binding: OutputBinding): RequestOutputStatus {
    const base = { requestId: binding.requestId, environmentId: binding.environmentId ?? '', names: [...binding.names] };
    const entry = this.entries.get(keyOf(binding.requestId, binding.environmentId));
    if (!entry) return { ...base, state: 'empty' };
    if (entry.pending && entry.pending.fingerprint === binding.fingerprint) return { ...base, state: 'fetching' };
    if (entry.value && entry.value.fingerprint === binding.fingerprint) {
      return {
        ...base,
        state: this.isFresh(entry.value, binding) ? 'fresh' : 'stale',
        fetchedAt: entry.value.fetchedWall,
        refreshAt: entry.value.fetchedWall + entry.value.ttlMs,
      };
    }
    if (entry.lastError && entry.lastError.fingerprint === binding.fingerprint) {
      return { ...base, state: 'failed', error: { code: entry.lastError.code, message: entry.lastError.message } };
    }
    return { ...base, state: 'empty' };
  }

  clear(requestId: Id): void {
    for (const [key, entry] of this.entries) {
      if (entry.requestId !== requestId) continue;
      this.retire(entry);
      this.entries.delete(key);
    }
  }

  clearAll(): void {
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
  }

  private retire(entry: Entry): void {
    entry.generation = ++this.generations;
    entry.value = undefined;
    entry.pending?.controller.abort(clearedError());
  }

  private entryFor(binding: OutputBinding): Entry {
    const key = keyOf(binding.requestId, binding.environmentId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { requestId: binding.requestId, environmentId: binding.environmentId, generation: ++this.generations, lastUsed: 0 };
      this.entries.set(key, entry);
    }
    entry.lastUsed = ++this.uses;
    return entry;
  }

  private isFresh(value: StoredValue, binding: OutputBinding): boolean {
    if (value.fingerprint !== binding.fingerprint) return false;
    const wall = this.deps.clock.wallNow();
    const mono = this.deps.clock.monotonicNow();
    // A wall clock that moved backwards can't be trusted to measure age, so the value counts as stale.
    return wall >= value.fetchedWall && wall - value.fetchedWall < value.ttlMs && mono - value.fetchedMono < value.ttlMs;
  }

  /** Several sends can wait for one fetch; each can leave on its own, and the fetch stops when the last one leaves. */
  private wait(pending: PendingFetch, signal: AbortSignal): Promise<AcquiredOutputs> {
    pending.waiters += 1;
    return new Promise<AcquiredOutputs>((resolve, reject) => {
      let done = false;
      const leave = () => {
        if (done) return false;
        done = true;
        pending.waiters -= 1;
        signal.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (pending.waiters === 0) pending.controller.abort(abortReason(signal));
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        value => { if (leave()) resolve(value); },
        error => { if (leave()) reject(error); },
      );
    });
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const idle = [...this.entries].filter(([, entry]) => !entry.pending).sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
    for (const [key] of idle) {
      if (this.entries.size <= this.maxEntries) return;
      this.entries.delete(key);
    }
  }
}
