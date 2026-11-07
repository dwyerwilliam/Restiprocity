import { COLLECTION_EXPORT_FORMAT, COLLECTION_EXPORT_VERSION, type EnvironmentVariable } from '@shared/types';
import { CollectionImportError } from './collectionExport';
import { convertInsomniaExport, type InsomniaConversion } from './insomniaImport';

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const list = (v: unknown): Obj[] => Array.isArray(v) ? v.filter(object) : [];
const rows = (v: unknown) => list(v).map(r => ({ name: string(r.key), value: string(r.value), disabled: r.disabled === true }));

/** Convert Postman exports into the existing validated, transactional import representation. */
export function convertPostmanExport(data: unknown): InsomniaConversion | null {
  if (!object(data)) return null;
  const isEnvironment = data._postman_variable_scope === 'environment';
  const info = object(data.info) ? data.info : null;
  const schema = string(info?.schema);
  if (!isEnvironment && !schema.includes('getpostman.com/json/collection/')) return null;
  if (!isEnvironment && !/\/v2\.1\.0\/collection\.json(?:#.*)?$/.test(schema)) {
    throw new CollectionImportError('Only Postman collection v2.1 exports are supported. Export the collection as v2.1 and try again.');
  }
  const warnings: string[] = [];
  const warn = (message: string) => { if (!warnings.includes(message)) warnings.push(message); };
  const variables = (input: unknown): EnvironmentVariable[] => {
    const seen = new Set<string>();
    return list(input).flatMap(row => {
      const key = string(row.key);
      if (row.enabled === false || row.disabled === true) { warn('Disabled Postman variables were skipped.'); return []; }
      if (!key || /[{}\s]/.test(key) || seen.has(key)) { warn('Invalid or duplicate Postman variable names were skipped.'); return []; }
      seen.add(key);
      return [{ key, value: string(row.value), type: row.type === 'secret' ? 'secret' as const : 'standard' as const }];
    });
  };
  if (isEnvironment) {
    if (!Array.isArray(data.values)) throw new CollectionImportError('This Postman environment has no variables list.');
    return {
      bundle: { format: COLLECTION_EXPORT_FORMAT, version: COLLECTION_EXPORT_VERSION, exportedAt: '', roots: [], groups: [], requests: [] },
      environments: [{ sourceId: 'postman-environment', name: string(data.name) || 'Postman Environment', variables: variables(data.values) }], warnings,
    };
  }
  if (!Array.isArray(data.item)) throw new CollectionImportError('This Postman collection has no items list.');
  const auth = (raw: unknown): Obj | undefined => {
    if (!object(raw) || !raw.type || raw.type === 'inherit') return undefined;
    const type = string(raw.type);
    const fields = Object.fromEntries(list(raw[type]).map(row => [string(row.key), row.value]));
    switch (type) {
      case 'noauth': return { type: 'none' };
      case 'basic': return { type: 'basic', username: fields.username, password: fields.password };
      case 'bearer': return { type: 'bearer', token: fields.token };
      case 'apikey': return { type: 'apikey', key: fields.key, value: fields.value, addTo: fields.in === 'query' ? 'queryParams' : 'header' };
      default: warn(`Postman ${type} authentication was not imported; configure it manually.`); return { type: 'none' };
    }
  };
  const body = (raw: unknown, owner: string): Obj => {
    if (!object(raw) || raw.disabled === true) return {};
    const mode = string(raw.mode);
    if (mode === 'raw') {
      const options = object(raw.options) && object(raw.options.raw) ? raw.options.raw : {};
      const language = string(options.language);
      const mime: Record<string, string> = { json: 'application/json', xml: 'application/xml', html: 'text/html', text: 'text/plain', javascript: 'application/javascript' };
      return { text: string(raw.raw), ...(mime[language] ? { mimeType: mime[language] } : {}) };
    }
    if (mode === 'urlencoded') return { mimeType: 'application/x-www-form-urlencoded', params: rows(raw.urlencoded) };
    if (mode === 'formdata') return { mimeType: 'multipart/form-data', params: list(raw.formdata).map(row => {
      let source = row.src;
      if (Array.isArray(source)) { if (source.length > 1) warn(`Multiple file paths in "${owner}" were reduced to the first path.`); source = source[0]; }
      if (row.contentType) warn('Custom multipart part content types were not imported.');
      return { name: string(row.key), value: string(row.value), disabled: row.disabled === true, type: row.type === 'file' ? 'file' : 'text', fileName: string(source) };
    }) };
    if (mode) warn(`Postman ${mode} bodies are not supported and were skipped in "${owner}".`);
    return {};
  };
  const events = (raw: unknown, owner: string) => {
    if (list(raw).length) warn(`Postman scripts in "${owner}" were not imported and will not run.`);
  };
  const convertItems = (items: unknown, path: string, depth: number): Obj[] => {
    if (depth > 64) throw new CollectionImportError('The Postman collection contains too many nested folders.');
    return list(items).flatMap((item, index): Obj[] => {
      const id = `${path}/${index}`;
      const name = string(item.name) || 'Imported item';
      events(item.event, name);
      if (Array.isArray(item.variable) && item.variable.length) warn(`Folder variables in "${name}" were not imported.`);
      if (Array.isArray(item.item)) return [{ name, meta: { id, sortKey: index }, authentication: auth(item.auth), children: convertItems(item.item, id, depth + 1) }];
      const request = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request;
      if (!object(request)) { warn(`An unsupported item in "${name}" was skipped.`); return []; }
      const urlObj = object(request.url) ? request.url : null;
      let url = urlObj ? string(urlObj.raw) : string(request.url);
      if (!url && urlObj) warn(`The URL in "${name}" has no raw value and requires manual entry.`);
      if (urlObj && Array.isArray(urlObj.query) && urlObj.query.length > 0) {
        const hash = url.indexOf('#');
        const fragment = hash >= 0 ? url.slice(hash) : '';
        const main = hash >= 0 ? url.slice(0, hash) : url;
        url = main.split('?')[0] + fragment;
      }
      if (urlObj && Array.isArray(urlObj.variable) && urlObj.variable.length) warn(`Path variables in "${name}" require manual review.`);
      if (Array.isArray(item.response) && item.response.length) warn('Saved Postman example responses were not imported.');
      return [{ name, meta: { id, sortKey: index }, method: string(request.method) || 'GET', url, headers: rows(request.header), parameters: rows(urlObj?.query), body: body(request.body, name), authentication: auth(request.auth) }];
    });
  };
  const name = string(info?.name) || 'Postman Import';
  events(data.event, name);
  const pending: unknown[] = [data];
  const seenObjects = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && value.includes('{{$')) { warn('Postman dynamic variables are not evaluated by Restiprocity; replace them manually.'); break; }
    if (value && typeof value === 'object' && !seenObjects.has(value)) { seenObjects.add(value); for (const child of Object.values(value)) pending.push(child); }
  }
  const items = convertItems(data.item, 'postman', 0);
  const inherited = auth(data.auth);
  // The Insomnia converter applies folder authentication to all descendants.
  const converted = convertInsomniaExport({ type: 'collection.insomnia.rest/5.0', name, collection: [{ name, meta: { id: 'postman-root', sortKey: 0 }, authentication: inherited, children: items }] });
  if (!converted) throw new CollectionImportError('Could not convert this Postman collection.');
  // Remove the adapter's extra folder while preserving its inherited authentication.
  const outer = converted.bundle.groups.find(group => group.id === converted.bundle.roots[0]);
  const inner = converted.bundle.groups.find(group => group.id === 'postman-root');
  if (outer && inner) { outer.children = inner.children; converted.bundle.groups = converted.bundle.groups.filter(group => group !== inner); }
  const collectionVariables = variables(data.variable);
  if (collectionVariables.length) {
    converted.environments.push({ sourceId: 'postman-collection-variables', name: `${name} variables`, variables: collectionVariables });
    warn('Collection variables were imported as an environment; select it when using this collection.');
  }
  converted.warnings = [...warnings, ...converted.warnings];
  return converted;
}
