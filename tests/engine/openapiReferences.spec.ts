import { expect, test } from '@playwright/test';
import { CollectionImportError } from '../../src/main/stores/collectionExport';
import { assertOpenApiGraph, resolveLocalPointer, resolveReference, resolveReferenceChain } from '../../src/main/stores/openapiReferences';

test('resolves escaped local JSON pointers and rejects external targets', () => {
  const document = { components: { schemas: { 'A/B~C': { type: 'string' }, 'with space': { type: 'integer' } } } };
  expect(resolveLocalPointer(document, '#/components/schemas/A~1B~0C')).toEqual({ type: 'string' });
  expect(resolveLocalPointer(document, '#/components/schemas/with%20space')).toEqual({ type: 'integer' });
  expect(resolveLocalPointer({ values: [{ ok: true }] }, '#/values/0')).toEqual({ ok: true });
  expect(() => resolveLocalPointer(document, '#/components/schemas/Missing')).toThrow(CollectionImportError);
  expect(() => resolveLocalPointer(document, 'other.yaml#/Thing')).toThrow('external or unsupported');
  for (const reference of ['#', '#anchor', 'file:///etc/passwd#/x', './shared.yaml']) {
    expect(() => resolveLocalPointer(document, reference)).toThrow('Bundle referenced components into the selected OpenAPI file');
  }
});

test('rejects malformed escapes, non-canonical indices and inherited properties', () => {
  const document = { values: ['a', 'b'], plain: {} };
  expect(() => resolveLocalPointer(document, '#/values/01')).toThrow('missing array item');
  expect(() => resolveLocalPointer(document, '#/values/2')).toThrow('missing array item');
  expect(() => resolveLocalPointer(document, '#/values/-1')).toThrow('missing array item');
  expect(() => resolveLocalPointer(document, '#/plain/%zz')).toThrow('invalid URI escape');
  expect(() => resolveLocalPointer(document, '#/plain/a~2b')).toThrow('invalid JSON Pointer escape');
  for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect(() => resolveLocalPointer(document, '#/plain/' + inherited)).toThrow('points to a missing component');
  }
});

test('reference messages never echo credentials or query strings', () => {
  let message = '';
  try { resolveLocalPointer({}, 'https://user:hunter2@specs.example.test/shared.yaml?token=sentinel-token#/X'); } catch (error) { message = (error as Error).message; }
  expect(message).toContain('https://specs.example.test/shared.yaml#/X');
  expect(message).not.toContain('hunter2');
  expect(message).not.toContain('sentinel-token');
});

test('allows shared references but detects reference chains, cycles and hop limits', () => {
  const shared = { type: 'string' };
  const document = { components: { schemas: { A: shared, B: shared, C: { $ref: '#/components/schemas/A' } } } };
  expect(resolveReference(document, { $ref: '#/components/schemas/A' }, 'schema')).toBe(shared);
  expect(resolveReference(document, { $ref: '#/components/schemas/B' }, 'schema')).toBe(shared);
  const chain = resolveReferenceChain(document, { $ref: '#/components/schemas/C', description: 'outer' }, 'schema');
  expect(chain.target).toBe(shared);
  expect(chain.pointers).toEqual(['#/components/schemas/C', '#/components/schemas/A']);
  expect(chain.references[0]).toEqual({ $ref: '#/components/schemas/C', description: 'outer' });
  expect(() => resolveReference({ components: { A: { $ref: '#/components/A' } } }, { $ref: '#/components/A' }, 'schema')).toThrow('circular reference');
  const hops = (count: number) => {
    const links: Record<string, unknown> = { end: { type: 'string' } };
    for (let index = 0; index < count - 1; index += 1) links['l' + index] = { $ref: index === count - 2 ? '#/links/end' : '#/links/l' + (index + 1) };
    return { document: { links }, start: count === 1 ? { $ref: '#/links/end' } : { $ref: '#/links/l0' } };
  };
  const atLimit = hops(64);
  expect(resolveReference(atLimit.document, atLimit.start, 'schema')).toEqual({ type: 'string' });
  const overLimit = hops(65);
  expect(() => resolveReference(overLimit.document, overLimit.start, 'schema')).toThrow('follows more than 64 references');
});

test('graph checks accept shared acyclic values at the limits and reject cycles or one more value', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => assertOpenApiGraph(cyclic)).toThrow('cyclic object graph');
  const shared = { leaf: true };
  expect(() => assertOpenApiGraph({ a: shared, b: shared, c: [shared, shared] })).not.toThrow();
  const values = Array.from({ length: 9 }, (_, index) => index);
  expect(() => assertOpenApiGraph(values, 10)).not.toThrow();
  expect(() => assertOpenApiGraph([...values, 9], 10)).toThrow('more than 10 values');
  let nested: unknown = 'leaf';
  for (let index = 0; index < 4; index += 1) nested = { child: nested };
  expect(() => assertOpenApiGraph(nested, 100, 4)).not.toThrow();
  expect(() => assertOpenApiGraph({ child: nested }, 100, 4)).toThrow('nested more than 4 levels deep');
  expect(() => assertOpenApiGraph(Array.from({ length: 100_000 }, () => 0))).toThrow('more than 100,000 values');
});
