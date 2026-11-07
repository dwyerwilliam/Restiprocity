import fs from 'fs/promises';
import path from 'path';
import { CollectionMutationQueue, CollectionMoveError, parseMembership, readOriginal, replaceCollectionFiles } from './collectionMutation';
import type { CollectionFileOperations } from './collectionMutation';
import { CollectionImportError, parseCollectionExportBundle } from './collectionExport';
import { convertInsomniaExport, type ImportedEnvironment } from './insomniaImport';
import { convertPostmanExport } from './postmanImport';
import { normalizeResponseSnapshotV2, toPersistedResponseV2, toRendererResponseV2 } from '@shared/responseContracts';
import {
  AppSettings,
  COLLECTION_EXPORT_FORMAT,
  COLLECTION_EXPORT_VERSION,
  CollectionExportBundle,
  CollectionImportSummary,
  CollectionMoveRequestPayload,
  CORE_ENVIRONMENT_ID,
  CORE_ENVIRONMENT_NAME,
  Environment,
  Id,
  PersistedResponseV2,
  Request,
  RequestGroup,
  RequestGroupNode,
  ResponseV2,
} from '@shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPersistedResponseV2(value: unknown): value is PersistedResponseV2 {
  return isRecord(value) && value.version === 2;
}

function normalizeGroup(group: RequestGroup | null): RequestGroupNode | null {
  return group ? { ...group, type: 'group' } : null;
}

function isGroupNode(item: Request | RequestGroupNode): item is RequestGroupNode {
  return 'type' in item && item.type === 'group';
}

function stripGroupType(group: RequestGroupNode): RequestGroup {
  const { type: _type, ...persistedGroup } = group;
  return persistedGroup;
}

type SettingsFileOperations = Pick<typeof fs, 'writeFile' | 'rename' | 'unlink'>;

export class CollectionStore {
  private collectionsDir: string;
  private envsDir: string;
  private settingsPath: string;
  private rootOrderPath: string;
  private activeEnvId: string | null = null;
  private readonly collectionMutations = new CollectionMutationQueue();
  private readonly environmentMutations = new CollectionMutationQueue();

  constructor(
    userDataPath: string,
    private readonly moveFiles: CollectionFileOperations = fs,
    private readonly settingsFiles: SettingsFileOperations = fs,
  ) {
    this.collectionsDir = path.join(userDataPath, 'collections');
    this.envsDir = path.join(userDataPath, 'environments');
    this.settingsPath = path.join(userDataPath, 'settings.json');
    this.rootOrderPath = path.join(this.collectionsDir, '.root-order.json');
  }

  async init(): Promise<void> {
    await this.environmentMutations.run(async () => {
      await fs.mkdir(this.collectionsDir, { recursive: true });
      await fs.mkdir(this.envsDir, { recursive: true });

      await this.ensureCoreEnvironment();
      const settings = await this.getSettings();
      const storedId = settings.activeEnvironmentId;
      const activeEnvironmentId = typeof storedId === 'string' && await this.getEnvironment(storedId)
        ? storedId : CORE_ENVIRONMENT_ID;
      await this.saveSettingsUnlocked({ ...settings, activeEnvironmentId });
    });
  }

  // ─── Requests ───────────────────────────────────────────────
  async createRequest(data: Omit<Request, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Request, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Request> {
    return this.collectionMutations.run(() => this.createRequestUnlocked(data));
  }

  private async createRequestUnlocked(data: Omit<Request, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Request, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Request> {
    const now = Date.now();
    const request = {
      ...data,
      id: data.id ?? generateId(),
      createdAt: data.createdAt ?? now,
      updatedAt: now,
    } as Request;

    const hydrated = await this.purgeUnsupportedLastResponse(request, false);
    await this.saveRequestFile(request);
    await this.attachRequestToParentGroup(request);
    return hydrated;
  }

  private async attachRequestToParentGroup(request: Request): Promise<void> {
    if (!request.parentId) return;
    const group = await this.getGroup(request.parentId);
    if (!group || group.children.includes(request.id)) return;
    await this.updateGroupUnlocked(group.id, { children: [...group.children, request.id] });
  }

  async getRequest(id: Id): Promise<Request | null> {
    return this.collectionMutations.run(() => this.getRequestUnlocked(id));
  }

  private async getRequestUnlocked(id: Id): Promise<Request | null> {
    const request = await this.loadFile<Request>(this.requestPath(id));
    return request ? this.purgeUnsupportedLastResponse(request, true) : null;
  }

  async updateRequest(id: Id, data: Partial<Request>): Promise<Request> {
    return this.collectionMutations.run(() => this.updateRequestUnlocked(id, data));
  }

  private async updateRequestUnlocked(id: Id, data: Partial<Request>): Promise<Request> {
    const existing = await this.getRequestUnlocked(id);
    if (!existing) {
      return this.createRequestUnlocked({
        name: data.name ?? 'New Request',
        method: data.method ?? 'GET',
        url: data.url ?? '',
        headers: data.headers ?? [],
        parameters: data.parameters ?? [],
        body: data.body ?? { type: 'none' },
        auth: data.auth ?? { type: 'none' },
        settings: data.settings ?? { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: data.scripts ?? {},
        lastResponse: data.lastResponse,
        parentId: data.parentId,
        id,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
    }
    const updatedRequest = { ...existing, ...data, id, updatedAt: Date.now() } as Request;
    const hydrated = await this.purgeUnsupportedLastResponse(updatedRequest, false);
    await this.saveRequestFile(updatedRequest);
    return hydrated;
  }

  async deleteRequest(id: Id): Promise<void> {
    return this.collectionMutations.run(() => this.deleteRequestUnlocked(id));
  }

  private async deleteRequestUnlocked(id: Id): Promise<void> {
    await fs.unlink(this.requestPath(id)).catch(() => {});
  }

  // ─── Groups ─────────────────────────────────────────────────
  async createGroup(data: Omit<RequestGroup, 'id' | 'createdAt' | 'updatedAt'>): Promise<RequestGroupNode> {
    return this.collectionMutations.run(() => this.createGroupUnlocked(data));
  }

  private async createGroupUnlocked(data: Omit<RequestGroup, 'id' | 'createdAt' | 'updatedAt'>): Promise<RequestGroupNode> {
    const now = Date.now();
    const group: RequestGroupNode = {
      ...data,
      id: generateId(),
      type: 'group',
      children: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFile(this.groupPath(group.id), stripGroupType(group));
    return group;
  }

  async getGroup(id: Id): Promise<RequestGroupNode | null> {
    return normalizeGroup(await this.loadFile<RequestGroup>(this.groupPath(id)));
  }

  async updateGroup(id: Id, data: Partial<RequestGroup>): Promise<RequestGroupNode> {
    return this.collectionMutations.run(() => this.updateGroupUnlocked(id, data));
  }

  private async updateGroupUnlocked(id: Id, data: Partial<RequestGroup>): Promise<RequestGroupNode> {
    const existing = await this.getGroup(id);
    if (!existing) throw new Error(`Group ${id} not found`);
    const { type: _type, ...groupData } = data as Partial<RequestGroupNode>;
    const updated: RequestGroupNode = { ...existing, ...groupData, id, type: 'group', updatedAt: Date.now() };
    await this.saveFile(this.groupPath(id), stripGroupType(updated));
    return updated;
  }

  async deleteGroup(id: Id): Promise<void> {
    return this.collectionMutations.run(() => this.deleteGroupUnlocked(id));
  }

  private async deleteGroupUnlocked(id: Id): Promise<void> {
    await fs.unlink(this.groupPath(id)).catch(() => {});
  }

  // ─── Listing ────────────────────────────────────────────────
  async listAll(): Promise<Array<Request | RequestGroupNode>> {
    return this.collectionMutations.run(() => this.listAllUnlocked());
  }

  private async listAllUnlocked(): Promise<Array<Request | RequestGroupNode>> {
    const collectionItems = await this.loadCollectionItems();
    const rootOrder = await this.loadRootOrder();
    if (rootOrder.length === 0) return collectionItems;

    const orderIndex = new Map(rootOrder.map((id, index) => [id, index]));
    return [...collectionItems].sort((a, b) => {
      const aIndex = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bIndex = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;

      if (aIndex !== bIndex) return aIndex - bIndex;
      return 0;
    });
  }

  // ─── Environments ───────────────────────────────────────────
  async listEnvironments(): Promise<Environment[]> {
    await this.ensureCoreEnvironment();

    const entries = await fs.readdir(this.envsDir).catch(() => []);
    const envs = await Promise.all(
      entries
        .filter(n => n.endsWith('.json'))
        .map(name => this.loadFile<Environment>(path.join(this.envsDir, name)))
    );
    return envs.filter(Boolean) as Environment[];
  }

  async createEnvironment(data: Omit<Environment, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Environment, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Environment> {
    return this.environmentMutations.run(() => this.createEnvironmentUnlocked(data));
  }

  private async createEnvironmentUnlocked(data: Omit<Environment, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Environment, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Environment> {
    const now = Date.now();
    const id = data.id ?? generateId();
    if (await this.getEnvironment(id)) throw new Error('Environment already exists.');
    const parentId = id === CORE_ENVIRONMENT_ID
      ? undefined
      : data.parentId ?? this.activeEnvId ?? CORE_ENVIRONMENT_ID;
    const env: Environment = {
      ...data,
      id,
      parentId,
      createdAt: data.createdAt ?? now,
      updatedAt: now,
    };
    await this.validateEnvironment(env);
    await this.saveFile(this.envPath(env.id), env);
    return env;
  }

  async updateEnvironment(id: Id, data: Partial<Environment>): Promise<Environment> {
    return this.environmentMutations.run(() => this.updateEnvironmentUnlocked(id, data));
  }

  private async updateEnvironmentUnlocked(id: Id, data: Partial<Environment>): Promise<Environment> {
    const existing = await this.getEnvironment(id);
    if (!existing) throw new Error(`Environment ${id} not found`);
    const updated = { ...existing, ...data, id, updatedAt: Date.now() };
    if (id === CORE_ENVIRONMENT_ID) {
      delete updated.parentId;
    }
    await this.validateEnvironment(updated);
    await this.saveFile(this.envPath(id), updated);
    return updated;
  }

  private async validateEnvironment(environment: Environment): Promise<void> {
    if (typeof environment.name !== 'string' || !environment.name.trim()) {
      throw new Error('Environment name is required.');
    }
    const keys = new Set<string>();
    if (!Array.isArray(environment.variables)) throw new Error('Invalid environment variables.');
    for (const variable of environment.variables) {
      if (!variable || typeof variable.key !== 'string' || !variable.key.trim()
        || typeof variable.value !== 'string' || !['standard', 'secret'].includes(variable.type)) {
        throw new Error('Invalid environment variable.');
      }
      const key = variable.key.trim();
      if (keys.has(key)) throw new Error('Variable keys must be unique within an environment.');
      keys.add(key);
    }
    const seen = new Set([environment.id]);
    let parentId = environment.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('Environment inheritance cannot contain a cycle.');
      seen.add(parentId);
      const parent = await this.getEnvironment(parentId);
      if (!parent) throw new Error('Parent environment no longer exists. Refresh and retry.');
      parentId = parent.parentId;
    }
  }

  async deleteEnvironment(id: Id): Promise<Id> {
    return this.environmentMutations.run(async () => {
      if (id === CORE_ENVIRONMENT_ID) return this.activeEnvId ?? CORE_ENVIRONMENT_ID;
      const environment = await this.getEnvironment(id);
      if (!environment) throw new Error('Environment no longer exists. Refresh and retry.');
      if ((await this.listEnvironments()).some(env => env.parentId === id)) {
        throw new Error('Delete child environments first so their inherited variables are preserved.');
      }
      const wasActive = this.activeEnvId === id;
      const parent = wasActive && environment.parentId && environment.parentId !== id
        ? await this.getEnvironment(environment.parentId) : null;
      const nextActiveId = parent?.id ?? CORE_ENVIRONMENT_ID;
      if (!wasActive) {
        await fs.unlink(this.envPath(id));
        return this.activeEnvId ?? CORE_ENVIRONMENT_ID;
      }

      const originalActiveId = this.activeEnvId ?? CORE_ENVIRONMENT_ID;
      await this.saveSettingsUnlocked({ activeEnvironmentId: nextActiveId });
      try {
        await fs.unlink(this.envPath(id));
      } catch (error) {
        try {
          await this.saveSettingsUnlocked({ activeEnvironmentId: originalActiveId });
        } catch (rollbackError) {
          throw new Error('Unable to delete environment and restore its active selection.', {
            cause: new AggregateError([error, rollbackError]),
          });
        }
        throw error;
      }
      return nextActiveId;
    });
  }

  async getEnvironment(id: Id): Promise<Environment | null> {
    return this.loadFile<Environment>(this.envPath(id));
  }

  async switchEnvironment(id: Id | null): Promise<Id> {
    return this.environmentMutations.run(async () => {
      const activeEnvironmentId = id ?? CORE_ENVIRONMENT_ID;
      if (!await this.getEnvironment(activeEnvironmentId)) {
        throw new Error('Environment no longer exists. Refresh and retry.');
      }
      await this.saveSettingsUnlocked({ activeEnvironmentId });
      return activeEnvironmentId;
    });
  }

  getActiveEnvironmentId(): string | null {
    return this.activeEnvId;
  }

  // ─── Settings ───────────────────────────────────────────────
  async getSettings(): Promise<AppSettings> {
    const settings = await this.loadFile<AppSettings>(this.settingsPath);
    return settings ?? defaultSettings();
  }

  async saveSettings(settings: Partial<AppSettings>): Promise<Id> {
    return this.environmentMutations.run(() => this.saveSettingsUnlocked(settings));
  }

  private async saveSettingsUnlocked(settings: Partial<AppSettings>): Promise<Id> {
    const activeEnvironmentId = Object.prototype.hasOwnProperty.call(settings, 'activeEnvironmentId')
      ? settings.activeEnvironmentId : this.activeEnvId ?? CORE_ENVIRONMENT_ID;
    if (typeof activeEnvironmentId !== 'string' || !await this.getEnvironment(activeEnvironmentId)) {
      throw new Error('Environment no longer exists. Refresh and retry.');
    }
    const next = { ...await this.getSettings(), ...settings, activeEnvironmentId };
    const temporaryPath = `${this.settingsPath}.${generateId()}.tmp`;
    try {
      await this.settingsFiles.writeFile(temporaryPath, JSON.stringify(next, null, 2), 'utf-8');
      await this.settingsFiles.rename(temporaryPath, this.settingsPath);
    } catch (error) {
      try {
        await this.settingsFiles.unlink(temporaryPath);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
          throw new Error('Unable to persist environment settings. Please retry.', { cause: new AggregateError([error, cleanupError]) });
        }
      }
      throw new Error('Unable to persist environment settings. Please retry.', { cause: error });
    }
    this.activeEnvId = activeEnvironmentId;
    return activeEnvironmentId;
  }

  // ─── Native collection files ────────────────────────────────
  /** Serializes one request, one folder subtree, or (no id) the whole collection tree. */
  async exportBundle(id?: Id): Promise<CollectionExportBundle> {
    return this.collectionMutations.run(() => this.exportBundleUnlocked(id));
  }

  private async exportBundleUnlocked(id?: Id): Promise<CollectionExportBundle> {
    const items = await this.listAllUnlocked();
    const byId = new Map(items.map((item) => [item.id, item]));
    const childIds = new Set(items.flatMap((item) => ('children' in item && Array.isArray(item.children) ? item.children : [])));
    const roots = id === undefined ? items.filter((item) => !childIds.has(item.id)).map((item) => item.id) : [id];
    if (id !== undefined && !byId.has(id)) throw new Error(`Item ${id} not found`);

    const groups: RequestGroup[] = [];
    const requests: CollectionExportBundle['requests'] = [];
    const visited = new Set<Id>();
    const visit = (nodeId: Id): boolean => {
      const item = byId.get(nodeId);
      if (!item || visited.has(nodeId)) return false;
      visited.add(nodeId);
      if (isGroupNode(item)) {
        // Parents before children, matching the tree's reading order.
        const group = { ...stripGroupType(item) };
        groups.push(group);
        group.children = group.children.filter(visit);
      } else {
        const { lastResponse: _lastResponse, ...request } = item;
        requests.push(request);
      }
      return true;
    };
    return {
      format: COLLECTION_EXPORT_FORMAT,
      version: COLLECTION_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      roots: roots.filter(visit),
      groups,
      requests,
    };
  }

  /**
   * Adds a Restiprocity export or an Insomnia v4/v5 export at the top level of the collection with
   * fresh IDs, so importing never overwrites or collides with existing items. Requests, folders, and
   * Insomnia environments are written as one recoverable change: a failure restores everything.
   */
  async importBundle(data: unknown): Promise<CollectionImportSummary> {
    const conversion = convertPostmanExport(data) ?? convertInsomniaExport(data);
    const bundle = parseCollectionExportBundle(conversion?.bundle ?? data);
    // Fixed lock order (environments, then collection); nothing else holds both.
    return this.environmentMutations.run(() => this.collectionMutations.run(() =>
      this.importBundleUnlocked(bundle, conversion?.environments ?? [], conversion?.warnings ?? [])));
  }

  private async importBundleUnlocked(
    bundle: CollectionExportBundle,
    environments: readonly ImportedEnvironment[],
    warnings: string[],
  ): Promise<CollectionImportSummary> {
    const groupsById = new Map(bundle.groups.map((group) => [group.id, group]));
    const requestsById = new Map(bundle.requests.map((request) => [request.id, request]));
    const now = Date.now();
    const changes: { path: string; data: string }[] = [];
    const visited = new Set<Id>();
    let requestCount = 0;
    let groupCount = 0;

    const importNode = (sourceId: Id, parentId: Id | undefined): Id => {
      if (visited.has(sourceId)) throw new CollectionImportError('The file lists the same item in more than one place.');
      visited.add(sourceId);
      const id = generateId();
      const group = groupsById.get(sourceId);
      if (group) {
        const children = group.children.map((childId) => importNode(childId, id));
        const imported: RequestGroup = { ...group, id, children, createdAt: now, updatedAt: now };
        if (parentId) imported.parentId = parentId;
        else delete imported.parentId;
        changes.push({ path: this.groupPath(id), data: JSON.stringify(imported, null, 2) });
        groupCount += 1;
        return id;
      }
      const request = requestsById.get(sourceId);
      if (!request) throw new CollectionImportError('The file refers to an item it does not contain.');
      const imported = { ...request, id, createdAt: now, updatedAt: now } as Request;
      if (parentId) imported.parentId = parentId;
      else delete imported.parentId;
      changes.push({ path: this.requestPath(id), data: JSON.stringify(this.persistedRequest(imported), null, 2) });
      requestCount += 1;
      return id;
    };

    const newRoots = bundle.roots.map((rootId) => importNode(rootId, undefined));
    if (newRoots.length > 0) {
      // Without a stored order the listing falls back to directory order; pin the current top level
      // so imported items land after it.
      let rootOrder = await this.loadRootOrder();
      if (rootOrder.length === 0) {
        const items = await this.listAllUnlocked();
        const childIds = new Set(items.flatMap((item) => (isGroupNode(item) ? item.children : [])));
        rootOrder = items.filter((item) => !childIds.has(item.id)).map((item) => item.id);
      }
      changes.push({ path: this.rootOrderPath, data: JSON.stringify([...rootOrder, ...newRoots], null, 2) });
    }

    const environmentIds = new Map(environments.map((environment) => [environment.sourceId, generateId()]));
    for (const environment of environments) {
      const id = environmentIds.get(environment.sourceId) as Id;
      const imported: Environment = {
        id,
        name: environment.name,
        parentId: (environment.parentSourceId && environmentIds.get(environment.parentSourceId)) || CORE_ENVIRONMENT_ID,
        variables: environment.variables,
        createdAt: now,
        updatedAt: now,
      };
      changes.push({ path: this.envPath(id), data: JSON.stringify(imported, null, 2) });
    }

    if (changes.length > 0) await replaceCollectionFiles(changes, this.moveFiles);
    return { requests: requestCount, groups: groupCount, environments: environments.length, warnings };
  }

  // ─── Import/Export ──────────────────────────────────────────
  async export(id: Id): Promise<any> {
    const request = await this.getRequest(id);
    const group = await this.getGroup(id);
    return request || group;
  }

  async import(data: any): Promise<void> {
    return this.collectionMutations.run(() => this.importUnlocked(data));
  }

  private async importUnlocked(data: any): Promise<void> {
    if (this.isPostmanCollection(data)) {
      await this.importPostmanCollection(data);
    } else if (data.type === 'request') {
      await this.createRequestUnlocked(data);
    } else if (data.type === 'group') {
      await this.createGroupUnlocked(data);
    }
  }

  private isPostmanCollection(data: any): boolean {
    return data?.info?.schema?.startsWith('https://schema.getpostman.com') ||
           data?.info?.schema?.startsWith('https://schema.postman.com');
  }

  private async importPostmanCollection(collection: any): Promise<void> {
    if (collection.item) {
      await this.importPostmanItems(collection.item, undefined);
    }
  }

  private async importPostmanItems(items: any[], parentId: Id | undefined): Promise<void> {
    for (const item of items) {
      if (item.item) {
        const group = await this.createGroupUnlocked({
          name: item.name,
          parentId,
          children: [],
        });
        await this.importPostmanItems(item.item, group.id);
      } else if (item.request) {
        await this.createRequestUnlocked({
          name: item.name,
          method: this.parsePostmanMethod(item.request),
          url: this.parsePostmanUrl(item.request),
          headers: this.parsePostmanHeaders(item.request),
          parameters: this.parsePostmanQueryParams(item.request),
          body: this.parsePostmanBody(item.request),
          auth: this.parsePostmanAuth(item.auth),
          settings: {
            followRedirect: true,
            timeout: 30000,
            cookiesEnabled: true,
          },
          scripts: {},
          parentId,
        });
      }
    }
  }

  private parsePostmanMethod(request: any): import('@shared/types').HttpMethod {
    const method = request?.method?.toUpperCase();
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    return validMethods.includes(method) ? method : 'GET';
  }

  private parsePostmanUrl(request: any): string {
    if (typeof request?.url === 'string') return request.url;
    if (request?.url?.raw) return request.url.raw;
    if (request?.url?.protocol && request?.url?.host) {
      const host = Array.isArray(request.url.host) ? request.url.host.join('.') : request.url.host;
      const path = Array.isArray(request.url.path) ? request.url.path.join('/') : '';
      return `${request.url.protocol}://${host}${path ? '/' + path : ''}`;
    }
    return 'http://localhost';
  }

  private parsePostmanHeaders(request: any): import('@shared/types').Header[] {
    const headers = request?.header;
    if (!headers) return [];
    if (Array.isArray(headers)) {
      return headers
        .filter(h => h.key !== undefined)
        .map(h => ({ key: h.key, value: h.value || '', enabled: h.disabled !== true }));
    }
    return [];
  }

  private parsePostmanQueryParams(request: any): import('@shared/types').QueryParameter[] {
    const params = request?.url?.query;
    if (!params) return [];
    if (Array.isArray(params)) {
      return params
        .filter(p => p.key !== undefined)
        .map(p => ({ key: p.key, value: p.value || '', enabled: p.disabled !== true }));
    }
    return [];
  }

  private parsePostmanBody(request: any): import('@shared/types').RequestBody {
    const body = request?.body;
    if (!body) return { type: 'none' };

    if (body.mode === 'raw' && body.raw) {
      return {
        type: 'raw',
        raw: {
          language: body.options?.raw?.language === 'json' ? 'json' : 'text',
          content: body.raw,
        },
      };
    }

    if (body.mode === 'urlencoded' && body.urlencoded) {
      return {
        type: 'form-urlencoded',
        form: body.urlencoded
          .filter((f: any) => f.key !== undefined)
          .map((f: any) => ({ key: f.key, value: f.value || '', enabled: f.disabled !== true })),
      };
    }

    if (body.mode === 'formdata' && body.formdata) {
      return {
        type: 'multipart',
        multipart: body.formdata
          .filter((f: any) => f.key !== undefined)
          .map((f: any) => ({
            key: f.key,
            type: f.type === 'file' ? 'file' as const : 'text' as const,
            value: f.value || '',
            enabled: f.disabled !== true,
          })),
      };
    }

    return { type: 'none' };
  }

  private parsePostmanAuth(auth: any): import('@shared/types').AuthConfig {
    if (!auth) return { type: 'none' };

    if (auth.type === 'oauth2' && auth.oauth2) {
      const getValue = (key: string) => auth.oauth2.find((a: any) => a.key === key)?.value || '';
      const rawGrantType = getValue('grant_type') || getValue('grantType') || 'client_credentials';
      const grantType = (['authorization_code', 'client_credentials', 'password', 'pkce'].includes(rawGrantType) ? rawGrantType : 'client_credentials') as import('@shared/types').OAuth2GrantType;

      return {
        type: 'oauth2',
        oauth2: {
          grantType,
          authorizationUrl: getValue('authUrl') || getValue('authorize_url') || getValue('authorization_url') || '',
          tokenUrl: getValue('accessTokenUrl') || getValue('token_url') || getValue('tokenUrl') || '',
          clientId: getValue('client_id') || getValue('clientId') || '',
          clientSecret: getValue('client_secret') || getValue('clientSecret') || '',
          scope: getValue('scope') || '',
          redirectUri: getValue('redirect_uri') || getValue('redirectUri') || '',
        },
      };
    }

    if (auth.type === 'bearer' && auth.bearer) {
      return {
        type: 'bearer',
        bearer: {
          token: auth.bearer[0]?.value || '',
          prefix: 'Bearer',
        },
      };
    }

    if (auth.type === 'basic' && auth.basic) {
      return {
        type: 'basic',
        basic: {
          username: auth.basic[0]?.value || '',
          password: auth.basic[1]?.value || '',
        },
      };
    }

    if (auth.type === 'apikey' && auth.apikey) {
      const keyHeader = auth.apikey.find((a: any) => a.key === 'key');
      const valueHeader = auth.apikey.find((a: any) => a.key === 'value');
      return {
        type: 'api_key',
        api_key: {
          key: keyHeader?.value || 'X-API-Key',
          value: valueHeader?.value || '',
          in: auth.apikey.find((a: any) => a.key === 'in')?.value === 'query' ? 'query' : 'header',
        },
      };
    }

    return { type: 'none' };
  }

  // ─── Helpers ────────────────────────────────────────────────
  private requestPath(id: Id): string {
    return path.join(this.collectionsDir, `${id}.req.json`);
  }

  private groupPath(id: Id): string {
    return path.join(this.collectionsDir, `${id}.grp.json`);
  }

  private envPath(id: Id): string {
    return path.join(this.envsDir, `${id}.json`);
  }

  private async loadRootOrder(): Promise<Id[]> {
    const order = await this.loadFile<Id[]>(this.rootOrderPath);
    return Array.isArray(order) ? order : [];
  }

  private async ensureCoreEnvironment(): Promise<Environment> {
    const existing = await this.getEnvironment(CORE_ENVIRONMENT_ID);
    if (existing) return existing;

    const now = Date.now();
    const core: Environment = {
      id: CORE_ENVIRONMENT_ID,
      name: CORE_ENVIRONMENT_NAME,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFile(this.envPath(core.id), core);
    return core;
  }

  private async saveRootOrder(children: Id[]): Promise<void> {
    await this.saveFile(this.rootOrderPath, children);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async saveFile<T>(filePath: string, data: T): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private async saveRequestFile(request: Request): Promise<void> {
    await this.saveFile(this.requestPath(request.id), this.persistedRequest(request));
  }

  private persistedRequest(request: Request) {
    const { lastResponse, ...requestData } = request;
    let persistedLastResponse: PersistedResponseV2 | undefined;
    if (isPersistedResponseV2(lastResponse)) {
      try {
        persistedLastResponse = toPersistedResponseV2(lastResponse);
      } catch {
        persistedLastResponse = undefined;
      }
    }
    const persistedRequest = persistedLastResponse === undefined
      ? requestData
      : { ...requestData, lastResponse: persistedLastResponse };

    return persistedRequest;
  }

  private async purgeUnsupportedLastResponse(request: Request, persistCleanup: boolean): Promise<Request> {
    if (request.lastResponse === undefined) {
      return request;
    }

    if (!isPersistedResponseV2(request.lastResponse)) {
      const { lastResponse: _legacyLastResponse, ...cleanedRequest } = request;
      if (persistCleanup) {
        await this.saveFile(this.requestPath(request.id), cleanedRequest);
      }
      return cleanedRequest;
    }

    try {
      return this.hydrateRequestResponse(request);
    } catch {
      const { lastResponse: _invalidLastResponse, ...cleanedRequest } = request;
      if (persistCleanup) {
        await this.saveFile(this.requestPath(request.id), cleanedRequest);
      }
      return cleanedRequest;
    }
  }

  private hydrateRequestResponse(request: Request): Request {
    if (request.lastResponse === undefined) {
      return request;
    }

    const snapshot = normalizeResponseSnapshotV2(request.lastResponse);
    return {
      ...request,
      lastResponse: toRendererResponseV2(snapshot),
    };
  }

  private async loadFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  // Stub methods for IPC handlers that delegate to above
  async create(data: any): Promise<any> {
    const { nodeType, ...payload } = data ?? {};

    if (nodeType === 'request' || payload.method) {
      return this.createRequest(payload);
    }
    return this.createGroup(payload);
  }

  async update(id: Id, data: any): Promise<any> {
    return this.collectionMutations.run(() => this.updateUnlocked(id, data));
  }

  private async updateUnlocked(id: Id, data: any): Promise<any> {
    const { nodeType, ...payload } = data ?? {};

    if (nodeType === 'request' || payload.method) {
      return this.updateRequestUnlocked(id, payload);
    }

    if (nodeType === 'group') {
      return this.updateGroupUnlocked(id, payload);
    }

    if (await this.getRequestUnlocked(id)) {
      return this.updateRequestUnlocked(id, payload);
    }

    return this.updateGroupUnlocked(id, payload);
  }

  async delete(id: Id): Promise<void> {
    return this.collectionMutations.run(async () => {
      await this.deleteRequestUnlocked(id);
      await this.deleteGroupUnlocked(id);
    });
  }

  async duplicate(id: Id): Promise<any> {
    return this.collectionMutations.run(() => this.duplicateUnlocked(id));
  }

  private async duplicateUnlocked(id: Id): Promise<any> {
    const req = await this.getRequestUnlocked(id);
    if (req) {
      const { id: _id, createdAt: _createdAt, ...rest } = req as any;
      return this.createRequestUnlocked({ ...rest, name: `${req.name} (copy)` });
    }
    const grp = await this.getGroup(id);
    if (grp) {
      const { id: _id, createdAt: _createdAt, ...rest } = grp as any;
      return this.createGroupUnlocked({ ...rest, name: `${grp.name} (copy)`, children: [] });
    }
    throw new Error(`Item ${id} not found`);
  }

  async reorder(data: any): Promise<void> {
    return this.collectionMutations.run(() => this.reorderUnlocked(data));
  }

  private async reorderUnlocked(data: any): Promise<void> {
    const { parentId, children } = data;
    if (parentId) {
      await this.updateGroupUnlocked(parentId, { children });
      return;
    }

    await this.saveRootOrder(children);
  }

  async moveRequest(data: CollectionMoveRequestPayload): Promise<Request> {
    return this.collectionMutations.run(() => this.moveRequestUnlocked(data));
  }

  private async moveRequestUnlocked(data: CollectionMoveRequestPayload): Promise<Request> {
    if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
      throw new CollectionMoveError('Request move requires a requestId.');
    }
    if (data.targetParentId !== undefined && (typeof data.targetParentId !== 'string' || data.targetParentId.length === 0)) {
      throw new CollectionMoveError('Request move requires a targetParentId.');
    }
    if (!Number.isFinite(data.targetIndex)) {
      throw new CollectionMoveError('Request move requires a finite targetIndex.');
    }

    const request = await this.loadFile<Request>(this.requestPath(data.requestId));
    if (!request || request.id !== data.requestId) {
      throw new CollectionMoveError('Request is missing or its stored ID is inconsistent. Refresh and repair the collection before retrying.');
    }

    if (request.parentId === data.targetParentId) {
      throw new CollectionMoveError('Request move requires a different target parent. Use reorder for same-parent moves.');
    }

    if (request.parentId !== undefined && (typeof request.parentId !== 'string' || request.parentId.length === 0)) {
      throw new CollectionMoveError('Stored request parent is invalid. Repair collection links before retrying.');
    }
    const entries = await fs.readdir(this.collectionsDir);
    const groups: RequestGroup[] = [];
    const items = new Map<Id, Request | RequestGroup>();
    const rootIds: string[] = [];
    for (const name of entries) {
      if (!name.endsWith('.req.json') && !name.endsWith('.grp.json')) continue;
      const item = await this.loadFile<Request | RequestGroup>(path.join(this.collectionsDir, name));
      const suffix = name.endsWith('.grp.json') ? '.grp.json' : '.req.json';
      if (!item || item.id !== name.slice(0, -suffix.length)) throw new CollectionMoveError('Collection file is missing, corrupt or has an inconsistent ID. Repair it before retrying.');
      if (items.has(item.id)) throw new CollectionMoveError('Collection IDs are duplicated. Repair collection links before retrying.');
      items.set(item.id, item);
      if (item.parentId === undefined) rootIds.push(item.id);
      if ('children' in item) groups.push({ ...item, children: parseMembership(item.children) });
      else if (suffix === '.grp.json') throw new CollectionMoveError('Group membership is missing. Repair it before retrying.');
    }
    const source = groups.find((group) => group.id === request.parentId);
    const target = groups.find((group) => group.id === data.targetParentId);
    if ((request.parentId !== undefined && !source) || (data.targetParentId !== undefined && !target)) {
      throw new CollectionMoveError('Source or target group not found. Refresh the collection and retry.');
    }
    for (const group of [source, target]) {
      if (group && group.children.some((id) => items.get(id)?.parentId !== group.id)) {
        throw new CollectionMoveError('Group membership refers to a missing or differently parented item. Repair collection links before retrying.');
      }
    }
    const memberships = groups.filter((group) => group.children.includes(request.id));
    if (memberships.length !== (source ? 1 : 0) || (source && !source.children.includes(request.id))) {
      throw new CollectionMoveError('Stored parent and group membership disagree. Repair collection links before retrying.');
    }
    const rootBytes = await readOriginal(this.rootOrderPath, this.moveFiles);
    let storedRootOrder: string[] = [];
    if (rootBytes !== null) {
      try {
        storedRootOrder = parseMembership(JSON.parse(rootBytes.toString('utf-8')));
      } catch (error) {
        throw new CollectionMoveError('Root order is corrupt. Repair collection links before retrying.', { cause: error });
      }
    }
    const liveRootIds = new Set(rootIds);
    if (source ? liveRootIds.has(request.id) : !liveRootIds.has(request.id)) {
      throw new CollectionMoveError('Root membership and request parent disagree. Repair collection links before retrying.');
    }
    const survivingRootOrder = storedRootOrder.filter((id) => liveRootIds.has(id));
    const hintedRootIds = new Set(survivingRootOrder);
    const canPreserveRootHint = target !== undefined
      && survivingRootOrder.length === storedRootOrder.length
      && hintedRootIds.has(request.id);
    const rootOrder = canPreserveRootHint
      ? survivingRootOrder
      : [...survivingRootOrder, ...rootIds.filter((id) => !hintedRootIds.has(id))];
    const changes: Array<{ path: string; data: string }> = [];
    const now = Date.now();
    const nextRootOrder = rootOrder.filter((id) => id !== request.id);
    if (source) changes.push({ path: this.groupPath(source.id), data: JSON.stringify({ ...source, children: source.children.filter((id) => id !== request.id), updatedAt: now }, null, 2) });
    const targetChildren = target ? [...target.children] : nextRootOrder;
    targetChildren.splice(Math.min(Math.max(Math.trunc(data.targetIndex), 0), targetChildren.length), 0, request.id);
    if (target) changes.push({ path: this.groupPath(target.id), data: JSON.stringify({ ...target, children: targetChildren, updatedAt: now }, null, 2) });
    if (!source || !target) changes.push({ path: this.rootOrderPath, data: JSON.stringify(nextRootOrder, null, 2) });
    const updated = { ...request, parentId: data.targetParentId, updatedAt: now };
    const hydrated = await this.purgeUnsupportedLastResponse(updated, false);
    changes.push({ path: this.requestPath(request.id), data: JSON.stringify(this.persistedRequest(updated), null, 2) });
    await replaceCollectionFiles(changes, this.moveFiles);
    return hydrated;
  }

  private async loadCollectionItems(): Promise<Array<Request | RequestGroupNode>> {
    const entries = await fs.readdir(this.collectionsDir).catch(() => []);
    const items = await Promise.all(
      entries.map(async (name) => {
        if (name.endsWith('.req.json')) {
          return await this.getRequestUnlocked(name.slice(0, -'.req.json'.length));
        }
        if (name.endsWith('.grp.json')) {
          return await this.getGroup(name.slice(0, -'.grp.json'.length));
        }
        return null;
      })
    );
    return items.filter(Boolean) as Array<Request | RequestGroupNode>;
  }

}

function defaultSettings(): AppSettings {
  return {
    theme: 'dark',
    fontSize: 14,
    fontFamily: 'JetBrains Mono, Fira Code, monospace',
    defaultTimeout: 30000,
    defaultFollowRedirect: true,
    autoSaveHistory: true,
    maxHistorySize: 1000,
  };
}

function generateId(): Id {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
