import { expandUrlVariableShorthand } from './urlVariables';

export type BuiltInVariableValues = {
  readonly timestamp: number;
  readonly randomInt: number;
  readonly uuid: string;
};

export class InterpolationError extends Error {
  constructor(message: string) {
    super(`Interpolation error: ${message} Fix the variable or request and try again.`);
    this.name = 'InterpolationError';
  }
}

export type InterpolationResult = { value: string; sensitive: boolean; dependencies: string[]; missing: string[] };
type InternalResult = InterpolationResult & { depth: number };
export type VariableContext = {
  readonly interpolateString: (value: string) => string;
  readonly interpolate: <T>(value: T) => T;
  readonly resolve: (value: string) => InterpolationResult;
};

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const encoder = new TextEncoder();

export type VariableLayer = ReadonlyArray<{ key: string; value: string; type?: string }>;

export function createVariableContext(
  inheritedVariables: Iterable<readonly [string, string]>,
  builtIns: BuiltInVariableValues,
  sensitiveKeys: ReadonlySet<string> = new Set(),
  layers?: ReadonlyArray<VariableLayer>,
): VariableContext {
  const variables = new Map<string, string>([
    ...inheritedVariables,
    ...(layers ?? []).flatMap(layer => layer.map(item => [item.key, item.value] as const)),
    ['timestamp', String(builtIns.timestamp)],
    ['randomInt', String(builtIns.randomInt)],
    ['uuid', builtIns.uuid],
  ]);
  const knownKeys = new Set(variables.keys());
  const builtInKeys = new Set(['timestamp', 'randomInt', 'uuid']);
  const definitions = (layers ?? [[...variables].map(([key, value]) => ({ key, value, type: sensitiveKeys.has(key) ? 'secret' : undefined }))]).map(layer => new Map(layer.map(item => [item.key, item])));
  const memo = new Map<string, InternalResult>();

  function expand(input: string, stack: { key: string; layer: number }[]): InternalResult {
    const normalized = expandUrlVariableShorthand(input, { knownKeys, includeTrailingUnknown: true });
    const pattern = /\{\{\s*([^{}\s]+)\s*\}\}/g;
    const parts: string[] = [];
    const dependencies = new Set<string>();
    const missing = new Set<string>();
    let total = 0;
    let sensitive = false;
    let depth = 0;
    let cursor = 0;
    let substituted = false;
    const append = (part: string) => {
      parts.push(part);
      if (!substituted) return;
      for (let start = 0; start < part.length;) {
        let end = Math.min(start + 8192, part.length);
        if (end < part.length && /[\uD800-\uDBFF]/.test(part[end - 1])) end--;
        total += encoder.encode(part.slice(start, end)).length;
        if (total > MAX_BYTES) throw new InterpolationError('expanded text exceeds 1 MiB.');
        start = end;
      }
    };
    for (let match = pattern.exec(normalized); match; match = pattern.exec(normalized)) {
      append(normalized.slice(cursor, match.index));
      const key = match[1];
      dependencies.add(key);
      if (!variables.has(key)) {
        missing.add(key);
        append(match[0]);
      } else {
        if (!substituted) {
          substituted = true;
          const previous = parts.splice(0);
          previous.forEach(append);
        }
        const builtIn = builtInKeys.has(key);
        let layer = builtIn ? definitions.length : definitions.length - 1;
        const current = stack[stack.length - 1];
        if (!builtIn && current?.key === key) layer = current.layer - 1;
        while (!builtIn && layer >= 0 && !definitions[layer].has(key)) layer--;
        if (layer < 0 || stack.some(frame => frame.key === key && frame.layer === layer)) {
          throw new InterpolationError(`circular variable reference: ${[...stack.map(frame => frame.key), key].join(' → ')}.`);
        }
        if (stack.length >= MAX_DEPTH) throw new InterpolationError('variable nesting exceeds 64 levels.');
        const cacheKey = layer + ':' + key;
        let resolved = memo.get(cacheKey);
        if (!resolved) {
          const definition = builtIn ? undefined : definitions[layer].get(key)!;
          resolved = expand(builtIn ? variables.get(key)! : definition!.value, [...stack, { key, layer }]);
          if (definition?.type === 'secret') resolved.sensitive = true;
          memo.set(cacheKey, resolved);
        }
        if (stack.length + 1 + resolved.depth > MAX_DEPTH) throw new InterpolationError('variable nesting exceeds 64 levels.');
        depth = Math.max(depth, 1 + resolved.depth);
        resolved.dependencies.forEach(item => dependencies.add(item));
        resolved.missing.forEach(item => missing.add(item));
        sensitive ||= resolved.sensitive;
        append(resolved.value);
      }
      cursor = match.index + match[0].length;
    }
    append(normalized.slice(cursor));
    return { value: parts.join(''), sensitive, dependencies: [...dependencies], missing: [...missing], depth };
  }

  const resolve = (value: string) => expand(value, []);
  function interpolate<T>(value: T): T;
  function interpolate(value: unknown): unknown {
    if (typeof value === 'string') return resolve(value).value;
    if (Array.isArray(value)) return value.map(entry => interpolate(entry));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry)]));
    }
    return value;
  }
  return Object.freeze({ interpolateString: (value: string) => resolve(value).value, interpolate, resolve });
}
