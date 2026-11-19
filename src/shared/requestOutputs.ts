import type {
  Header,
  PersistedResponseV2,
  Request,
  RequestOutputSource,
  RequestOutputs,
  RequestOutputValue,
  ResponseV2,
  TokenErrorCode,
} from './types';
import type { BuiltInVariableValues, VariableLayer } from './variableContext';

// Shared by the main process and the renderer: no Node or Electron imports here.

/** Matches the characters the `_.name` shorthand accepts, so an output can always be written either way. */
export const OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const RESERVED_OUTPUT_NAMES: ReadonlySet<string> = new Set(['timestamp', 'randomInt', 'uuid']);
/** Stands in for every output while a send works out which outputs it uses. Non-empty and free of `{{`. */
export const OUTPUT_PLACEHOLDER = 'restiprocity-output-placeholder';
/** Built-ins used when fingerprinting a token request, so `{{uuid}}` in its body doesn't force a new fetch each send. */
export const FINGERPRINT_BUILT_INS: BuiltInVariableValues = Object.freeze({
  timestamp: 0,
  randomInt: 0,
  uuid: '00000000-0000-0000-0000-000000000000',
});
export const OUTPUT_LIMITS = {
  maxValues: 10,
  minRefreshSeconds: 1,
  maxRefreshSeconds: 31_536_000,
  maxValueChars: 65_536,
  maxPointerChars: 1024,
  maxHeaderNameChars: 256,
} as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class OutputDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputDefinitionError';
  }
}

export function defaultRequestOutputs(): RequestOutputs {
  return {
    enabled: true,
    values: [{ name: 'api_token', source: { kind: 'json', pointer: '/access_token' } }],
    refreshAfterSeconds: 3600,
    expiresInPointer: '/expires_in',
    resendOn401: true,
  };
}

/** RFC 6901: '' is the whole document; otherwise "/" separated tokens with ~1 for "/" and ~0 for "~". */
export function parseJsonPointer(pointer: string): string[] {
  if (typeof pointer !== 'string') throw new OutputDefinitionError('A JSON field must be text.');
  if (pointer === '') return [];
  if (pointer.length > OUTPUT_LIMITS.maxPointerChars) {
    throw new OutputDefinitionError(`A JSON field can be at most ${OUTPUT_LIMITS.maxPointerChars} characters.`);
  }
  if (!pointer.startsWith('/')) throw new OutputDefinitionError(`JSON field "${pointer}" must start with "/", as in /access_token.`);
  return pointer.slice(1).split('/').map(token => {
    if (/~(?![01])/.test(token)) {
      throw new OutputDefinitionError(`JSON field "${pointer}" has an invalid "~" escape. Write ~0 for "~" and ~1 for "/".`);
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Reads own properties only, so inherited names such as `__proto__` or `constructor` are never found. */
export function readJsonPointer(document: unknown, tokens: readonly string[]): unknown {
  let current: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      const index = Number(token);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return undefined;
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The pointer to `name` next to the field `pointer` names: siblingPointer('/data/access_token', 'expires_in') → '/data/expires_in'. */
export function siblingPointer(pointer: string, name: string): string {
  const tokens = parseJsonPointer(pointer);
  return '/' + [...tokens.slice(0, -1), name].map(escapePointerToken).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSource(value: unknown, name: string): RequestOutputSource {
  if (!isRecord(value)) throw new OutputDefinitionError(`Output "${name}" needs a source.`);
  if (value.kind === 'json') {
    if (typeof value.pointer !== 'string') throw new OutputDefinitionError(`Output "${name}" needs a JSON field.`);
    parseJsonPointer(value.pointer);
    return { kind: 'json', pointer: value.pointer };
  }
  if (value.kind === 'header') {
    const header = typeof value.name === 'string' ? value.name.trim() : '';
    if (!header || header.length > OUTPUT_LIMITS.maxHeaderNameChars || !HEADER_NAME.test(header)) {
      throw new OutputDefinitionError(`Output "${name}" needs a valid response header name.`);
    }
    return { kind: 'header', name: header };
  }
  if (value.kind === 'body') return { kind: 'body' };
  throw new OutputDefinitionError(`Output "${name}" has an unknown source.`);
}

function validateOutputs(value: unknown): RequestOutputs {
  if (!isRecord(value)) throw new OutputDefinitionError('Outputs must be an object.');
  if (typeof value.enabled !== 'boolean') throw new OutputDefinitionError('Outputs need an on/off setting.');
  if (!Array.isArray(value.values)) throw new OutputDefinitionError('Outputs need a list of values.');
  if (value.values.length > OUTPUT_LIMITS.maxValues) {
    throw new OutputDefinitionError(`A request can have at most ${OUTPUT_LIMITS.maxValues} outputs.`);
  }
  if (value.enabled && value.values.length === 0) throw new OutputDefinitionError('Add at least one output, or turn outputs off.');
  const seen = new Set<string>();
  const values: RequestOutputValue[] = value.values.map(entry => {
    if (!isRecord(entry) || typeof entry.name !== 'string') throw new OutputDefinitionError('Every output needs a name.');
    const name = entry.name;
    if (!OUTPUT_NAME_PATTERN.test(name)) {
      throw new OutputDefinitionError(`Output name "${name.slice(0, 80)}" must start with a letter or underscore and use only letters, digits and underscores (at most 64).`);
    }
    if (RESERVED_OUTPUT_NAMES.has(name)) throw new OutputDefinitionError(`"${name}" is a built-in variable. Choose another output name.`);
    if (seen.has(name)) throw new OutputDefinitionError(`Output name "${name}" is used twice.`);
    seen.add(name);
    return { name, source: validateSource(entry.source, name) };
  });
  const seconds = value.refreshAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)
    || seconds < OUTPUT_LIMITS.minRefreshSeconds || seconds > OUTPUT_LIMITS.maxRefreshSeconds) {
    throw new OutputDefinitionError(`Refresh after must be a whole number of seconds from ${OUTPUT_LIMITS.minRefreshSeconds} to ${OUTPUT_LIMITS.maxRefreshSeconds.toLocaleString('en-US')}.`);
  }
  let expiresInPointer: string | null;
  if (value.expiresInPointer === null) expiresInPointer = null;
  else if (typeof value.expiresInPointer === 'string') {
    parseJsonPointer(value.expiresInPointer);
    expiresInPointer = value.expiresInPointer;
  } else throw new OutputDefinitionError('The expiry field must be a JSON field or empty.');
  if (typeof value.resendOn401 !== 'boolean') throw new OutputDefinitionError('Outputs need the resend-after-401 setting.');
  return { enabled: value.enabled, values, refreshAfterSeconds: seconds, expiresInPointer, resendOn401: value.resendOn401 };
}

/** Checks a definition from disk, an import or the window, and returns a copy with only known fields. */
export function validateRequestOutputs(value: unknown): { ok: true; outputs: RequestOutputs } | { ok: false; message: string } {
  try {
    return { ok: true, outputs: validateOutputs(value) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Outputs are not valid.' };
  }
}

export function enabledOutputNames(request: Pick<Request, 'outputs'>): string[] {
  return request.outputs?.enabled ? request.outputs.values.map(value => value.name) : [];
}

function describeJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `a ${typeof value}`;
}

function parseExpiresIn(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

type Extraction =
  | { ok: true; values: Record<string, string>; expiresInSeconds?: number }
  | { ok: false; code: TokenErrorCode; message: string };

/**
 * Takes the output values from a token response. Messages name the outputs, the request and the field, never a value
 * or the body. `bodyText` is null when the response has no complete, readable text body.
 */
export function extractOutputValues(
  response: { status: number; headers: Header[]; bodyText: string | null },
  outputs: RequestOutputs,
  sourceName?: string,
): Extraction {
  const source = sourceName ? `"${sourceName}"` : 'the token request';
  const all = outputs.values.map(value => `{{${value.name}}}`).join(', ');
  if (response.status < 200 || response.status > 299) {
    return { ok: false, code: 'TOKEN_SOURCE_HTTP', message: `Couldn't get ${all}: ${source} returned HTTP ${response.status}.` };
  }
  let parsed: { ok: true; value: unknown } | { ok: false } | undefined;
  const json = () => {
    if (!parsed) {
      if (response.bodyText === null) parsed = { ok: false };
      else {
        try {
          parsed = { ok: true, value: JSON.parse(response.bodyText) };
        } catch {
          parsed = { ok: false };
        }
      }
    }
    return parsed;
  };
  const values: Record<string, string> = {};
  for (const output of outputs.values) {
    const fail = (code: TokenErrorCode, reason: string): Extraction =>
      ({ ok: false, code, message: `Couldn't get {{${output.name}}}: ${reason}` });
    let value: string;
    let where: string;
    switch (output.source.kind) {
      case 'json': {
        where = output.source.pointer === '' ? 'the JSON body' : `JSON field "${output.source.pointer}"`;
        if (response.bodyText === null) return fail('TOKEN_SOURCE_NOT_TEXT', `${source} returned no readable text body.`);
        const document = json();
        if (!document.ok) return fail('TOKEN_EXTRACT_FAILED', `${source} did not return valid JSON.`);
        let tokens: string[];
        try {
          tokens = parseJsonPointer(output.source.pointer);
        } catch (error) {
          return fail('TOKEN_SOURCE_INVALID', (error as Error).message);
        }
        const found = readJsonPointer(document.value, tokens);
        if (found === undefined) return fail('TOKEN_EXTRACT_FAILED', `${where} is missing from the response of ${source}.`);
        if (typeof found !== 'string') return fail('TOKEN_EXTRACT_FAILED', `${where} is ${describeJson(found)}, not text.`);
        value = found;
        break;
      }
      case 'header': {
        const name = output.source.name.toLowerCase();
        where = `response header "${output.source.name}"`;
        const header = response.headers.find(entry => entry.key.toLowerCase() === name);
        if (!header) return fail('TOKEN_EXTRACT_FAILED', `${where} is missing from the response of ${source}.`);
        value = header.value.trim();
        break;
      }
      case 'body':
        where = 'the response body';
        if (response.bodyText === null) return fail('TOKEN_SOURCE_NOT_TEXT', `${source} returned no readable text body.`);
        value = response.bodyText.trim();
        break;
    }
    if (!value.trim()) return fail('TOKEN_EXTRACT_FAILED', `${where} is empty.`);
    if (value.length > OUTPUT_LIMITS.maxValueChars) {
      return fail('TOKEN_EXTRACT_FAILED', `${where} is longer than ${OUTPUT_LIMITS.maxValueChars.toLocaleString('en-US')} characters.`);
    }
    if (CONTROL_CHARACTERS.test(value)) return fail('TOKEN_EXTRACT_FAILED', `${where} contains control characters.`);
    values[output.name] = value;
  }
  let expiresInSeconds: number | undefined;
  if (outputs.expiresInPointer !== null && response.bodyText !== null) {
    const document = json();
    if (document.ok) {
      try {
        expiresInSeconds = parseExpiresIn(readJsonPointer(document.value, parseJsonPointer(outputs.expiresInPointer)));
      } catch {
        expiresInSeconds = undefined;
      }
    }
  }
  return expiresInSeconds === undefined ? { ok: true, values } : { ok: true, values, expiresInSeconds };
}

/**
 * How long fetched values stay fresh: the configured interval, or sooner when the response's expiry is shorter. A
 * response expiry is shortened by 10% (at most 30 s) so a value is replaced before the server stops accepting it.
 */
export function computeOutputTtlMs(refreshAfterSeconds: number, expiresInSeconds?: number): number {
  let ttl = refreshAfterSeconds * 1000;
  if (expiresInSeconds !== undefined && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    ttl = Math.min(ttl, expiresInSeconds * 1000 - Math.min(30_000, expiresInSeconds * 100));
  }
  return Math.max(1000, ttl);
}

/** The response of a request with outputs as it may be stored: no body, no header an output reads. */
export function withholdOutputsBody<T extends ResponseV2 | PersistedResponseV2>(response: T, outputs: RequestOutputs): T {
  const headerNames = new Set(outputs.values.flatMap(value => value.source.kind === 'header' ? [value.source.name.toLowerCase()] : []));
  return {
    ...response,
    headers: response.headers.filter(header => !headerNames.has(header.key.toLowerCase())),
    preview: { kind: 'empty', capturedBytes: 0, totalBytes: 0, truncated: false, completeness: 'unknown' },
    bodyWithheld: 'outputs',
  };
}

/** The variable layer for outputs: always last, literal and sensitive. */
export function buildOutputLayer(names: Iterable<string>, valueOf: (name: string) => string): VariableLayer {
  return [...names].map(name => ({ key: name, value: valueOf(name), type: 'output', literal: true }));
}
