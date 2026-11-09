import {
  COLLECTION_EXPORT_FORMAT,
  COLLECTION_EXPORT_VERSION,
  type AuthConfig,
  type CollectionExportBundle,
  type EnvironmentVariable,
  type Header,
  type HttpMethod,
  type MultipartField,
  type RawBodyLanguage,
  type RequestBody,
  type RequestGroup,
  type RequestScripts,
} from '@shared/types';
import { CollectionImportError } from './collectionExport';

/**
 * Converts Insomnia exports — v4 JSON (`__export_format: 4`) and v5 YAML/JSON
 * (`type: collection.insomnia.rest/5.0`) — into a native bundle plus environments.
 *
 * Restiprocity has no folder-level headers, auth, or variables, so folder headers and auth are
 * copied onto each request they apply to; folder variables can't be represented and are reported.
 * Anything that can't be carried over faithfully is listed in `warnings` instead of being dropped
 * silently.
 */

/** An environment to create; `parentSourceId` refers to another entry, or Core when absent. */
export interface ImportedEnvironment {
  sourceId: string;
  parentSourceId?: string;
  name: string;
  variables: EnvironmentVariable[];
}

export interface InsomniaConversion {
  bundle: CollectionExportBundle;
  environments: ImportedEnvironment[];
  warnings: string[];
}

type Row = { name: string; value: string; disabled: boolean; type?: string; fileName?: string };

interface FolderNode {
  kind: 'folder';
  id: string;
  name: string;
  sortKey: number;
  headers: Row[];
  auth: unknown;
  hasVariables: boolean;
  children: TreeNode[];
}

interface RequestNode {
  kind: 'request';
  id: string;
  name: string;
  sortKey: number;
  method: string;
  url: string;
  parameters: Row[];
  pathParameters: Row[];
  headers: Row[];
  body: Record<string, unknown>;
  auth: unknown;
  followRedirects: unknown;
  sendCookies: unknown;
  scripts: RequestScripts;
}

type TreeNode = FolderNode | RequestNode;

interface EnvironmentNode {
  id: string;
  name: string;
  data: unknown;
  confidentialKeys: string[];
  children: EnvironmentNode[];
}

interface Workspace {
  id: string;
  name: string;
  children: TreeNode[];
  environment: EnvironmentNode | null;
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const V5_TYPE = /^(collection|spec|environment|mock)\.insomnia\.rest\/5\.\d+$/;
const NON_HTTP_V4_TYPES = new Set(['grpc_request', 'websocket_request', 'socketio_request', 'mcp_request']);
const RAW_LANGUAGES: Record<string, RawBodyLanguage> = {
  'application/json': 'json',
  'application/graphql': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'text',
  'application/javascript': 'javascript',
};
const AUTH_LABELS: Record<string, string> = {
  digest: 'Digest',
  hawk: 'Hawk',
  iam: 'AWS IAM',
  asap: 'ASAP',
  netrc: 'Netrc',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function sortKey(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    name: text(row.name),
    value: text(row.value),
    disabled: row.disabled === true,
    ...(typeof row.type === 'string' ? { type: row.type } : {}),
    ...(typeof row.fileName === 'string' ? { fileName: row.fileName } : {}),
  })).filter((row) => row.name || row.value);
}

function scriptsOf(preRequest: unknown, afterResponse: unknown): RequestScripts {
  return {
    ...(typeof preRequest === 'string' && preRequest.trim() ? { preRequest } : {}),
    ...(typeof afterResponse === 'string' && afterResponse.trim() ? { afterResponse } : {}),
  };
}

function bySortKey<T extends { sortKey: number }>(nodes: T[]): T[] {
  // Stable: equal keys keep file order.
  return nodes.map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.sortKey - b.node.sortKey || a.index - b.index)
    .map(({ node }) => node);
}

/** Collects warnings by category so each category is reported once, naming what it affected. */
class Warnings {
  private readonly categories = new Map<string, { message: (names: string) => string; names: string[] }>();

  add(category: string, name: string, message: (names: string) => string): void {
    const entry = this.categories.get(category) ?? { message, names: [] };
    if (!entry.names.includes(name)) entry.names.push(name);
    this.categories.set(category, entry);
  }

  list(): string[] {
    return [...this.categories.values()].map(({ message, names }) => {
      const shown = names.slice(0, 3).map((name) => `"${name}"`).join(', ');
      return message(names.length > 3 ? `${shown} and ${names.length - 3} more` : shown);
    });
  }
}

// ─── Templates ────────────────────────────────────────────────

const VARIABLE_KEY = /^[^{}\s]+$/;

/**
 * Rewrites Insomnia's Nunjucks variable references (`{{ _.name }}`, `{{ _['name'] }}`, `{{ name }}`)
 * to `{{name}}`, and the `uuid`/`now 'millis'`/`timestamp` tags to the matching built-ins. Anything
 * else (filters, expressions, other tags) is left as written and reported.
 */
function convertTemplates(value: string, owner: string, warnings: Warnings): string {
  if (!value.includes('{{') && !value.includes('{%')) return value;
  const converted = value
    .replace(/\{\{\s*_\s*\[\s*(['"])(.+?)\1\s*\]\s*\}\}/g, (match, _quote, key: string) => (VARIABLE_KEY.test(key) ? `{{${key}}}` : match))
    .replace(/\{\{\s*(?:_\.)?([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\s*\}\}/g, '{{$1}}')
    .replace(/\{%\s*uuid(?:\s+['"]v4['"])?\s*%\}/g, '{{uuid}}')
    .replace(/\{%\s*(?:now\s+['"]millis['"]|timestamp)\s*%\}/g, '{{timestamp}}');
  const leftover = converted.replace(/\{\{[^{}\s]+\}\}/g, '');
  if (leftover.includes('{%') || leftover.includes('{{')) {
    warnings.add('templates', owner, (names) => `Insomnia template tags or expressions in ${names} were kept as written and won't be evaluated.`);
  }
  return converted;
}

// ─── Reading the two export formats ───────────────────────────

function isV4Export(data: unknown): data is Record<string, unknown> {
  return isRecord(data) && data._type === 'export' && Array.isArray(data.resources);
}

function isV5Export(data: unknown): data is Record<string, unknown> {
  return isRecord(data) && typeof data.type === 'string' && V5_TYPE.test(data.type);
}

/** True for any file Insomnia produced, including old formats this importer doesn't read. */
export function looksLikeInsomniaExport(data: unknown): boolean {
  if (isV4Export(data) || isV5Export(data)) return true;
  if (isRecord(data) && (typeof data.__export_format === 'number' || (typeof data.type === 'string' && data.type.includes('insomnia.rest')))) return true;
  return Array.isArray(data) && data.some((item) => isRecord(item) && typeof item._type === 'string');
}

function readV4(data: Record<string, unknown>, warnings: Warnings): Workspace[] {
  if (data.__export_format !== 4) {
    throw new CollectionImportError(`This Insomnia export uses format ${text(data.__export_format) || 'unknown'}. Re-export it from a current version of Insomnia and try again.`);
  }
  const resources = (data.resources as unknown[]).filter(isRecord).filter((resource) => typeof resource._id === 'string');
  const byParent = new Map<string, Record<string, unknown>[]>();
  for (const resource of resources) {
    const parent = text(resource.parentId);
    byParent.set(parent, [...(byParent.get(parent) ?? []), resource]);
  }

  const visited = new Set<string>();
  const readChildren = (parentId: string): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const resource of byParent.get(parentId) ?? []) {
      const id = resource._id as string;
      if (visited.has(id)) continue;
      visited.add(id);
      if (resource._type === 'request_group') {
        nodes.push({
          kind: 'folder',
          id,
          name: text(resource.name) || 'Imported Folder',
          sortKey: sortKey(resource.metaSortKey),
          headers: rows(resource.headers),
          auth: resource.authentication,
          hasVariables: isRecord(resource.environment) && Object.keys(resource.environment).length > 0,
          children: readChildren(id),
        });
      } else if (resource._type === 'request') {
        nodes.push({
          kind: 'request',
          id,
          name: text(resource.name) || 'Imported Request',
          sortKey: sortKey(resource.metaSortKey),
          method: text(resource.method),
          url: text(resource.url),
          parameters: rows(resource.parameters),
          pathParameters: rows(resource.pathParameters),
          headers: rows(resource.headers),
          body: isRecord(resource.body) ? resource.body : {},
          auth: resource.authentication,
          followRedirects: resource.settingFollowRedirects,
          sendCookies: resource.settingSendCookies,
          scripts: scriptsOf(resource.preRequestScript, resource.afterResponseScript),
        });
      } else if (NON_HTTP_V4_TYPES.has(text(resource._type))) {
        warnings.add('non-http', text(resource.name) || id, (names) => `gRPC, WebSocket, Socket.IO, and MCP requests aren't supported and were skipped: ${names}.`);
      }
    }
    return bySortKey(nodes);
  };

  const readEnvironment = (resource: Record<string, unknown>): EnvironmentNode => ({
    id: resource._id as string,
    name: text(resource.name),
    data: resource.data,
    confidentialKeys: [],
    children: (byParent.get(resource._id as string) ?? [])
      .filter((child) => child._type === 'environment')
      .map((child) => ({ ...readEnvironment(child), children: [] })),
  });

  const workspaces = resources.filter((resource) => resource._type === 'workspace');
  if (workspaces.length === 0) throw new CollectionImportError('This Insomnia export contains no workspaces to import.');
  return workspaces.map((workspace) => {
    const id = workspace._id as string;
    const base = (byParent.get(id) ?? []).find((resource) => resource._type === 'environment');
    return { id, name: text(workspace.name) || 'Insomnia Import', children: readChildren(id), environment: base ? readEnvironment(base) : null };
  });
}

function readV5Collection(items: unknown, warnings: Warnings, path: string): TreeNode[] {
  if (!Array.isArray(items)) return [];
  return bySortKey(items.filter(isRecord).flatMap((item, index): TreeNode[] => {
    const meta = isRecord(item.meta) ? item.meta : {};
    const id = text(meta.id) || `${path}/${index}`;
    const name = text(item.name);
    const settings = isRecord(item.settings) ? item.settings : {};
    if ('method' in item && 'url' in item) {
      const cookies = isRecord(settings.cookies) ? settings.cookies : {};
      const scripts = isRecord(item.scripts) ? item.scripts : {};
      return [{
        kind: 'request',
        id,
        name: name || 'Imported Request',
        sortKey: sortKey(meta.sortKey),
        method: text(item.method),
        url: text(item.url),
        parameters: rows(item.parameters),
        pathParameters: rows(item.pathParameters),
        headers: rows(item.headers),
        body: isRecord(item.body) ? item.body : {},
        auth: item.authentication,
        followRedirects: settings.followRedirects,
        sendCookies: cookies.send,
        scripts: scriptsOf(scripts.preRequest, scripts.afterResponse),
      }];
    }
    if ('url' in item || 'reflectionApi' in item || 'protoMethodName' in item) {
      warnings.add('non-http', name || id, (names) => `gRPC, WebSocket, Socket.IO, and MCP requests aren't supported and were skipped: ${names}.`);
      return [];
    }
    return [{
      kind: 'folder',
      id,
      name: name || 'Imported Folder',
      sortKey: sortKey(meta.sortKey),
      headers: rows(item.headers),
      auth: item.authentication,
      hasVariables: isRecord(item.environment) && Object.keys(item.environment).length > 0,
      children: readV5Collection(item.children, warnings, id),
    }];
  }));
}

function readV5Environment(raw: unknown, fallbackId: string): EnvironmentNode {
  const env = isRecord(raw) ? raw : {};
  const meta = isRecord(env.meta) ? env.meta : {};
  const id = text(meta.id) || fallbackId;
  return {
    id,
    name: text(env.name),
    data: env.data,
    confidentialKeys: Array.isArray(env.confidentialKeys) ? env.confidentialKeys.filter((key): key is string => typeof key === 'string') : [],
    children: Array.isArray(env.subEnvironments)
      ? env.subEnvironments.map((sub, index) => ({ ...readV5Environment(sub, `${id}/${index}`), children: [] }))
      : [],
  };
}

function readV5(data: Record<string, unknown>, warnings: Warnings): Workspace[] {
  const type = data.type as string;
  if (type.startsWith('mock.')) throw new CollectionImportError('This is an Insomnia mock server export, which has no requests to import.');
  const meta = isRecord(data.meta) ? data.meta : {};
  const name = text(data.name) || 'Insomnia Import';
  if (type.startsWith('spec.') && data.spec !== undefined) {
    warnings.add('spec', name, (names) => `The API spec in ${names} isn't supported; only its requests were imported.`);
  }
  if (Array.isArray(data.testSuites) && data.testSuites.length > 0) {
    warnings.add('tests', name, (names) => `Test suites in ${names} aren't supported and were skipped.`);
  }
  if (Array.isArray(data.mcpRequests) && data.mcpRequests.length > 0) {
    warnings.add('non-http', name, (names) => `gRPC, WebSocket, Socket.IO, and MCP requests aren't supported and were skipped: ${names}.`);
  }
  const id = text(meta.id) || 'workspace';
  return [{
    id,
    name,
    children: type.startsWith('environment.') ? [] : readV5Collection(data.collection, warnings, id),
    environment: data.environments === undefined ? null : readV5Environment(data.environments, `${id}/env`),
  }];
}

// ─── Converting to Restiprocity requests ──────────────────────

function convertAuth(raw: unknown, owner: string, warnings: Warnings): AuthConfig | 'inherit' {
  if (!isRecord(raw) || typeof raw.type !== 'string' || raw.type === '' || raw.type === 'inherit') return 'inherit';
  if (raw.disabled === true || raw.type === 'none') return { type: 'none' };
  const value = (key: string) => convertTemplates(text(raw[key]), owner, warnings);
  switch (raw.type) {
    case 'bearer':
      return { type: 'bearer', bearer: { token: value('token'), prefix: value('prefix') || 'Bearer' } };
    case 'basic':
      return { type: 'basic', basic: { username: value('username'), password: value('password') } };
    case 'apikey': {
      if (raw.addTo === 'cookie') {
        warnings.add('apikey-cookie', owner, (names) => `API keys sent as a cookie aren't supported; set a Cookie header instead for ${names}.`);
        return { type: 'none' };
      }
      return { type: 'api_key', api_key: { key: value('key'), value: value('value'), in: raw.addTo === 'queryParams' ? 'query' : 'header' } };
    }
    case 'ntlm': {
      const username = value('username');
      const separator = username.indexOf('\\');
      return {
        type: 'ntlm',
        ntlm: {
          useCurrentAuthContext: false,
          username: separator >= 0 ? username.slice(separator + 1) : username,
          password: value('password'),
          ...(separator > 0 ? { domain: username.slice(0, separator) } : {}),
        },
      };
    }
    case 'oauth2': {
      const grant = text(raw.grantType);
      const grantType = grant === 'authorization_code' ? (raw.usePkce === true ? 'pkce' : 'authorization_code')
        : grant === 'client_credentials' || grant === 'password' ? grant : null;
      if (!grantType) {
        warnings.add('oauth2-grant', owner, (names) => `OAuth 2.0 implicit and refresh-token grants aren't supported; authentication was not imported for ${names}.`);
        return { type: 'none' };
      }
      if (grantType === 'password') {
        warnings.add('oauth2-password', owner, (names) => `OAuth 2.0 password grants were imported for ${names}, but this grant is intentionally blocked; use Authorization Code with PKCE.`);
      }
      return {
        type: 'oauth2',
        oauth2: {
          grantType,
          authorizationUrl: value('authorizationUrl'),
          tokenUrl: value('accessTokenUrl'),
          clientId: value('clientId'),
          clientSecret: value('clientSecret'),
          scope: value('scope'),
          redirectUri: value('redirectUrl'),
          ...(raw.clientAuthentication === 'basic' ? { clientAuthentication: 'basic' as const } : raw.clientAuthentication === 'none' ? { clientAuthentication: 'none' as const } : {}),
        },
      };
    }
    default: {
      const label = AUTH_LABELS[raw.type] ?? raw.type;
      warnings.add(`auth-${raw.type}`, owner, (names) => `${label} authentication isn't supported; it was not imported for ${names}.`);
      return { type: 'none' };
    }
  }
}

function hasHeader(headers: Header[], name: string): boolean {
  return headers.some((header) => header.enabled && header.key.toLowerCase() === name);
}

function convertBody(raw: Record<string, unknown>, headers: Header[], owner: string, warnings: Warnings): RequestBody {
  const mimeType = text(raw.mimeType).split(';')[0].trim().toLowerCase();
  const params = rows(raw.params);
  const setContentType = (value: string) => {
    if (!hasHeader(headers, 'content-type')) headers.push({ key: 'Content-Type', value, enabled: true });
  };

  if (mimeType === 'application/x-www-form-urlencoded') {
    setContentType('application/x-www-form-urlencoded');
    return {
      type: 'form-urlencoded',
      form: params.map((param) => ({ key: convertTemplates(param.name, owner, warnings), value: convertTemplates(param.value, owner, warnings), enabled: !param.disabled })),
    };
  }
  if (mimeType === 'multipart/form-data') {
    // Preserve existing import normalization; sends generate their own matching multipart boundary.
    for (let index = headers.length - 1; index >= 0; index -= 1) {
      if (headers[index].key.toLowerCase() === 'content-type' && !/boundary=/i.test(headers[index].value)) headers.splice(index, 1);
    }
    return {
      type: 'multipart',
      multipart: params.map((param): MultipartField => {
        const key = convertTemplates(param.name, owner, warnings);
        if (param.type === 'file') return { key, type: 'file', value: param.fileName ?? '', filePath: param.fileName ?? '', enabled: !param.disabled };
        return { key, type: 'text', value: convertTemplates(param.value, owner, warnings), enabled: !param.disabled };
      }),
    };
  }
  if (typeof raw.fileName === 'string' && raw.fileName) {
    warnings.add('binary-body', owner, (names) => `Binary file bodies aren't supported; the body was not imported for ${names}.`);
    return { type: 'none' };
  }
  const content = text(raw.text);
  if (!mimeType && !content) return { type: 'none' };
  // GraphQL bodies are already the JSON payload Insomnia sends.
  if (mimeType) setContentType(mimeType === 'application/graphql' ? 'application/json' : mimeType);
  return { type: 'raw', raw: { language: RAW_LANGUAGES[mimeType] ?? 'text', content: convertTemplates(content, owner, warnings) } };
}

function convertHeaders(source: Row[], owner: string, warnings: Warnings): Header[] {
  return source.map((row) => ({
    key: convertTemplates(row.name, owner, warnings),
    value: convertTemplates(row.value, owner, warnings),
    enabled: !row.disabled,
  }));
}

/** Folder headers apply first; a request header with the same name replaces an inherited one. */
function mergeHeaders(inherited: Header[], own: Header[]): Header[] {
  const ownNames = new Set(own.filter((header) => header.enabled).map((header) => header.key.toLowerCase()));
  return [...inherited.filter((header) => !ownNames.has(header.key.toLowerCase())), ...own];
}

/** Replaces `:name` path segments with Insomnia's path parameter values. */
function applyPathParameters(url: string, parameters: Row[]): string {
  let result = url;
  for (const parameter of parameters) {
    if (!parameter.name || parameter.disabled) continue;
    const escaped = parameter.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`/:${escaped}(?=[/?#]|$)`, 'g'), () => `/${parameter.value}`);
  }
  return result;
}

interface Inherited {
  headers: Header[];
  auth: AuthConfig;
}

function convertRequest(node: RequestNode, inherited: Inherited, warnings: Warnings): CollectionExportBundle['requests'][number] | null {
  const method = node.method.toUpperCase();
  if (!HTTP_METHODS.includes(method as HttpMethod)) {
    warnings.add('method', node.name, (names) => `Requests with methods Restiprocity doesn't support were skipped: ${names}.`);
    return null;
  }
  const headers = mergeHeaders(inherited.headers, convertHeaders(node.headers, node.name, warnings));
  const body = convertBody(node.body, headers, node.name, warnings);
  const auth = convertAuth(node.auth, node.name, warnings);
  if (node.scripts.preRequest || node.scripts.afterResponse) {
    warnings.add('scripts', node.name, (names) => `Scripts were kept on ${names} but won't run: Restiprocity doesn't execute scripts yet.`);
  }
  return {
    id: node.id,
    name: node.name,
    method: method as HttpMethod,
    url: convertTemplates(applyPathParameters(node.url, node.pathParameters), node.name, warnings),
    headers,
    parameters: node.parameters.map((param) => ({
      key: convertTemplates(param.name, node.name, warnings),
      value: convertTemplates(param.value, node.name, warnings),
      enabled: !param.disabled,
    })),
    body,
    auth: auth === 'inherit' ? inherited.auth : auth,
    settings: {
      followRedirect: node.followRedirects !== 'off' && node.followRedirects !== false,
      timeout: 30000,
      cookiesEnabled: node.sendCookies !== false,
    },
    scripts: node.scripts,
    createdAt: 0,
    updatedAt: 0,
  };
}

// ─── Environments ─────────────────────────────────────────────

/** Nested objects become dotted keys (`{{ _.api.host }}` → `{{api.host}}`); arrays are kept as JSON. */
function flattenVariables(data: unknown, secretKeys: Set<string>, owner: string, warnings: Warnings, prefix = ''): EnvironmentVariable[] {
  if (!isRecord(data)) return [];
  return Object.entries(data).flatMap(([name, value]): EnvironmentVariable[] => {
    const key = prefix ? `${prefix}.${name}` : name;
    if (isRecord(value)) return flattenVariables(value, secretKeys, owner, warnings, key);
    if (!VARIABLE_KEY.test(key)) {
      warnings.add('variable-name', owner, (names) => `Variables whose names contain spaces or braces were skipped in ${names}.`);
      return [];
    }
    const converted = typeof value === 'string' ? convertTemplates(value, owner, warnings)
      : Array.isArray(value) ? JSON.stringify(value)
        : text(value);
    return [{ key, value: converted, type: secretKeys.has(key) || secretKeys.has(name) ? 'secret' : 'standard' }];
  });
}

function convertEnvironments(workspace: Workspace, warnings: Warnings): ImportedEnvironment[] {
  const base = workspace.environment;
  if (!base) return [];
  const toEnvironment = (node: EnvironmentNode, name: string, parentSourceId?: string): ImportedEnvironment => ({
    sourceId: `${workspace.id}:${node.id}`,
    ...(parentSourceId ? { parentSourceId } : {}),
    name,
    variables: flattenVariables(node.data, new Set(node.confidentialKeys), name, warnings),
  });
  const root = toEnvironment(base, base.name && base.name !== 'Base Environment' ? `${workspace.name} — ${base.name}` : workspace.name);
  const children = base.children.map((child, index) => toEnvironment(child, child.name || `Environment ${index + 1}`, root.sourceId));
  if (root.variables.length === 0 && children.length === 0) return [];
  return [root, ...children];
}

// ─── Entry point ──────────────────────────────────────────────

/** Returns null when `data` isn't an Insomnia v4/v5 export. Throws CollectionImportError for Insomnia files it can't use. */
export function convertInsomniaExport(data: unknown): InsomniaConversion | null {
  const warnings = new Warnings();
  let workspaces: Workspace[];
  if (isV5Export(data)) workspaces = readV5(data, warnings);
  else if (isV4Export(data) || (isRecord(data) && typeof data.__export_format === 'number')) workspaces = readV4(data as Record<string, unknown>, warnings);
  else if (looksLikeInsomniaExport(data)) {
    throw new CollectionImportError('This looks like an Insomnia export in a format Restiprocity can\'t read. Re-export it from Insomnia (YAML or JSON) and try again.');
  } else return null;

  const groups: RequestGroup[] = [];
  const requests: CollectionExportBundle['requests'] = [];
  const roots: string[] = [];
  const environments: ImportedEnvironment[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (id: string) => {
    let candidate = id;
    for (let suffix = 2; usedIds.has(candidate); suffix += 1) candidate = `${id}#${suffix}`;
    usedIds.add(candidate);
    return candidate;
  };

  const convertChildren = (nodes: TreeNode[], inherited: Inherited): string[] => nodes.flatMap((node): string[] => {
    if (node.kind === 'request') {
      const request = convertRequest(node, inherited, warnings);
      if (!request) return [];
      request.id = uniqueId(request.id);
      requests.push(request);
      return [request.id];
    }
    if (node.hasVariables) {
      warnings.add('folder-variables', node.name, (names) => `Folder variables in ${names} weren't imported; Restiprocity only has environment variables. Add them to an environment if requests use them.`);
    }
    const auth = convertAuth(node.auth, node.name, warnings);
    const group: RequestGroup = { id: uniqueId(node.id), name: node.name, children: [], createdAt: 0, updatedAt: 0 };
    groups.push(group);
    group.children = convertChildren(node.children, {
      headers: mergeHeaders(inherited.headers, convertHeaders(node.headers, node.name, warnings).filter((header) => header.enabled)),
      auth: auth === 'inherit' ? inherited.auth : auth,
    });
    return [group.id];
  });

  for (const workspace of workspaces) {
    environments.push(...convertEnvironments(workspace, warnings));
    if (workspace.children.length === 0) continue;
    // Each Insomnia collection becomes one top-level folder, so it stays together next to existing items.
    const root: RequestGroup = { id: uniqueId(workspace.id), name: workspace.name, children: [], createdAt: 0, updatedAt: 0 };
    groups.push(root);
    root.children = convertChildren(workspace.children, { headers: [], auth: { type: 'none' } });
    roots.push(root.id);
  }

  if (roots.length === 0 && environments.length === 0) {
    throw new CollectionImportError(warnings.list().length > 0
      ? `Nothing in this Insomnia export could be imported. ${warnings.list().join(' ')}`
      : 'This Insomnia export has no requests or environments to import.');
  }

  return {
    bundle: { format: COLLECTION_EXPORT_FORMAT, version: COLLECTION_EXPORT_VERSION, exportedAt: '', roots, groups, requests },
    environments,
    warnings: warnings.list(),
  };
}
