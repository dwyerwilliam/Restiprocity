import type { RequestRuntimeAdapters, RequestTimerHandle } from './requestRuntimeAdapters';

/** One pre-header budget, shared by preparation, OAuth and the target request. */
export class MultipartOperation {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  prepared?: { body: Buffer; contentType: string };
  private timer?: RequestTimerHandle;
  private deadline?: number;
  private readonly abort = () => this.controller.abort(this.parent.reason);
  constructor(private readonly parent: AbortSignal, timeout: number, private readonly runtime: RequestRuntimeAdapters) {
    parent.addEventListener('abort', this.abort, { once: true });
    if (parent.aborted) this.abort();
    if (timeout > 0 && !this.signal.aborted) {
      this.deadline = runtime.clock.monotonicNow() + timeout;
      this.timer = runtime.timers.setTimeout(() => this.expire(), timeout);
    }
  }
  private expire() { this.controller.abort(new DOMException('Multipart request timed out before response headers', 'TimeoutError')); }
  check() {
    if (this.deadline !== undefined && this.runtime.clock.monotonicNow() >= this.deadline) this.expire();
    this.signal.throwIfAborted();
  }
  headersReceived() {
    this.check();
    this.clearDeadline();
  }
  private clearDeadline() {
    if (this.timer) this.runtime.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
  }
  dispose() {
    this.clearDeadline();
    this.parent.removeEventListener('abort', this.abort);
    this.prepared = undefined;
  }
  async wait<T>(work: Promise<T>, late?: (value: T) => void | Promise<void>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; this.signal.removeEventListener('abort', abort); reject(this.signal.reason); } };
      this.signal.addEventListener('abort', abort, { once: true });
      try { this.check(); } catch { abort(); }
      work.then(value => {
        if (settled) { void Promise.resolve().then(() => late?.(value)).catch(() => {}); return; }
        try { this.check(); settled = true; resolve(value); }
        catch (error) { settled = true; reject(error); void Promise.resolve().then(() => late?.(value)).catch(() => {}); }
      }, error => { if (!settled) { settled = true; reject(this.signal.aborted ? this.signal.reason : error); } })
        .finally(() => this.signal.removeEventListener('abort', abort));
    });
  }
}
