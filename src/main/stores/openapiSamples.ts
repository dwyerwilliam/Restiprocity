import { CollectionImportError } from './collectionExport';
import { hasOwn, isRecord, pointerTokens, resolveReference, resolveReferenceChain, type OpenApiObject } from './openapiReferences';

export type SampleResult = { kind: 'value'; value: unknown; explicit: boolean } | { kind: 'missing'; reason?: string };
export type SampleNote = 'multiple-examples' | 'external-example' | 'recursive-schema' | 'omitted-property';
export interface SampleContext {
  document: unknown;
  /** Major and minor version; the 3.1 schema rules apply only to '3.1'. */
  version?: '3.0' | '3.1';
  warnings: (note: SampleNote, detail?: string) => void;
  visits?: number;
  maxVisits?: number;
  maxDepth?: number;
}

/** A resolved schema plus the 3.1 annotations written next to the references that led to it. */
export interface SchemaView {
  schema: OpenApiObject;
  annotations: OpenApiObject;
  /** Why the schema cannot be synthesized; explicit values still apply. */
  unsupported?: string;
}

export const MAX_EXAMPLE_BYTES = 1024 * 1024;
export const MAX_SAMPLE_DEPTH = 16;
export const MAX_SAMPLE_VISITS = 100_000;

const SUPPORTED_DIALECT = /^(?:https:\/\/spec\.openapis\.org\/oas\/3\.1\/dialect\/(?:base|\d{4}-\d{2}-\d{2})|https:\/\/json-schema\.org\/draft\/2020-12\/schema)$/;
const REFERENCE_ANNOTATIONS = new Set(['example', 'examples', 'default', 'readOnly', 'writeOnly', 'title', 'description', '$comment', 'deprecated']);
const IDENTITY_KEYWORDS = ['$id', '$anchor', '$dynamicRef', '$dynamicAnchor'];
const COMPOSITION_KEYWORDS = ['allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else'];
const SUBSCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema']);
const SUBSCHEMA_CONTAINERS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'prefixItems']);

function charge(context: SampleContext, steps = 1): void {
  context.visits = (context.visits ?? 0) + steps;
  const limit = context.maxVisits ?? MAX_SAMPLE_VISITS;
  if (context.visits > limit) throw new CollectionImportError('OpenAPI request examples need more than ' + limit.toLocaleString('en-US') + ' schema steps, which is more than this importer supports.');
}

function customDialect(value: unknown): boolean {
  return typeof value !== 'string' || !SUPPORTED_DIALECT.test(value);
}

/** True when a schema enclosing the pointer target sets its own $id or $schema, so local references inside it would not resolve against this document. */
function crossesSchemaBoundary(document: unknown, pointer: string): boolean {
  const tokens = pointerTokens(pointer);
  let current: unknown = document;
  let position: 'other' | 'schema' | 'schemas' = 'other';
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    current = Array.isArray(current) ? current[Number(token)] : isRecord(current) ? current[token] : undefined;
    if (position === 'schemas') position = 'schema';
    else if (position === 'schema') position = SUBSCHEMA_KEYWORDS.has(token) ? 'schema' : SUBSCHEMA_CONTAINERS.has(token) ? 'schemas' : 'other';
    else position = token === 'schema' ? 'schema' : token === 'schemas' && tokens[index - 1] === 'components' ? 'schemas' : 'other';
    if (position === 'schema' && isRecord(current) && (hasOwn(current, '$id') || (hasOwn(current, '$schema') && customDialect(current.$schema)))) return true;
  }
  return false;
}

export function resolveSchema(value: unknown, context: SampleContext, field = 'OpenAPI schema'): SchemaView | null {
  if (!isRecord(value)) return null;
  const chain = resolveReferenceChain(context.document, value, field);
  charge(context, chain.pointers.length);
  if (!isRecord(chain.target)) return null;
  const annotations: OpenApiObject = {};
  let unsupported: string | undefined;
  if (context.version === '3.1') {
    for (const reference of chain.references) {
      for (const key of Object.keys(reference)) {
        if (key === '$ref') continue;
        if (!REFERENCE_ANNOTATIONS.has(key)) {
          if (!unsupported) unsupported = 'keywords next to $ref are not combined with the referenced schema';
        } else if (!hasOwn(annotations, key)) annotations[key] = reference[key];
      }
    }
    if (!unsupported && chain.pointers.some(pointer => crossesSchemaBoundary(context.document, pointer))) {
      unsupported = 'the referenced schema is inside a schema with its own $id or $schema';
    }
  }
  return { schema: chain.target, annotations, unsupported };
}

function annotation(view: SchemaView, key: string): { found: boolean; value?: unknown } {
  if (hasOwn(view.annotations, key)) return { found: true, value: view.annotations[key] };
  if (hasOwn(view.schema, key)) return { found: true, value: view.schema[key] };
  return { found: false };
}

/** Explicit schema values in order: example, the first 3.1 examples item, default, the first enum entry, 3.1 const. */
export function schemaValue(view: SchemaView, context: SampleContext): SampleResult {
  const example = annotation(view, 'example');
  if (example.found) return { kind: 'value', value: example.value, explicit: true };
  if (context.version === '3.1') {
    const examples = annotation(view, 'examples');
    if (examples.found) {
      if (!Array.isArray(examples.value)) throw new CollectionImportError('OpenAPI 3.1 schema examples must be an array.');
      if (examples.value.length > 0) return { kind: 'value', value: examples.value[0], explicit: true };
    }
  }
  const fallback = annotation(view, 'default');
  if (fallback.found) return { kind: 'value', value: fallback.value, explicit: true };
  if (Array.isArray(view.schema.enum) && view.schema.enum.length > 0) return { kind: 'value', value: view.schema.enum[0], explicit: true };
  if (context.version === '3.1' && hasOwn(view.schema, 'const')) return { kind: 'value', value: view.schema.const, explicit: true };
  return { kind: 'missing' };
}

/** Parameter and Media Type values: example, otherwise the first named example with an inline value. */
function namedExample(object: OpenApiObject, context: SampleContext): SampleResult {
  const hasExample = hasOwn(object, 'example');
  const hasExamples = hasOwn(object, 'examples');
  if (hasExample && hasExamples) throw new CollectionImportError('OpenAPI parameters and media types cannot define both example and examples.');
  if (hasExample) return { kind: 'value', value: object.example, explicit: true };
  if (!hasExamples) return { kind: 'missing' };
  if (!isRecord(object.examples)) throw new CollectionImportError('OpenAPI examples must be a map of named examples.');
  const names = Object.keys(object.examples);
  for (let index = 0; index < names.length; index += 1) {
    const field = 'OpenAPI example "' + names[index] + '"';
    const example = resolveReference(context.document, object.examples[names[index]], field);
    if (!isRecord(example)) throw new CollectionImportError(field + ' is not an Example Object.');
    if (hasOwn(example, 'value')) {
      if (index < names.length - 1) context.warnings('multiple-examples');
      return { kind: 'value', value: example.value, explicit: true };
    }
    if (hasOwn(example, 'externalValue')) context.warnings('external-example');
  }
  return { kind: 'missing' };
}

/** The value for a Parameter or Media Type object: its own examples first, then its schema's explicit values. */
export function chooseSample(object: OpenApiObject, context: SampleContext): SampleResult {
  const named = namedExample(object, context);
  if (named.kind === 'value') return named;
  const view = resolveSchema(object.schema, context);
  return view ? schemaValue(view, context) : named;
}

export function schemaType(schema: OpenApiObject): string | undefined {
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((item): item is string => typeof item === 'string');
    const concrete = types.filter(item => item !== 'null');
    if (concrete.length === 1) return concrete[0];
    return concrete.length === 0 && types.length > 0 ? 'null' : undefined;
  }
  if (typeof schema.type === 'string') return schema.type;
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return undefined;
}

export function isReadOnly(view: SchemaView): boolean {
  return annotation(view, 'readOnly').value === true;
}

/** 3.0 marks file content with format: binary; 3.1 uses contentMediaType without a contentEncoding. */
export function isFileSchema(view: SchemaView, context: SampleContext): boolean {
  const schema = view.schema;
  if (schema.format === 'binary' || schema.contentEncoding === 'binary') return true;
  return context.version === '3.1' && typeof schema.contentMediaType === 'string' && !hasOwn(schema, 'contentEncoding');
}

function dialectProblem(schema: OpenApiObject, context: SampleContext): string | undefined {
  if (context.version !== '3.1') return undefined;
  const root = isRecord(context.document) ? context.document : {};
  if (hasOwn(root, 'jsonSchemaDialect') && customDialect(root.jsonSchemaDialect)) return 'the document uses a custom JSON Schema dialect';
  if (IDENTITY_KEYWORDS.some(key => hasOwn(schema, key))) return 'the schema uses $id, $anchor, or dynamic references';
  if (hasOwn(schema, '$schema') && customDialect(schema.$schema)) return 'the schema declares a custom $schema';
  return undefined;
}

export function synthesizeSchema(value: unknown, context: SampleContext): SampleResult {
  const view = resolveSchema(value, context);
  return view ? synthesizeView(view, context, 0, new Set()) : { kind: 'missing', reason: 'the schema is not an object' };
}

function synthesizeView(view: SchemaView, context: SampleContext, depth: number, active: Set<OpenApiObject>): SampleResult {
  const maxDepth = context.maxDepth ?? MAX_SAMPLE_DEPTH;
  if (depth > maxDepth) throw new CollectionImportError('An OpenAPI request schema is nested more than ' + maxDepth + ' levels deep, which this importer does not support.');
  charge(context);
  const explicit = schemaValue(view, context);
  if (explicit.kind === 'value') return explicit;
  const schema = view.schema;
  if (active.has(schema)) {
    context.warnings('recursive-schema');
    return { kind: 'missing' };
  }
  const unsupported = view.unsupported ?? dialectProblem(schema, context);
  if (unsupported) return { kind: 'missing', reason: unsupported };
  if (COMPOSITION_KEYWORDS.some(key => hasOwn(schema, key))) return { kind: 'missing', reason: 'schema composition is not generated' };
  if (hasOwn(schema, 'prefixItems') || Array.isArray(schema.items)) return { kind: 'missing', reason: 'tuple schemas are not generated' };
  const next = new Set(active).add(schema);
  const type = schemaType(schema);
  if (type === 'object') {
    const result: Record<string, unknown> = {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(properties)) {
      const property = resolveSchema(properties[key], context);
      if (property && isReadOnly(property)) continue;
      const child: SampleResult = property ? synthesizeView(property, context, depth + 1, next) : { kind: 'missing', reason: 'the schema is not an object' };
      if (child.kind === 'value') result[key] = child.value;
      else if (child.reason) context.warnings('omitted-property', key + ': ' + child.reason);
    }
    return { kind: 'value', value: result, explicit: false };
  }
  if (type === 'array') {
    if (schema.items === undefined) return { kind: 'value', value: [], explicit: false };
    const items = resolveSchema(schema.items, context);
    const child: SampleResult = items ? synthesizeView(items, context, depth + 1, next) : { kind: 'missing', reason: 'the item schema is not an object' };
    if (child.kind === 'value') return { kind: 'value', value: [child.value], explicit: false };
    if (child.reason) context.warnings('omitted-property', 'array items: ' + child.reason);
    return { kind: 'value', value: [], explicit: false };
  }
  if (type === 'string') return { kind: 'value', value: '', explicit: false };
  if (type === 'integer' || type === 'number') return { kind: 'value', value: 0, explicit: false };
  if (type === 'boolean') return { kind: 'value', value: false, explicit: false };
  if (type === 'null') return { kind: 'value', value: null, explicit: false };
  return { kind: 'missing', reason: Array.isArray(schema.type) ? 'type unions are not generated' : 'the schema has no supported type' };
}

function sizeError(field: string, limit: number): CollectionImportError {
  const size = limit % (1024 * 1024) === 0 ? limit / (1024 * 1024) + ' MiB' : limit + '-byte';
  return new CollectionImportError(field + ' is larger than the ' + size + ' import limit.');
}

export function assertTextSize(text: string, field: string, limit = MAX_EXAMPLE_BYTES): string {
  if (text.length > limit || Buffer.byteLength(text, 'utf8') > limit) throw sizeError(field, limit);
  return text;
}

/**
 * JSON.stringify(value, null, 2) that stops as soon as the output passes the limit, so shared YAML
 * aliases or large examples are never fully materialized.
 */
export function serializeJson(value: unknown, field: string, limit = MAX_EXAMPLE_BYTES): string {
  const parts: string[] = [];
  let bytes = 0;
  const push = (text: string): void => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > limit) throw sizeError(field, limit);
    parts.push(text);
  };
  const quote = (text: string): string => {
    if (text.length > limit) throw sizeError(field, limit);
    return JSON.stringify(text);
  };
  const write = (current: unknown, indent: string): void => {
    if (typeof current === 'string') return push(quote(current));
    if (typeof current === 'number') return push(Number.isFinite(current) ? String(current) : 'null');
    if (typeof current === 'boolean') return push(String(current));
    const inner = indent + '  ';
    if (Array.isArray(current)) {
      if (!current.length) return push('[]');
      push('[\n');
      current.forEach((item, index) => {
        push(inner);
        write(item, inner);
        push(index < current.length - 1 ? ',\n' : '\n');
      });
      return push(indent + ']');
    }
    if (isRecord(current)) {
      const keys = Object.keys(current).filter(key => current[key] !== undefined);
      if (!keys.length) return push('{}');
      push('{\n');
      keys.forEach((key, index) => {
        push(inner + quote(key) + ': ');
        write(current[key], inner);
        push(index < keys.length - 1 ? ',\n' : '\n');
      });
      return push(indent + '}');
    }
    push('null');
  };
  write(value, '');
  return parts.join('');
}
