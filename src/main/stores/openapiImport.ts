import {
  COLLECTION_EXPORT_FORMAT,
  COLLECTION_EXPORT_VERSION,
  type AuthConfig,
  type CollectionExportBundle,
  type Header,
  type HttpMethod,
  type MultipartField,
  type OAuth2GrantType,
  type QueryParameter,
  type RawBodyLanguage,
  type RequestBody,
  type RequestGroup,
} from '@shared/types';
import { parseHttpsOrLoopback } from '@shared/oauth';
import { CollectionImportError } from './collectionExport';
import { type ImportedEnvironment } from './insomniaImport';
import { assertOpenApiGraph, hasOwn, isRecord, resolveReferenceChain, type OpenApiObject, type ReferenceChain } from './openapiReferences';
import {
  MAX_EXAMPLE_BYTES,
  assertTextSize,
  chooseSample,
  isFileSchema,
  isReadOnly,
  resolveSchema,
  schemaType,
  schemaValue,
  serializeJson,
  synthesizeSchema,
  type SampleContext,
  type SampleNote,
} from './openapiSamples';

type Operation = { method: HttpMethod; path: string; label: string; ordinal: number; value: OpenApiObject };
type MediaKind = 'json' | 'form' | 'multipart' | 'text';
type Row = { key: string; value: string; enabled: boolean };

const METHODS: Array<[string, HttpMethod]> = [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['delete', 'DELETE'], ['head', 'HEAD'], ['options', 'OPTIONS']];
const PATH_ITEM_FIELDS = new Set([...METHODS.map(([key]) => key), 'parameters', 'servers', '$ref', 'summary', 'description']);
const MAX_OPERATIONS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_NOTES = 50;
const MAX_NOTE_LABELS = 5;
const PLACEHOLDER_ORIGIN = 'https://example.invalid';
const NO_OPERATIONS = 'No supported HTTP operations were found in this OpenAPI document.';
const OUTPUT_LIMIT = 'The converted OpenAPI collection would be larger than the 16 MiB import limit.';
const EXPRESSION = /\{\{[^{}]+\}\}/;
const UNSAFE_HEADER_TEXT = /[\r\n\u0000]/;
const SAMPLE_NOTES: Record<SampleNote, [category: string, message: string]> = {
  'multiple-examples': ['example-choice', 'Several named examples were offered; the first one with an inline value was used'],
  'external-example': ['external-example', 'External examples (externalValue) were not loaded'],
  'recursive-schema': ['recursive-schema', 'Recursive schema branches were left out of generated examples'],
  'omitted-property': ['omitted-property', 'Some schema properties could not be generated and were left out'],
};

/** Notes grouped by category, each naming its first five affected requests plus a count, in first-seen order. */
class ImportNotes {
  private readonly notes = new Map<string, { message: string; labels: Set<string> }>();
  private readonly omitted = new Set<string>();

  add(category: string, message: string, label?: string): void {
    let note = this.notes.get(category);
    if (!note) {
      if (this.notes.size >= MAX_NOTES) {
        this.omitted.add(category);
        return;
      }
      note = { message, labels: new Set() };
      this.notes.set(category, note);
    }
    if (label !== undefined) note.labels.add(label.length > 160 ? label.slice(0, 157) + '...' : label);
  }

  list(): string[] {
    const lines = [...this.notes.values()].map(({ message, labels }) => {
      if (!labels.size) return message + '.';
      const shown = [...labels].slice(0, MAX_NOTE_LABELS);
      const more = labels.size - shown.length;
      return (message + ': ' + shown.join(', ') + (more > 0 ? ' and ' + more + ' more' : '') + '.').slice(0, 1000);
    });
    if (this.omitted.size === 1) lines.push('1 more kind of import note was omitted.');
    else if (this.omitted.size > 1) lines.push(this.omitted.size + ' more kinds of import notes were omitted.');
    return lines;
  }
}

/** Running UTF-8 estimate of the converted output, charged before rows and bodies are appended. */
class OutputBudget {
  private bytes = 0;

  charge(...values: string[]): void {
    for (const value of values) this.bytes += Buffer.byteLength(value, 'utf8') + 16;
    if (this.bytes > MAX_OUTPUT_BYTES) throw new CollectionImportError(OUTPUT_LIMIT);
  }
}

interface Conversion {
  document: OpenApiObject;
  notes: ImportNotes;
  budget: OutputBudget;
  samples: SampleContext;
  environment: ImportedEnvironment;
  servers: Map<string, string>;
}

function requireRecord(value: unknown, message: string): OpenApiObject {
  if (!isRecord(value)) throw new CollectionImportError(message);
  return value;
}

function detailLabel(label: string, detail: string): string {
  return label + ' (' + (detail.length > 80 ? detail.slice(0, 77) + '...' : detail) + ')';
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function noteExpression(conversion: Conversion, label: string): void {
  conversion.notes.add('expressions', 'Some imported values contain {{...}} expressions, which resolve from the selected environment when sending', label);
}

function noteReferenceSiblings(conversion: Conversion, chain: ReferenceChain, label: string): void {
  const sibling = chain.references.flatMap(reference => Object.keys(reference)).find(key => key !== '$ref' && key !== 'summary' && key !== 'description');
  if (sibling !== undefined) conversion.notes.add('reference-siblings', 'Fields written next to $ref were ignored', detailLabel(label, sibling));
}

function pushRow<T extends Row>(conversion: Conversion, rows: T[], row: T, field: string, label: string): void {
  assertTextSize(row.value, field);
  conversion.budget.charge(row.key, row.value);
  if (EXPRESSION.test(row.key) || EXPRESSION.test(row.value)) noteExpression(conversion, label);
  rows.push(row);
}

function validatePath(path: string): void {
  if (!path.startsWith('/') || /[\u0000-\u001f\u007f\\?#]/.test(path) || hasDotSegment(path)) {
    throw new CollectionImportError('OpenAPI path "' + path.slice(0, 200) + '" is invalid for import.');
  }
  if (/[{}]/.test(path.replace(/\{[^{}]+\}/g, ''))) throw new CollectionImportError('OpenAPI path "' + path.slice(0, 200) + '" has an invalid template.');
}

function serverUrl(raw: OpenApiObject): { url: string; placeholder: boolean } {
  if (typeof raw.url !== 'string' || !raw.url) throw new CollectionImportError('An OpenAPI server is missing its URL.');
  if (raw.variables !== undefined && !isRecord(raw.variables)) throw new CollectionImportError('OpenAPI server variables must be an object.');
  const variables = isRecord(raw.variables) ? raw.variables : {};
  let value = raw.url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    if (!hasOwn(variables, name)) throw new CollectionImportError('OpenAPI server variable "' + name + '" is used but not defined.');
    const variable = requireRecord(variables[name], 'OpenAPI server variable "' + name + '" is invalid.');
    if (typeof variable.default !== 'string') throw new CollectionImportError('OpenAPI server variable "' + name + '" has no string default.');
    if (hasOwn(variable, 'enum') && (!Array.isArray(variable.enum) || !variable.enum.length || !variable.enum.every(item => typeof item === 'string') || !variable.enum.includes(variable.default))) {
      throw new CollectionImportError('OpenAPI server variable "' + name + '" has a default that is not in its enum.');
    }
    return variable.default;
  });
  if (/[{}]/.test(value)) throw new CollectionImportError('An OpenAPI server URL contains an unresolved variable.');
  if (/[\u0000-\u001f\u007f\\?#]/.test(value)) throw new CollectionImportError('An OpenAPI server URL must not contain control characters, backslashes, a query, or a fragment.');
  if (value.startsWith('//')) throw new CollectionImportError('Protocol-relative OpenAPI servers are unsupported; use an absolute HTTP or HTTPS server.');
  const placeholder = !/^[a-z][a-z\d+.-]*:/i.test(value);
  if (placeholder) value = PLACEHOLDER_ORIGIN + (value.startsWith('/') ? '' : '/') + value;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new CollectionImportError('An OpenAPI server URL is invalid.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new CollectionImportError('An OpenAPI server must use HTTP or HTTPS.');
  if (parsed.username || parsed.password) throw new CollectionImportError('An OpenAPI server URL must not contain credentials.');
  const authority = value.indexOf('//');
  const pathStart = value.indexOf('/', authority < 0 ? value.indexOf(':') + 1 : authority + 2);
  const path = pathStart < 0 ? '' : value.slice(pathStart);
  if (hasDotSegment(path)) throw new CollectionImportError('An OpenAPI server URL contains a dot segment.');
  // Keep the authored base path; only the origin is normalized.
  return { url: parsed.origin + path.replace(/\/+$/, ''), placeholder };
}

function serverVariable(conversion: Conversion, operation: Operation, pathItem: OpenApiObject): string {
  const owner = hasOwn(operation.value, 'servers') ? operation.value : hasOwn(pathItem, 'servers') ? pathItem : conversion.document;
  const servers = owner.servers === undefined ? [] : owner.servers;
  if (!Array.isArray(servers)) throw new CollectionImportError('OpenAPI servers must be an array.');
  let server = { url: PLACEHOLDER_ORIGIN, placeholder: true };
  if (servers.length) {
    if (servers.length > 1) conversion.notes.add('server-choice', 'Only the first of several OpenAPI servers was imported', operation.label);
    server = serverUrl(requireRecord(servers[0], 'The first OpenAPI server for ' + operation.label + ' is invalid.'));
  }
  let key = conversion.servers.get(server.url);
  if (!key) {
    key = 'openapi_server_' + (conversion.servers.size + 1);
    conversion.budget.charge(key, server.url);
    conversion.servers.set(server.url, key);
    conversion.environment.variables.push({ key, value: server.url, type: 'standard' });
  }
  if (server.placeholder) conversion.notes.add('placeholder-server', 'These server variables use the https://example.invalid placeholder because the document has no absolute server URL; set them before sending', key);
  return key;
}

function parameterKey(parameter: OpenApiObject): string {
  const location = String(parameter.in);
  const name = String(parameter.name);
  return location + '\0' + (location === 'header' ? name.toLowerCase() : name);
}

function validateParameters(conversion: Conversion, list: unknown[], owner: string): OpenApiObject[] {
  const seen = new Set<string>();
  return list.map(raw => {
    const chain = resolveReferenceChain(conversion.document, raw, owner + ' parameter');
    noteReferenceSiblings(conversion, chain, owner);
    const parameter = requireRecord(chain.target, owner + ' has an invalid parameter.');
    if (typeof parameter.name !== 'string' || !parameter.name || typeof parameter.in !== 'string' || !['path', 'query', 'header', 'cookie'].includes(parameter.in)) {
      throw new CollectionImportError(owner + ' has a parameter with an invalid name or location.');
    }
    const name = parameter.name;
    if (hasOwn(parameter, 'required') && typeof parameter.required !== 'boolean') throw new CollectionImportError(owner + ' parameter "' + name + '" has an invalid required flag.');
    if (parameter.schema !== undefined && parameter.content !== undefined) throw new CollectionImportError(owner + ' parameter "' + name + '" cannot define both schema and content.');
    if (parameter.content !== undefined && !isRecord(parameter.content)) throw new CollectionImportError(owner + ' parameter "' + name + '" has an invalid content map.');
    if (parameter.schema !== undefined) requireRecord(resolveReferenceChain(conversion.document, parameter.schema, owner + ' parameter schema').target, owner + ' parameter "' + name + '" has an invalid schema.');
    const key = parameterKey(parameter);
    if (seen.has(key)) throw new CollectionImportError(owner + ' contains a duplicate ' + parameter.in + ' parameter "' + name + '".');
    seen.add(key);
    return parameter;
  });
}

function encodePathValue(text: string): string | undefined {
  try {
    // Restiprocity expressions stay intact so they still resolve from the selected environment.
    return text.split(/(\{\{[^{}]+\}\})/).map((part, index) => index % 2 === 1 ? part : encodeURIComponent(part)).join('');
  } catch {
    return undefined;
  }
}

function parameterRows(conversion: Conversion, operation: Operation, parameters: OpenApiObject[]): { path: string; query: QueryParameter[]; headers: Header[] } {
  const { notes, samples } = conversion;
  const merged = new Map<string, OpenApiObject>();
  for (const parameter of parameters) merged.set(parameterKey(parameter), parameter);
  for (const match of operation.path.matchAll(/\{([^{}]+)\}/g)) {
    if (merged.get('path\0' + match[1])?.required !== true) throw new CollectionImportError(operation.label + ' path template "' + match[1] + '" has no required path parameter.');
  }
  const headers: Header[] = [];
  const query: QueryParameter[] = [];
  const replacements = new Map<string, string>();
  let ordinal = 0;
  for (const parameter of merged.values()) {
    ordinal += 1;
    const name = parameter.name as string;
    const location = parameter.in as string;
    const detail = detailLabel(operation.label, name);
    const field = 'The example for ' + location + ' parameter "' + name + '" in ' + operation.label;
    const required = parameter.required === true;
    const style = typeof parameter.style === 'string' ? parameter.style : location === 'query' || location === 'cookie' ? 'form' : 'simple';
    const explode = typeof parameter.explode === 'boolean' ? parameter.explode : style === 'form';
    const sample = parameter.content === undefined && location !== 'cookie' ? chooseSample(parameter, samples) : { kind: 'missing' as const };
    const value = sample.kind === 'value' ? sample.value : undefined;
    if (location === 'path') {
      if (!operation.path.includes('{' + name + '}')) throw new CollectionImportError(operation.label + ' declares path parameter "' + name + '" without a matching template.');
      const text = parameter.content === undefined && style === 'simple' ? scalarText(value) : undefined;
      const encoded = text === undefined || text === '.' || text === '..' ? undefined : encodePathValue(assertTextSize(text, field));
      if (encoded === undefined) {
        const key = 'openapi_path_' + operation.ordinal + '_' + ordinal;
        conversion.budget.charge(key, 'REPLACE_ME');
        conversion.environment.variables.push({ key, value: 'REPLACE_ME', type: 'standard' });
        replacements.set(name, '{{' + key + '}}');
        notes.add('path-placeholder', 'Path parameters without a usable example use REPLACE_ME environment variables; enter URL-encoded values before sending', detail);
      } else {
        if (EXPRESSION.test(encoded)) noteExpression(conversion, operation.label);
        replacements.set(name, encoded);
      }
      continue;
    }
    if (location === 'cookie') {
      notes.add('cookie-parameter', 'Cookie parameters were not imported; add a Cookie header manually', detail);
      continue;
    }
    if (location === 'header' && /^(accept|content-type|authorization)$/i.test(name)) continue;
    if (parameter.content !== undefined) {
      notes.add('content-parameter', 'Parameters serialized with content were not imported', detail);
      continue;
    }
    const missing = value === undefined || value === null;
    if (location === 'header') {
      if (style !== 'simple' || (!missing && typeof value === 'object')) {
        notes.add('header-unsupported', 'Header parameters with arrays, objects, or non-simple styles were not imported', detail);
        continue;
      }
      const text = missing ? '' : scalarText(value) ?? '';
      if (UNSAFE_HEADER_TEXT.test(name) || UNSAFE_HEADER_TEXT.test(text)) throw new CollectionImportError(operation.label + ' has a header parameter with line breaks or NUL characters.');
      pushRow(conversion, headers, { key: name, value: text, enabled: required }, field, operation.label);
      if (required && missing) notes.add('required-parameter', 'Required parameters without an example need values', detail);
      continue;
    }
    if (style !== 'form' || parameter.allowReserved === true || isRecord(value) || (Array.isArray(value) && (!explode || value.some(item => item !== null && typeof item === 'object')))) {
      notes.add('query-unsupported', 'Query parameters with objects, non-exploded arrays, allowReserved, or non-form styles were not imported', detail);
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) notes.add('empty-array', 'Empty array examples produced no rows', detail);
      for (const item of value) pushRow(conversion, query, { key: name, value: item === null ? '' : scalarText(item) ?? '', enabled: required }, field, operation.label);
      continue;
    }
    const schema = value === undefined ? resolveSchema(parameter.schema, samples) : null;
    if (schema && schemaType(schema.schema) === 'array') {
      pushRow(conversion, query, { key: name, value: '', enabled: false }, field, operation.label);
      notes.add('array-parameter', 'Array query parameters without an example start as one disabled empty row; add values before sending', detail);
      continue;
    }
    pushRow(conversion, query, { key: name, value: missing ? '' : scalarText(value) ?? '', enabled: required }, field, operation.label);
    if (required && missing) notes.add('required-parameter', 'Required parameters without an example need values', detail);
  }
  const path = operation.path.replace(/\{([^{}]+)\}/g, (match, name: string) => replacements.get(name) ?? match);
  return { path, query, headers };
}

function mediaKind(mime: string): { kind: MediaKind; tier: number } | undefined {
  // Concrete types only: wildcards such as text/* or application/*+json are not sent as Content-Type.
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return undefined;
  if (mime === 'application/json') return { kind: 'json', tier: 0 };
  if (mime.endsWith('+json')) return { kind: 'json', tier: 1 };
  if (mime === 'application/x-www-form-urlencoded') return { kind: 'form', tier: 2 };
  if (mime === 'multipart/form-data') return { kind: 'multipart', tier: 3 };
  if (mime.startsWith('text/') || mime === 'application/xml' || mime === 'application/javascript') return { kind: 'text', tier: 4 };
  return undefined;
}

function selectMedia(content: OpenApiObject): { contentType: string; mime: string; kind: MediaKind } | null {
  let best: { contentType: string; mime: string; kind: MediaKind; tier: number } | null = null;
  for (const contentType of Object.keys(content)) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    const kind = mediaKind(mime);
    if (kind && (!best || kind.tier < best.tier)) best = { contentType, mime, ...kind };
  }
  return best;
}

function rawLanguage(mime: string): RawBodyLanguage {
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'application/xml' || mime === 'text/xml') return 'xml';
  if (mime === 'text/html') return 'html';
  if (mime === 'application/javascript' || mime === 'text/javascript') return 'javascript';
  return 'text';
}

function exampleHasReadOnlyFields(conversion: Conversion, value: unknown, schema: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    const view = resolveSchema(schema, conversion.samples);
    const properties = view && isRecord(view.schema.properties) ? view.schema.properties : {};
    return Object.keys(value).some(key => {
      if (!hasOwn(properties, key)) return false;
      const property = resolveSchema(properties[key], conversion.samples);
      return property !== null && isReadOnly(property);
    });
  } catch {
    // Only a note depends on this; schema problems surface wherever the schema is actually used.
    return false;
  }
}

/** An explicit encoding is accepted only when it matches what the request editor sends by default. */
function encodingSupported(encoding: OpenApiObject | undefined, kind: 'form' | 'multipart', defaultType: string, repeated: boolean): boolean {
  if (!encoding) return true;
  if (encoding.contentType !== undefined) {
    if (typeof encoding.contentType !== 'string') return false;
    const types = encoding.contentType.split(',').map(item => item.split(';')[0].trim().toLowerCase());
    if (types.length !== 1 || types[0] !== defaultType) return false;
  }
  if (kind === 'multipart') return !(isRecord(encoding.headers) && Object.keys(encoding.headers).length > 0);
  if (encoding.style !== undefined && encoding.style !== 'form') return false;
  if (encoding.allowReserved === true) return false;
  return !(repeated && encoding.explode === false);
}

function formBody(conversion: Conversion, operation: Operation, kind: 'form' | 'multipart', media: OpenApiObject): RequestBody {
  const { notes, samples } = conversion;
  const label = operation.label;
  const field = 'The request body example for ' + label;
  const picked = chooseSample(media, samples);
  let example: OpenApiObject | undefined;
  if (picked.kind === 'value') {
    if (isRecord(picked.value)) example = picked.value;
    else notes.add('form-example', 'Form examples that are not objects were ignored', label);
  }
  if (media.encoding !== undefined && !isRecord(media.encoding)) throw new CollectionImportError(label + ' has an invalid encoding map.');
  const encoding = isRecord(media.encoding) ? media.encoding : {};
  const view = resolveSchema(media.schema, samples, label + ' body schema');
  const properties = view && isRecord(view.schema.properties) ? view.schema.properties : {};
  const required = new Set(view && Array.isArray(view.schema.required) ? view.schema.required.filter((item): item is string => typeof item === 'string') : []);
  const property = (key: string) => hasOwn(properties, key) ? resolveSchema(properties[key], samples, label + ' body field "' + key + '"') : null;
  const names = example ? Object.keys(example) : Object.keys(properties);
  if (example && kind === 'multipart') {
    // File fields come from the schema even when a whole-form example leaves them out.
    for (const key of Object.keys(properties)) {
      const schema = property(key);
      if (!hasOwn(example, key) && schema && isFileSchema(schema, samples)) names.push(key);
    }
  }
  const rows: MultipartField[] = [];
  let bytes = 0;
  const push = (row: MultipartField): void => {
    bytes += Buffer.byteLength(row.key, 'utf8') + Buffer.byteLength(row.value, 'utf8');
    if (bytes > MAX_EXAMPLE_BYTES) throw new CollectionImportError(field + ' is larger than the 1 MiB import limit.');
    pushRow(conversion, rows, row, field, label);
  };
  const omit = (key: string): void => notes.add('form-field-omitted', 'Form fields with nested values, file arrays, files in URL-encoded forms, or custom encodings were not imported', detailLabel(label, key));
  for (const key of names) {
    const schema = property(key);
    if (!example && schema && isReadOnly(schema)) continue;
    const fieldEncoding = hasOwn(encoding, key) ? requireRecord(encoding[key], label + ' has an invalid encoding for field "' + key + '".') : undefined;
    const items = schema && !isFileSchema(schema, samples) && schemaType(schema.schema) === 'array' ? resolveSchema(schema.schema.items, samples) : null;
    if (schema && isFileSchema(schema, samples)) {
      if (kind === 'form' || !encodingSupported(fieldEncoding, kind, 'application/octet-stream', false)) {
        omit(key);
        continue;
      }
      push({ key, type: 'file', value: '', filePath: '', enabled: false });
      notes.add('multipart-file', 'Multipart file fields start disabled with no file; select a local file and enable them before sending', detailLabel(label, key));
      continue;
    }
    if (items && isFileSchema(items, samples)) {
      omit(key);
      continue;
    }
    let value: unknown;
    if (example) value = example[key];
    else if (schema) {
      const sample = schemaValue(schema, samples);
      if (sample.kind === 'value') value = sample.value;
    }
    if (isRecord(value) || (Array.isArray(value) && value.some(item => item !== null && typeof item === 'object')) || !encodingSupported(fieldEncoding, kind, 'text/plain', Array.isArray(value))) {
      omit(key);
      continue;
    }
    const enabled = example !== undefined || required.has(key);
    if (Array.isArray(value)) {
      if (!value.length) notes.add('empty-array', 'Empty array examples produced no rows', detailLabel(label, key));
      for (const item of value) push({ key, type: 'text', value: item === null ? '' : scalarText(item) ?? '', enabled });
      continue;
    }
    const missing = value === undefined || value === null;
    if (missing && required.has(key)) notes.add('required-field', 'Required form fields without an example need values', detailLabel(label, key));
    push({ key, type: 'text', value: missing ? '' : scalarText(value) ?? '', enabled });
  }
  if (!rows.length) notes.add('form-empty', 'Form bodies with no importable fields are empty; add fields manually', label);
  if (kind === 'multipart') return { type: 'multipart', multipart: rows };
  return { type: 'form-urlencoded', form: rows.map(({ key, value, enabled }) => ({ key, value, enabled })) };
}

function bodyFor(conversion: Conversion, operation: Operation, headers: Header[]): RequestBody {
  const { notes, samples } = conversion;
  const label = operation.label;
  if (operation.value.requestBody === undefined) return { type: 'none' };
  if (operation.method === 'GET' || operation.method === 'HEAD') {
    notes.add('body-get-head', 'Request bodies on GET and HEAD operations were left out because they are not sent', label);
    return { type: 'none' };
  }
  const chain = resolveReferenceChain(conversion.document, operation.value.requestBody, label + ' request body');
  noteReferenceSiblings(conversion, chain, label);
  const body = requireRecord(chain.target, label + ' has an invalid request body.');
  const content = requireRecord(body.content, label + ' request body has no content map.');
  const selected = selectMedia(content);
  if (!selected) {
    notes.add('body-unsupported', 'Request bodies offering only unsupported media types, such as binary or wildcard types, were not imported', label);
    return { type: 'none' };
  }
  if (Object.keys(content).length > 1) notes.add('media-choice', 'Only one request body media type was imported where several were offered', detailLabel(label, selected.contentType));
  const media = requireRecord(content[selected.contentType], label + ' has an invalid request body media type.');
  if (selected.kind === 'form' || selected.kind === 'multipart') {
    const result = formBody(conversion, operation, selected.kind, media);
    if (selected.kind === 'form') pushRow(conversion, headers, { key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }, 'The Content-Type header for ' + label, label);
    return result;
  }
  const contentType = selected.contentType.trim();
  if (UNSAFE_HEADER_TEXT.test(contentType)) throw new CollectionImportError(label + ' has a request body media type with line breaks or NUL characters.');
  pushRow(conversion, headers, { key: 'Content-Type', value: contentType, enabled: true }, 'The Content-Type header for ' + label, label);
  const language = rawLanguage(selected.mime);
  const field = 'The request body example for ' + label;
  const picked = chooseSample(media, samples);
  let bodyText = '';
  if (selected.kind === 'text') {
    // Text, XML and JavaScript bodies use an authored scalar only; nothing is generated from schemas.
    const text = picked.kind === 'value' ? scalarText(picked.value) : undefined;
    if (text === undefined) notes.add('body-empty', 'Request bodies without a usable example were left empty; enter them manually', picked.kind === 'value' ? detailLabel(label, 'the example is not text') : label);
    else bodyText = assertTextSize(text, field);
  } else {
    let value: unknown;
    let generated = false;
    let reason: string | undefined;
    if (picked.kind === 'value') value = picked.value;
    else if (media.schema !== undefined) {
      const result = synthesizeSchema(media.schema, samples);
      if (result.kind === 'value') {
        value = result.value;
        generated = true;
      } else reason = result.reason;
    }
    if (value === undefined) notes.add('body-empty', 'Request bodies without a usable example were left empty; enter them manually', reason ? detailLabel(label, reason) : label);
    else {
      bodyText = serializeJson(value, field);
      if (generated) notes.add('body-generated', 'Generated request bodies are drafts that are not schema-validated; review them before sending', label);
      else if (exampleHasReadOnlyFields(conversion, value, media.schema)) notes.add('example-readonly', 'Request examples were copied without validation and include read-only fields', label);
    }
  }
  conversion.budget.charge(bodyText);
  if (EXPRESSION.test(bodyText)) noteExpression(conversion, label);
  return { type: 'raw', raw: { language, content: bodyText } };
}

function validOAuthEndpoints(grantType: OAuth2GrantType, authorizationUrl: string, tokenUrl: string): boolean {
  const endpoints = grantType === 'authorization_code' ? [authorizationUrl, tokenUrl] : [tokenUrl];
  return endpoints.every(endpoint => {
    if (!endpoint) return false;
    try {
      parseHttpsOrLoopback(endpoint, 'OAuth endpoint');
      return true;
    } catch {
      return false;
    }
  });
}

function oauthAuth(conversion: Conversion, scheme: OpenApiObject, name: string, scopes: string[], label: string): AuthConfig | null {
  const { notes, budget } = conversion;
  const flows = isRecord(scheme.flows) ? scheme.flows : {};
  const candidates = (['authorizationCode', 'clientCredentials'] as const).filter(key => isRecord(flows[key]));
  if (!candidates.length) {
    notes.add('auth-unsupported', 'Unsupported security schemes were skipped', detailLabel(label, name + ': OAuth without authorization code or client credentials'));
    return null;
  }
  if (candidates.length > 1) notes.add('oauth-flow-choice', 'OAuth schemes offering several flows use the first supported one (authorization code before client credentials)', label);
  for (const key of candidates) {
    const flow = flows[key] as OpenApiObject;
    const grantType: OAuth2GrantType = key === 'authorizationCode' ? 'authorization_code' : 'client_credentials';
    const authorizationUrl = grantType === 'authorization_code' && typeof flow.authorizationUrl === 'string' ? flow.authorizationUrl : '';
    const tokenUrl = typeof flow.tokenUrl === 'string' ? flow.tokenUrl : '';
    if (!validOAuthEndpoints(grantType, authorizationUrl, tokenUrl)) {
      notes.add('oauth-endpoint', 'OAuth flows with missing, relative, or non-HTTPS endpoints were skipped', detailLabel(label, name));
      continue;
    }
    if (typeof flow.refreshUrl === 'string' && flow.refreshUrl && flow.refreshUrl !== tokenUrl) notes.add('oauth-refresh', 'OAuth refresh URLs that differ from the token URL were not imported', label);
    const scope = scopes.join(' ');
    budget.charge(authorizationUrl, tokenUrl, scope);
    notes.add('auth-oauth', 'Configure OAuth 2.0 client settings and review the client authentication method; authorization code always uses PKCE S256', label);
    return {
      type: 'oauth2',
      oauth2: { grantType, authorizationUrl, tokenUrl, clientId: '', clientSecret: '', scope, redirectUri: '', clientAuthentication: grantType === 'client_credentials' ? 'basic' : 'none' },
    };
  }
  return null;
}

function schemeAuth(conversion: Conversion, scheme: OpenApiObject, name: string, scopes: string[], label: string): AuthConfig | null {
  const { notes } = conversion;
  const unsupported = (reason: string): null => {
    notes.add('auth-unsupported', 'Unsupported security schemes were skipped', detailLabel(label, name + ': ' + reason));
    return null;
  };
  const type = typeof scheme.type === 'string' ? scheme.type.toLowerCase() : '';
  if (type === 'http') {
    const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    if (httpScheme === 'basic') {
      notes.add('auth-basic', 'Enter basic authentication credentials', label);
      return { type: 'basic', basic: { username: '', password: '' } };
    }
    if (httpScheme === 'bearer') {
      // bearerFormat (such as JWT) only documents the token; the Authorization scheme is always Bearer.
      notes.add('auth-bearer', 'Enter bearer tokens', label);
      return { type: 'bearer', bearer: { token: '', prefix: 'Bearer' } };
    }
    return unsupported('HTTP ' + (httpScheme || 'without a scheme'));
  }
  if (type === 'apikey') {
    if ((scheme.in === 'header' || scheme.in === 'query') && typeof scheme.name === 'string' && scheme.name) {
      if (UNSAFE_HEADER_TEXT.test(scheme.name)) throw new CollectionImportError('OpenAPI security scheme "' + name + '" has an API key name with line breaks or NUL characters.');
      conversion.budget.charge(scheme.name);
      notes.add('auth-api-key', 'Enter API key values', label);
      return { type: 'api_key', api_key: { key: scheme.name, value: '', in: scheme.in } };
    }
    return unsupported(scheme.in === 'cookie' ? 'API key in a cookie' : 'API key without a header or query name');
  }
  if (type === 'oauth2') return oauthAuth(conversion, scheme, name, scopes, label);
  return unsupported(type === 'openidconnect' ? 'OpenID Connect' : type === 'mutualtls' ? 'mutual TLS' : 'unknown type');
}

function authFor(conversion: Conversion, operation: Operation): AuthConfig {
  const { notes, document } = conversion;
  const label = operation.label;
  const security = hasOwn(operation.value, 'security') ? operation.value.security : document.security;
  if (security === undefined || security === null) return { type: 'none' };
  if (!Array.isArray(security)) throw new CollectionImportError(label + ' security must be an array.');
  if (!security.length) return { type: 'none' };
  const components = isRecord(document.components) ? document.components : {};
  if (components.securitySchemes !== undefined && !isRecord(components.securitySchemes)) throw new CollectionImportError('OpenAPI components.securitySchemes must be an object.');
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  if (security.length > 1) notes.add('auth-choice', 'Several security options were offered; the first supported one was imported', label);
  for (const requirement of security) {
    if (!isRecord(requirement)) throw new CollectionImportError(label + ' has an invalid security requirement.');
    const names = Object.keys(requirement);
    for (const name of names) {
      const scopes = requirement[name];
      if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string')) throw new CollectionImportError(label + ' has an invalid scopes list for security scheme "' + name + '".');
    }
    if (!names.length) return { type: 'none' };
    if (names.length > 1) {
      notes.add('auth-combined', 'Security requirements that combine several schemes were skipped because a request has one authentication method', label);
      continue;
    }
    const name = names[0];
    if (!hasOwn(schemes, name)) throw new CollectionImportError(label + ' uses security scheme "' + name + '", which is not defined in components.securitySchemes.');
    const chain = resolveReferenceChain(document, schemes[name], 'OpenAPI security scheme "' + name + '"');
    noteReferenceSiblings(conversion, chain, label);
    const scheme = requireRecord(chain.target, 'OpenAPI security scheme "' + name + '" is invalid.');
    const scopes = requirement[name] as string[];
    const auth = schemeAuth(conversion, scheme, name, scopes, label);
    if (!auth) continue;
    if (auth.type !== 'oauth2' && scopes.length) notes.add('auth-roles', 'Role lists on non-OAuth security requirements are not sent', label);
    return auth;
  }
  notes.add('auth-manual', 'Authentication could not be imported for these requests; configure it manually', label);
  return { type: 'none' };
}

function hasIgnoredResponseParts(operation: OpenApiObject): boolean {
  if (isRecord(operation.callbacks) && Object.keys(operation.callbacks).length) return true;
  const responses = operation.responses;
  if (!isRecord(responses)) return false;
  return Object.keys(responses).some(code => {
    const response = responses[code];
    return isRecord(response) && (typeof response.$ref === 'string' || isRecord(response.content) || isRecord(response.links) || isRecord(response.headers));
  });
}

export interface OpenApiConversion { bundle: CollectionExportBundle; environments: ImportedEnvironment[]; warnings: string[]; }

export function convertOpenApiDocument(data: unknown): OpenApiConversion | null {
  if (!isRecord(data) || !hasOwn(data, 'openapi')) {
    if (isRecord(data) && hasOwn(data, 'swagger')) throw new CollectionImportError('Swagger 2.0 documents are not supported. Convert the document to OpenAPI 3.0 or 3.1, then import it again.');
    return null;
  }
  if (typeof data.openapi !== 'string' || !/^3\.(0|1)\.\d+$/.test(data.openapi)) {
    const declared = typeof data.openapi === 'string' ? 'version "' + data.openapi.slice(0, 40) + '"' : 'no string version';
    throw new CollectionImportError('Only OpenAPI 3.0.x and 3.1.x documents are supported; this document declares ' + declared + '.');
  }
  const version = data.openapi.startsWith('3.1.') ? '3.1' : '3.0';
  const info = requireRecord(data.info, 'The OpenAPI document is missing its info object.');
  if (typeof info.title !== 'string' || typeof info.version !== 'string' || !info.title.trim() || !info.version.trim()) {
    throw new CollectionImportError('The OpenAPI document needs string info.title and info.version.');
  }
  // 3.1 makes paths optional; a webhooks-only document has nothing to import as requests.
  if (version === '3.1' && data.paths === undefined) throw new CollectionImportError(NO_OPERATIONS);
  const paths = requireRecord(data.paths, 'The OpenAPI document is missing its paths object.');
  assertOpenApiGraph(data);

  const title = info.title.trim();
  const notes = new ImportNotes();
  const budget = new OutputBudget();
  const environment: ImportedEnvironment = { sourceId: 'openapi-environment', name: title + ' (OpenAPI)', variables: [] };
  let currentLabel = '';
  const samples: SampleContext = {
    document: data,
    version,
    warnings: (note, detail) => notes.add(SAMPLE_NOTES[note][0], SAMPLE_NOTES[note][1], detail ? detailLabel(currentLabel, detail) : currentLabel),
  };
  const conversion: Conversion = { document: data, notes, budget, samples, environment, servers: new Map() };
  notes.add('environment', 'Select "' + environment.name + '" and review server, parameter, body, and authentication values before sending');

  budget.charge(title, environment.name);
  const root: RequestGroup = { id: 'openapi-root', name: title, children: [], createdAt: 0, updatedAt: 0 };
  const groups: RequestGroup[] = [root];
  const tagGroups = new Map<string, RequestGroup>();
  const requests: CollectionExportBundle['requests'] = [];
  let ignoredResponses = version === '3.1' && isRecord(data.webhooks) && Object.keys(data.webhooks).length > 0;
  let ordinal = 0;
  for (const pathKey of Object.keys(paths)) {
    validatePath(pathKey);
    const rawPathItem = paths[pathKey];
    if (isRecord(rawPathItem) && typeof rawPathItem.$ref === 'string' && Object.keys(rawPathItem).some(key => key !== '$ref' && key !== 'summary' && key !== 'description')) {
      throw new CollectionImportError('OpenAPI path item references cannot combine $ref with operations or parameters.');
    }
    const pathItem = requireRecord(resolveReferenceChain(data, rawPathItem, 'OpenAPI path item ' + pathKey).target, 'OpenAPI path item "' + pathKey + '" is invalid.');
    for (const key of Object.keys(pathItem)) {
      if (PATH_ITEM_FIELDS.has(key) || key.startsWith('x-')) continue;
      if (key.toLowerCase() === 'trace') notes.add('trace', 'TRACE operations were not imported', 'TRACE ' + pathKey);
      else notes.add('unknown-path-field', 'Unknown path item fields were ignored', detailLabel(pathKey, key));
    }
    const pathParameters = pathItem.parameters === undefined ? [] : pathItem.parameters;
    if (!Array.isArray(pathParameters)) throw new CollectionImportError('OpenAPI path parameters for ' + pathKey + ' must be an array.');
    let sharedParameters: OpenApiObject[] | undefined;
    for (const [methodKey, method] of METHODS) {
      if (pathItem[methodKey] === undefined) continue;
      const value = requireRecord(resolveReferenceChain(data, pathItem[methodKey], 'OpenAPI operation ' + method + ' ' + pathKey).target, 'OpenAPI operation ' + method + ' ' + pathKey + ' is invalid.');
      ordinal += 1;
      if (ordinal > MAX_OPERATIONS) throw new CollectionImportError('The OpenAPI document contains more than 10,000 operations, which is more than this importer supports.');
      const operation: Operation = { method, path: pathKey, label: method + ' ' + pathKey, ordinal, value };
      currentLabel = operation.label;
      const tags = value.tags === undefined ? [] : value.tags;
      if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) throw new CollectionImportError(operation.label + ' tags must be an array of strings.');
      const operationParameters = value.parameters === undefined ? [] : value.parameters;
      if (!Array.isArray(operationParameters)) throw new CollectionImportError(operation.label + ' parameters must be an array.');
      const serverKey = serverVariable(conversion, operation, pathItem);
      sharedParameters ??= validateParameters(conversion, pathParameters, 'OpenAPI path ' + pathKey);
      const rows = parameterRows(conversion, operation, [...sharedParameters, ...validateParameters(conversion, operationParameters, operation.label)]);
      const body = bodyFor(conversion, operation, rows.headers);
      const auth = authFor(conversion, operation);
      const name = (typeof value.summary === 'string' && value.summary.trim()) || (typeof value.operationId === 'string' && value.operationId.trim()) || operation.label;
      const url = '{{' + serverKey + '}}' + rows.path;
      budget.charge(name, url, method);
      requests.push({ id: 'openapi-request-' + ordinal, name, method, url, headers: rows.headers, parameters: rows.query, body, auth, settings: { followRedirect: true, timeout: 30000 }, scripts: {}, createdAt: 0, updatedAt: 0 });
      if (hasIgnoredResponseParts(value)) ignoredResponses = true;
      const groupName = tags.length ? (tags[0] as string).trim() : '';
      if (!groupName) root.children.push('openapi-request-' + ordinal);
      else {
        let group = tagGroups.get(groupName);
        if (!group) {
          budget.charge(groupName);
          group = { id: 'openapi-group-' + (tagGroups.size + 1), name: groupName, children: [], createdAt: 0, updatedAt: 0 };
          tagGroups.set(groupName, group);
          groups.push(group);
          root.children.push(group.id);
        }
        group.children.push('openapi-request-' + ordinal);
        if (tags.length > 1) notes.add('tags', "Requests with several tags were placed only in their first tag's folder", operation.label);
      }
    }
  }
  if (!requests.length) throw new CollectionImportError(NO_OPERATIONS);
  if (ignoredResponses) notes.add('responses', 'Response definitions, examples, links, callbacks, and webhooks are not imported');
  const bundle: CollectionExportBundle = { format: COLLECTION_EXPORT_FORMAT, version: COLLECTION_EXPORT_VERSION, exportedAt: '', roots: [root.id], groups, requests };
  const environments = [environment];
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') + Buffer.byteLength(JSON.stringify(environments), 'utf8') > MAX_OUTPUT_BYTES) throw new CollectionImportError(OUTPUT_LIMIT);
  return { bundle, environments, warnings: notes.list() };
}
