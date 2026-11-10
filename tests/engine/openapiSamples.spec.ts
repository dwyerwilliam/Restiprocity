import { expect, test } from '@playwright/test';
import { chooseSample, resolveSchema, schemaValue, serializeJson, synthesizeSchema, type SampleContext, type SampleNote } from '../../src/main/stores/openapiSamples';

const context = (document: unknown, version?: '3.0' | '3.1', notes: string[] = []): SampleContext => ({
  document,
  version,
  warnings: (note: SampleNote, detail?: string) => { notes.push(detail ? note + ' ' + detail : note); },
});

test('preserves falsy examples and uses deterministic schema defaults', () => {
  expect(chooseSample({ example: false }, context({}))).toEqual({ kind: 'value', value: false, explicit: true });
  expect(chooseSample({ example: 0 }, context({}))).toEqual({ kind: 'value', value: 0, explicit: true });
  expect(chooseSample({ example: '' }, context({}))).toEqual({ kind: 'value', value: '', explicit: true });
  expect(chooseSample({ example: null }, context({}))).toEqual({ kind: 'value', value: null, explicit: true });
  expect(synthesizeSchema({ type: 'object', properties: { active: { type: 'boolean' }, count: { type: 'integer' }, name: { type: 'string' }, nothing: { type: 'null' } } }, context({})))
    .toEqual({ kind: 'value', value: { active: false, count: 0, name: '', nothing: null }, explicit: false });
  expect(synthesizeSchema({ properties: { tags: { items: { type: 'number' } } } }, context({}))).toMatchObject({ value: { tags: [0] } });
});

test('omits recursive and composed branches while retaining explicit examples', () => {
  const schema: Record<string, unknown> = { type: 'object', properties: { name: { type: 'string', example: 'ok' } } };
  schema.properties = { ...schema.properties as Record<string, unknown>, self: schema };
  const notes: string[] = [];
  const result = synthesizeSchema(schema, context({}, undefined, notes));
  expect(result).toEqual({ kind: 'value', value: { name: 'ok' }, explicit: false });
  expect(notes).toContain('recursive-schema');
  expect(synthesizeSchema({ allOf: [{ type: 'object' }] }, context({}))).toEqual({ kind: 'missing', reason: 'schema composition is not generated' });
  expect(synthesizeSchema({ type: 'array', prefixItems: [{ type: 'string' }] }, context({}, '3.1'))).toMatchObject({ kind: 'missing', reason: 'tuple schemas are not generated' });
  expect(synthesizeSchema({ type: ['string', 'integer'] }, context({}, '3.1'))).toEqual({ kind: 'missing', reason: 'type unions are not generated' });
  expect(synthesizeSchema({ type: ['string', 'null'] }, context({}, '3.1'))).toEqual({ kind: 'value', value: '', explicit: false });
  expect(synthesizeSchema({ type: ['null'] }, context({}, '3.1'))).toEqual({ kind: 'value', value: null, explicit: false });
  const composedProperty: string[] = [];
  expect(synthesizeSchema({ type: 'object', properties: { pet: { oneOf: [{ type: 'string' }] }, ok: { type: 'boolean' } } }, context({}, undefined, composedProperty))).toMatchObject({ value: { ok: false } });
  expect(composedProperty).toEqual(['omitted-property pet: schema composition is not generated']);
  const reuse: string[] = [];
  const shared = { components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } } };
  expect(synthesizeSchema({ type: 'object', properties: { first: { $ref: '#/components/schemas/Pet' }, second: { $ref: '#/components/schemas/Pet' }, list: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } }, context(shared, '3.0', reuse)))
    .toEqual({ kind: 'value', value: { first: { name: '' }, second: { name: '' }, list: [{ name: '' }] }, explicit: false });
  expect(reuse).toEqual([]);
});

test('explicit schema values follow example, examples, default, enum, const', () => {
  const view = (schema: Record<string, unknown>, version: '3.0' | '3.1' = '3.1') => schemaValue(resolveSchema(schema, context({}, version))!, context({}, version));
  expect(view({ example: 'e', examples: ['x'], default: 'd', enum: ['n'], const: 'c' })).toMatchObject({ value: 'e' });
  expect(view({ examples: ['x', 'y'], default: 'd', enum: ['n'], const: 'c' })).toMatchObject({ value: 'x' });
  expect(view({ examples: [], default: 'd', enum: ['n'] })).toMatchObject({ value: 'd' });
  expect(view({ enum: ['n', 'm'], const: 'c' })).toMatchObject({ value: 'n' });
  expect(view({ const: 'c' })).toMatchObject({ value: 'c' });
  expect(view({ const: 'c' }, '3.0')).toEqual({ kind: 'missing' });
  expect(view({ examples: ['ignored in 3.0'], default: 'd' }, '3.0')).toMatchObject({ value: 'd' });
  expect(() => view({ examples: { named: { value: 1 } } })).toThrow('OpenAPI 3.1 schema examples must be an array.');
});

test('parameter and media examples skip missing and external values and reject conflicts', () => {
  const document = { components: { examples: { Remote: { externalValue: 'https://examples.example.test/pet.json' }, Described: { summary: 'only a summary' }, Inline: { value: { name: 'Milo' } } } } };
  const notes: string[] = [];
  const media = { examples: { remote: { $ref: '#/components/examples/Remote' }, described: { $ref: '#/components/examples/Described' }, inline: { $ref: '#/components/examples/Inline' }, later: { value: 'not chosen' } } };
  expect(chooseSample(media, context(document, '3.0', notes))).toEqual({ kind: 'value', value: { name: 'Milo' }, explicit: true });
  expect(notes).toEqual(['external-example', 'multiple-examples']);
  expect(chooseSample({ examples: { described: { summary: 'no value' } }, schema: { type: 'string', example: 'from schema' } }, context(document))).toMatchObject({ value: 'from schema' });
  expect(() => chooseSample({ example: 1, examples: {} }, context(document))).toThrow('cannot define both example and examples');
  expect(() => chooseSample({ examples: [{ value: 1 }] }, context(document))).toThrow('map of named examples');
  expect(chooseSample({ schema: { type: 'string', example: 'a', examples: ['b'] } }, context(document, '3.1'))).toMatchObject({ value: 'a' });
});

test('3.0 ignores reference siblings while 3.1 applies annotations and refuses assertion siblings', () => {
  const document = { components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } }, Id: { type: 'string', readOnly: true } } } };
  const sibling = { $ref: '#/components/schemas/Pet', example: { name: 'Sibling' } };
  expect(synthesizeSchema(sibling, context(document, '3.0'))).toEqual({ kind: 'value', value: { name: '' }, explicit: false });
  expect(synthesizeSchema(sibling, context(document, '3.1'))).toEqual({ kind: 'value', value: { name: 'Sibling' }, explicit: true });
  expect(chooseSample({ schema: { $ref: '#/components/schemas/Pet', default: { name: 'Default' } } }, context(document, '3.1'))).toMatchObject({ value: { name: 'Default' } });
  expect(synthesizeSchema({ $ref: '#/components/schemas/Pet', properties: { other: { type: 'string' } } }, context(document, '3.1')))
    .toEqual({ kind: 'missing', reason: 'keywords next to $ref are not combined with the referenced schema' });
  expect(synthesizeSchema({ $ref: '#/components/schemas/Pet', required: ['name'], example: { name: 'Explicit' } }, context(document, '3.1'))).toMatchObject({ value: { name: 'Explicit' } });
  const readOnly = { type: 'object', properties: { id: { $ref: '#/components/schemas/Id' }, alias: { $ref: '#/components/schemas/Pet', readOnly: true }, name: { type: 'string' } } };
  expect(synthesizeSchema(readOnly, context(document, '3.0'))).toMatchObject({ value: { alias: { name: '' }, name: '' } });
  expect(synthesizeSchema(readOnly, context(document, '3.1'))).toEqual({ kind: 'value', value: { name: '' }, explicit: false });
});

test('3.1 recursion through annotated references is omitted instead of exhausting the depth budget', () => {
  const document = { components: { schemas: { Node: { type: 'object', properties: { label: { type: 'string' }, child: { $ref: '#/components/schemas/Node', description: 'The child node' } } } } } };
  const notes: string[] = [];
  expect(synthesizeSchema({ $ref: '#/components/schemas/Node' }, context(document, '3.1', notes))).toEqual({ kind: 'value', value: { label: '' }, explicit: false });
  expect(notes).toEqual(['recursive-schema']);
});

test('3.1 schemas with custom dialects or their own base URI are not synthesized', () => {
  const pet = { type: 'object', properties: { name: { type: 'string' } } };
  expect(synthesizeSchema(pet, context({ jsonSchemaDialect: 'https://example.test/dialect' }, '3.1'))).toEqual({ kind: 'missing', reason: 'the document uses a custom JSON Schema dialect' });
  for (const dialect of ['https://spec.openapis.org/oas/3.1/dialect/base', 'https://spec.openapis.org/oas/3.1/dialect/2024-10-25', 'https://json-schema.org/draft/2020-12/schema']) {
    expect(synthesizeSchema({ ...pet, $schema: dialect }, context({ jsonSchemaDialect: dialect }, '3.1'))).toMatchObject({ kind: 'value', value: { name: '' } });
  }
  expect(synthesizeSchema({ ...pet, $id: 'https://example.test/pet' }, context({}, '3.1'))).toEqual({ kind: 'missing', reason: 'the schema uses $id, $anchor, or dynamic references' });
  expect(synthesizeSchema({ ...pet, $schema: 'https://example.test/custom' }, context({}, '3.1'))).toEqual({ kind: 'missing', reason: 'the schema declares a custom $schema' });
  expect(synthesizeSchema({ ...pet, $id: 'https://example.test/pet', example: { name: 'Explicit' } }, context({}, '3.1'))).toMatchObject({ value: { name: 'Explicit' } });
  expect(synthesizeSchema({ ...pet, $id: 'https://example.test/pet' }, context({}, '3.0'))).toMatchObject({ value: { name: '' } });
  const document = { components: { schemas: { Outer: { $id: 'https://example.test/outer', type: 'object', properties: { inner: pet } } } } };
  expect(synthesizeSchema({ $ref: '#/components/schemas/Outer/properties/inner' }, context(document, '3.1')))
    .toEqual({ kind: 'missing', reason: 'the referenced schema is inside a schema with its own $id or $schema' });
  const examplesNamedId = { components: { schemas: { Holder: { type: 'object', properties: { $id: { type: 'object', properties: { value: { type: 'string' } } } } } } } };
  expect(synthesizeSchema({ $ref: '#/components/schemas/Holder/properties/$id/properties/value' }, context(examplesNamedId, '3.1'))).toEqual({ kind: 'value', value: '', explicit: false });
});

test('sample budgets accept the limit and fail one step past it', () => {
  let deep: Record<string, unknown> = { type: 'string' };
  for (let index = 0; index < 3; index += 1) deep = { type: 'object', properties: { next: deep } };
  expect(synthesizeSchema(deep, { ...context({}), maxDepth: 3 })).toMatchObject({ kind: 'value' });
  expect(() => synthesizeSchema({ type: 'object', properties: { next: deep } }, { ...context({}), maxDepth: 3 })).toThrow('nested more than 3 levels deep');
  const wide = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } } };
  expect(synthesizeSchema(wide, { ...context({}), maxVisits: 4 })).toMatchObject({ kind: 'value' });
  expect(() => synthesizeSchema(wide, { ...context({}), maxVisits: 3 })).toThrow('more than 3 schema steps');
});

test('serializeJson matches JSON.stringify and stops at the byte limit', () => {
  const value = { name: 'Milo', nested: { list: [1, -0, 2.5, 1e21, true, null, 'é😀', [], {}], empty: '' }, 'odd "key"': ['\u0000\n'], infinite: Number.POSITIVE_INFINITY };
  expect(serializeJson(value, 'Example')).toBe(JSON.stringify(value, null, 2));
  expect(serializeJson('text', 'Example')).toBe('"text"');
  const exact = 'x'.repeat(1024 * 1024 - 2);
  expect(serializeJson(exact, 'Example')).toHaveLength(1024 * 1024);
  expect(() => serializeJson(exact + 'x', 'The example')).toThrow('The example is larger than the 1 MiB import limit.');
  let shared: unknown = ['lol', 'lol', 'lol', 'lol', 'lol', 'lol', 'lol', 'lol', 'lol', 'lol'];
  for (let level = 0; level < 9; level += 1) shared = Array.from({ length: 10 }, () => shared);
  const started = Date.now();
  expect(() => serializeJson(shared, 'The example')).toThrow('larger than the 1 MiB import limit');
  expect(Date.now() - started).toBeLessThan(2000);
});
