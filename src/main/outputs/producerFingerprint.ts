import { createHash, randomBytes } from 'crypto';
import type { Id, Request } from '@shared/types';

// A per-process salt: the digest covers resolved secrets, so it is only comparable within this run of the app.
const SALT = randomBytes(32);

const SAVED_FIELDS = ['method', 'url', 'headers', 'parameters', 'body', 'auth', 'settings', 'outputs'] as const;
const RESOLVED_FIELDS = ['method', 'url', 'headers', 'parameters', 'body', 'auth', 'settings'] as const;

function pick(request: Request, fields: readonly (keyof Request)[]): Record<string, unknown> {
  return Object.fromEntries(fields.map(field => [field, request[field]]));
}

/** JSON with object keys sorted at every level, so equal content always gives equal text. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry === undefined ? null : entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/**
 * What a cached value depends on: the token request as saved, the same request resolved (with fixed built-ins, so a
 * `{{uuid}}` doesn't change it), and the environment. Editing any of them, or any variable it uses, means a new fetch.
 * Names, timestamps, folders and stored responses are left out.
 */
export function computeProducerFingerprint(input: { saved: Request; resolved: Request; environmentId: Id | undefined }): string {
  const projection = {
    saved: pick(input.saved, SAVED_FIELDS),
    resolved: pick(input.resolved, RESOLVED_FIELDS),
    environmentId: input.environmentId ?? null,
  };
  return createHash('sha256').update(SALT).update(stableStringify(projection)).digest('hex');
}
