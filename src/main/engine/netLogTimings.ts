import type { ResponseConnectionTiming } from '@shared/types';

/**
 * Derives DNS/TCP/TLS connection-setup timings from a Chromium NetLog capture.
 *
 * Electron's `net`/`fetch` don't expose Chromium's load timing, but a NetLog recorded on the
 * dedicated API session holds the connection events for the request. The parser follows the
 * request's own dependency graph (URL_REQUEST → stream job controller → winning stream job →
 * connect job → socket) so racing jobs that lost, proxy auto-discovery lookups and network
 * quality probes are not counted.
 *
 * Only the classic HttpStreamFactory job-controller graph is understood. Anything else returns
 * `null`, and callers report the phases as unmeasured rather than guessing.
 */

export interface NetLogConnectionTimings {
  dns: number;
  tcp: number;
  tls: number;
  connection: Exclude<ResponseConnectionTiming, 'unmeasured'>;
}

interface NetLogEvent {
  time: number;
  type: string;
  phase: 'begin' | 'end' | 'none';
  dependency?: { id: number; type: string };
}

interface NetLogIndex {
  events: Map<number, NetLogEvent[]>;
  sourceTypes: Map<number, string>;
}

interface StreamHop {
  start: number;
  boundAt?: number;
  controller?: number;
  job?: number;
  boundToExistingQuicSession: boolean;
}

interface HopTimings {
  dns: number;
  tcp: number;
  tls: number;
  connection: NetLogConnectionTimings['connection'];
}

type Interval = readonly [number, number];

const REUSE_EVENTS = new Set([
  'SOCKET_POOL_REUSED_AN_EXISTING_SOCKET',
  'HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION',
  'HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION_FROM_IP_POOL',
  'QUIC_SESSION_POOL_USE_EXISTING_SESSION',
  'QUIC_SESSION_POOL_ATTACH_HTTP_STREAM_JOB_TO_EXISTING_SESSION',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseNetLogJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A log that was not finalized ends mid-"events" array; close it so the recorded events stay usable.
    try {
      return JSON.parse(`${text.trimEnd().replace(/,$/, '')}]}`);
    } catch {
      return null;
    }
  }
}

function invert(value: unknown): Map<number, string> | null {
  if (!isRecord(value)) return null;
  const result = new Map<number, string>();
  for (const [name, id] of Object.entries(value)) {
    if (typeof id === 'number') result.set(id, name);
  }
  return result;
}

function indexNetLog(log: unknown): NetLogIndex | null {
  if (!isRecord(log) || !isRecord(log.constants) || !Array.isArray(log.events)) return null;
  const eventTypes = invert(log.constants.logEventTypes);
  const sourceTypes = invert(log.constants.logSourceType);
  const phases = invert(log.constants.logEventPhase);
  if (!eventTypes || !sourceTypes || !phases) return null;

  const index: NetLogIndex = { events: new Map(), sourceTypes: new Map() };
  for (const raw of log.events) {
    if (!isRecord(raw) || !isRecord(raw.source)) continue;
    const type = typeof raw.type === 'number' ? eventTypes.get(raw.type) : undefined;
    const sourceId = raw.source.id;
    const sourceType = typeof raw.source.type === 'number' ? sourceTypes.get(raw.source.type) : undefined;
    const time = Number(raw.time);
    if (!type || typeof sourceId !== 'number' || !sourceType || !Number.isFinite(time)) continue;

    const phaseName = typeof raw.phase === 'number' ? phases.get(raw.phase) : undefined;
    const phase = phaseName === 'PHASE_BEGIN' ? 'begin' : phaseName === 'PHASE_END' ? 'end' : 'none';
    const rawDependency = isRecord(raw.params) && isRecord(raw.params.source_dependency) ? raw.params.source_dependency : null;
    const dependencyType = rawDependency && typeof rawDependency.type === 'number' ? sourceTypes.get(rawDependency.type) : undefined;
    const dependency = rawDependency && typeof rawDependency.id === 'number' && dependencyType
      ? { id: rawDependency.id, type: dependencyType }
      : undefined;

    index.sourceTypes.set(sourceId, sourceType);
    const sourceEvents = index.events.get(sourceId) ?? [];
    sourceEvents.push({ time, type, phase, ...(dependency ? { dependency } : {}) });
    index.events.set(sourceId, sourceEvents);
  }
  return index;
}

function eventsOf(index: NetLogIndex, sourceId: number | undefined): NetLogEvent[] {
  return sourceId === undefined ? [] : index.events.get(sourceId) ?? [];
}

function dependenciesOf(index: NetLogIndex, sourceId: number | undefined, eventType: string): number[] {
  return eventsOf(index, sourceId)
    .filter((event) => event.type === eventType && event.dependency)
    .map((event) => event.dependency!.id);
}

function collectStreamHops(index: NetLogIndex): StreamHop[] {
  const hops: StreamHop[] = [];
  for (const [sourceId, sourceType] of index.sourceTypes) {
    if (sourceType !== 'URL_REQUEST') continue;
    let current: StreamHop | undefined;
    for (const event of eventsOf(index, sourceId)) {
      if (event.type === 'HTTP_STREAM_REQUEST' && event.phase === 'begin') {
        current = { start: event.time, boundToExistingQuicSession: false };
        hops.push(current);
      } else if (!current) {
        continue;
      } else if (event.type === 'HTTP_STREAM_JOB_CONTROLLER_BOUND' && event.dependency) {
        current.controller = event.dependency.id;
      } else if (event.type === 'HTTP_STREAM_REQUEST_BOUND_TO_JOB' && event.dependency) {
        current.job = event.dependency.id;
        current.boundAt = event.time;
      } else if (event.type === 'HTTP_STREAM_REQUEST_BOUND_TO_QUIC_SESSION') {
        current.boundToExistingQuicSession = true;
        current.boundAt = event.time;
      }
    }
  }
  return hops;
}

function intervalsOf(index: NetLogIndex, sourceIds: Iterable<number>, eventType: string, window: Interval): Interval[] {
  const intervals: Interval[] = [];
  for (const sourceId of sourceIds) {
    const open: number[] = [];
    for (const event of eventsOf(index, sourceId)) {
      if (event.type !== eventType) continue;
      if (event.phase === 'begin') open.push(event.time);
      if (event.phase === 'end' && open.length > 0) intervals.push([open.pop()!, event.time]);
    }
    // An event still open when the stream was bound ran up to the binding.
    for (const start of open) intervals.push([start, window[1]]);
  }
  return intervals
    .map(([start, end]): Interval => [Math.max(start, window[0]), Math.min(end, window[1])])
    .filter(([start, end]) => end >= start);
}

/** Total covered time, so parallel attempts (IPv4/IPv6 races, racing jobs) are not double-counted. */
function unionLength(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    const from = Math.max(start, cursor);
    if (end > from) total += end - from;
    cursor = Math.max(cursor, end);
  }
  return total;
}

/** Connect jobs and sockets reachable from the winning connect job (proxy/SSL jobs wrap transport jobs). */
function connectGraph(index: NetLogIndex, connectJob: number): { connectJobs: Set<number>; sockets: Set<number> } {
  const connectJobs = new Set<number>();
  const sockets = new Set<number>();
  const queue = [connectJob];
  while (queue.length > 0) {
    const sourceId = queue.pop()!;
    if (connectJobs.has(sourceId)) continue;
    connectJobs.add(sourceId);
    for (const event of eventsOf(index, sourceId)) {
      if (!event.dependency) continue;
      if (event.dependency.type === 'SOCKET') sockets.add(event.dependency.id);
      else if (event.dependency.type.endsWith('CONNECT_JOB')) queue.push(event.dependency.id);
    }
  }
  return { connectJobs, sockets };
}

function measureHop(index: NetLogIndex, hop: StreamHop): HopTimings | null {
  if (hop.boundAt === undefined) return null;
  const window: Interval = [hop.start, hop.boundAt];

  // DNS for the request may run on any job its controller started: the TCP job often waits on
  // the alternative QUIC job's lookup and then hits the host cache.
  const streamJobs = new Set<number>(dependenciesOf(index, hop.controller, 'HTTP_STREAM_REQUEST_STARTED_JOB'));
  if (hop.job !== undefined) streamJobs.add(hop.job);
  const dnsSources = new Set<number>(hop.controller === undefined ? [] : [hop.controller]);
  for (const job of streamJobs) {
    dnsSources.add(job);
    for (const quicJob of dependenciesOf(index, job, 'BOUND_TO_QUIC_SESSION_POOL_JOB')) dnsSources.add(quicJob);
  }

  const winningJob = hop.job;
  const [connectJob] = dependenciesOf(index, winningJob, 'SOCKET_POOL_BOUND_TO_CONNECT_JOB');
  if (connectJob !== undefined) {
    const graph = connectGraph(index, connectJob);
    for (const socket of dependenciesOf(index, winningJob, 'SOCKET_POOL_BOUND_TO_SOCKET')) graph.sockets.add(socket);
    for (const job of graph.connectJobs) dnsSources.add(job);
    return {
      dns: unionLength(intervalsOf(index, dnsSources, 'HOST_RESOLVER_MANAGER_REQUEST', window)),
      tcp: unionLength(intervalsOf(index, graph.sockets, 'TCP_CONNECT', window)),
      tls: unionLength(intervalsOf(index, graph.sockets, 'SSL_CONNECT', window)),
      connection: 'new-tcp',
    };
  }

  const dns = unionLength(intervalsOf(index, dnsSources, 'HOST_RESOLVER_MANAGER_REQUEST', window));
  const [quicJob] = dependenciesOf(index, winningJob, 'BOUND_TO_QUIC_SESSION_POOL_JOB');
  if (quicJob !== undefined && eventsOf(index, quicJob).some((event) => event.type === 'QUIC_SESSION_CREATED')) {
    return {
      dns,
      tcp: 0,
      tls: unionLength(intervalsOf(index, [quicJob], 'QUIC_SESSION_POOL_JOB_CONNECT', window)),
      connection: 'new-quic',
    };
  }

  const reused = hop.boundToExistingQuicSession
    || [winningJob, quicJob].some((sourceId) => eventsOf(index, sourceId).some((event) => REUSE_EVENTS.has(event.type)));
  return reused ? { dns, tcp: 0, tls: 0, connection: 'reused' } : null;
}

export function parseNetLogConnectionTimings(text: string): NetLogConnectionTimings | null {
  const index = indexNetLog(parseNetLogJson(text));
  if (!index) return null;

  const hops = collectStreamHops(index);
  if (hops.length === 0) return null;

  // Redirect hops and auth restarts each set up (or reuse) a stream; their setup time adds up.
  const totals: NetLogConnectionTimings = { dns: 0, tcp: 0, tls: 0, connection: 'reused' };
  for (const hop of hops) {
    const timings = measureHop(index, hop);
    if (!timings) return null;
    totals.dns += timings.dns;
    totals.tcp += timings.tcp;
    totals.tls += timings.tls;
    if (timings.connection !== 'reused') totals.connection = timings.connection;
  }
  return totals;
}
