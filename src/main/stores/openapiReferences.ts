import { CollectionImportError } from './collectionExport';

export type OpenApiObject = Record<string, unknown>;

export const MAX_GRAPH_VALUES = 100_000;
export const MAX_GRAPH_DEPTH = 64;
export const MAX_REFERENCE_HOPS = 64;

export function isRecord(value: unknown): value is OpenApiObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOwn(value: OpenApiObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** A reference for messages: credentials and query strings are never echoed. */
function displayReference(reference: string): string {
  return reference.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, '$1').replace(/\?[^#]*/, '').slice(0, 200);
}

/** Decoded JSON Pointer tokens of a same-document reference such as #/components/schemas/Pet. */
export function pointerTokens(reference: string, field = 'OpenAPI reference'): string[] {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new CollectionImportError(field + ' "' + displayReference(String(reference)) + '" is external or unsupported. Bundle referenced components into the selected OpenAPI file.');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(reference.slice(1)); } catch { throw new CollectionImportError(field + ' has an invalid URI escape.'); }
  return decoded.split('/').slice(1).map(token => {
    if (/~(?![01])/.test(token)) throw new CollectionImportError(field + ' contains an invalid JSON Pointer escape.');
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

export function resolveLocalPointer(document: unknown, reference: string, field = 'OpenAPI reference'): unknown {
  let current: unknown = document;
  for (const token of pointerTokens(reference, field)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) {
        throw new CollectionImportError(field + ' "' + displayReference(reference) + '" points to a missing array item.');
      }
      current = current[Number(token)];
    } else if (isRecord(current) && hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new CollectionImportError(field + ' "' + displayReference(reference) + '" points to a missing component.');
    }
  }
  return current;
}

export interface ReferenceChain {
  target: unknown;
  /** Every Reference Object followed, outermost first. */
  references: OpenApiObject[];
  pointers: string[];
}

export function resolveReferenceChain(document: unknown, value: unknown, field: string): ReferenceChain {
  const references: OpenApiObject[] = [];
  const pointers: string[] = [];
  let current = value;
  while (isRecord(current) && typeof current.$ref === 'string') {
    const reference = current.$ref;
    if (pointers.length >= MAX_REFERENCE_HOPS) throw new CollectionImportError(field + ' follows more than ' + MAX_REFERENCE_HOPS + ' references.');
    if (pointers.includes(reference)) throw new CollectionImportError(field + ' contains a circular reference (' + displayReference(reference) + ').');
    references.push(current);
    pointers.push(reference);
    current = resolveLocalPointer(document, reference, field);
  }
  return { target: current, references, pointers };
}

export function resolveReference(document: unknown, value: unknown, field: string): unknown {
  return resolveReferenceChain(document, value, field).target;
}

export function assertOpenApiGraph(value: unknown, maxVisits = MAX_GRAPH_VALUES, maxDepth = MAX_GRAPH_DEPTH): void {
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  let visits = 0;
  const walk = (current: unknown, depth: number): void => {
    if (depth > maxDepth) throw new CollectionImportError('The OpenAPI document is nested more than ' + maxDepth + ' levels deep, which this importer does not support.');
    visits += 1;
    if (visits > maxVisits) throw new CollectionImportError('The OpenAPI document has more than ' + maxVisits.toLocaleString('en-US') + ' values, which is more than this importer supports.');
    if (current === null || typeof current !== 'object') return;
    if (active.has(current)) throw new CollectionImportError('The OpenAPI document contains a cyclic object graph.');
    if (seen.has(current)) return;
    seen.add(current); active.add(current);
    if (Array.isArray(current)) current.forEach(item => walk(item, depth + 1));
    else Object.keys(current).forEach(key => walk((current as OpenApiObject)[key], depth + 1));
    active.delete(current);
  };
  walk(value, 0);
}
