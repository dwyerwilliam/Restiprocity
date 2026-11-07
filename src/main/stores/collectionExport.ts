import {
  COLLECTION_EXPORT_FORMAT,
  COLLECTION_EXPORT_VERSION,
  type AuthType,
  type BodyType,
  type CollectionExportBundle,
  type Header,
  type HttpMethod,
  type Request,
  type RequestGroup,
} from '@shared/types';

/** A rejected import file; the message is shown to the user as-is. */
export class CollectionImportError extends Error {
  readonly name = 'CollectionImportError';
}

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES: readonly BodyType[] = ['none', 'raw', 'form-urlencoded', 'multipart'];
const AUTH_TYPES: readonly AuthType[] = ['none', 'bearer', 'api_key', 'basic', 'oauth2', 'ntlm'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function idList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new CollectionImportError(`The file's ${field} must be a list of item IDs.`);
  }
  return [...value];
}

function looksLikePostmanExport(data: unknown): boolean {
  return isRecord(data) && isRecord(data.info) && typeof data.info.schema === 'string';
}

function keyValueRows(value: unknown): Header[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    key: typeof row.key === 'string' ? row.key : '',
    value: typeof row.value === 'string' ? row.value : '',
    enabled: row.enabled !== false,
  }));
}

function parseGroup(raw: unknown): RequestGroup {
  if (!isRecord(raw) || !isNonEmptyString(raw.id) || typeof raw.name !== 'string') {
    throw new CollectionImportError('A folder in the file is missing its ID or name.');
  }
  return {
    id: raw.id,
    name: raw.name,
    children: idList(raw.children ?? [], `folder "${raw.name}" children`),
    ...(isRecord(raw.auth) && AUTH_TYPES.includes(raw.auth.type as AuthType) ? { auth: raw.auth as unknown as RequestGroup['auth'] } : {}),
    ...(isRecord(raw.scripts) ? { scripts: raw.scripts as RequestGroup['scripts'] } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

function parseRequest(raw: unknown): CollectionExportBundle['requests'][number] {
  if (!isRecord(raw) || !isNonEmptyString(raw.id) || typeof raw.name !== 'string') {
    throw new CollectionImportError('A request in the file is missing its ID or name.');
  }
  const label = `Request "${raw.name}"`;
  if (!HTTP_METHODS.includes(raw.method as HttpMethod)) throw new CollectionImportError(`${label} has an unsupported method.`);
  if (typeof raw.url !== 'string') throw new CollectionImportError(`${label} has no URL.`);
  const body = isRecord(raw.body) ? raw.body : { type: 'none' };
  if (!BODY_TYPES.includes(body.type as BodyType)) throw new CollectionImportError(`${label} has an unsupported body type.`);
  const auth = isRecord(raw.auth) ? raw.auth : { type: 'none' };
  if (!AUTH_TYPES.includes(auth.type as AuthType)) throw new CollectionImportError(`${label} has an unsupported authentication type.`);
  const settings = isRecord(raw.settings) ? raw.settings : {};

  return {
    id: raw.id,
    name: raw.name,
    method: raw.method as HttpMethod,
    url: raw.url,
    headers: keyValueRows(raw.headers),
    parameters: keyValueRows(raw.parameters),
    body: body as unknown as Request['body'],
    auth: auth as unknown as Request['auth'],
    settings: {
      ...settings,
      followRedirect: typeof settings.followRedirect === 'boolean' ? settings.followRedirect : true,
      timeout: typeof settings.timeout === 'number' && Number.isFinite(settings.timeout) && settings.timeout >= 0 ? settings.timeout : 30000,
    } as Request['settings'],
    scripts: isRecord(raw.scripts) ? raw.scripts as Request['scripts'] : {},
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Validates an export file's structure; nested request fields keep their stored shape. */
export function parseCollectionExportBundle(data: unknown): CollectionExportBundle {
  if (!isRecord(data) || data.format !== COLLECTION_EXPORT_FORMAT) {
    throw new CollectionImportError(looksLikePostmanExport(data)
      ? 'This Postman export is not a supported collection or environment file.'
      : 'This file is not a Restiprocity, Insomnia, or Postman export.');
  }
  if (data.version !== COLLECTION_EXPORT_VERSION) {
    throw new CollectionImportError(`This export uses format version ${String(data.version)}, which this version of Restiprocity can't read.`);
  }
  if (!Array.isArray(data.groups) || !Array.isArray(data.requests)) {
    throw new CollectionImportError('The file is missing its folders or requests.');
  }

  const groups = data.groups.map(parseGroup);
  const requests = data.requests.map(parseRequest);
  const ids = [...groups, ...requests].map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new CollectionImportError('The file contains duplicate item IDs.');

  return {
    format: COLLECTION_EXPORT_FORMAT,
    version: COLLECTION_EXPORT_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    roots: idList(data.roots, 'roots'),
    groups,
    requests,
  };
}
