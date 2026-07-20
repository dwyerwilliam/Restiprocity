import fs from 'fs/promises';
import path from 'path';
import { normalizeResponseSnapshotV2, toRendererResponseV2 } from '@shared/responseContracts';
import { Request, RequestGroup, Environment, AppSettings, Id, CORE_ENVIRONMENT_ID, CORE_ENVIRONMENT_NAME, ResponseV2 } from '@shared/types';

export class CollectionStore {
  private collectionsDir: string;
  private envsDir: string;
  private settingsPath: string;
  private rootOrderPath: string;
  private activeEnvId: string | null = null;

  constructor(userDataPath: string) {
    this.collectionsDir = path.join(userDataPath, 'collections');
    this.envsDir = path.join(userDataPath, 'environments');
    this.settingsPath = path.join(userDataPath, 'settings.json');
    this.rootOrderPath = path.join(this.collectionsDir, '.root-order.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.collectionsDir, { recursive: true });
    await fs.mkdir(this.envsDir, { recursive: true });

    // Load settings or create defaults
    if (!await this.fileExists(this.settingsPath)) {
      await this.saveSettings(defaultSettings());
    }

    await this.ensureCoreEnvironment();
    this.activeEnvId = CORE_ENVIRONMENT_ID;
  }

  // ─── Requests ───────────────────────────────────────────────
  async createRequest(data: Omit<Request, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Request, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Request> {
    const now = Date.now();
    const request = this.hydrateRequestResponse({
      ...data,
      id: data.id ?? generateId(),
      createdAt: data.createdAt ?? now,
      updatedAt: now,
    });
    await this.saveRequestFile(request);
    return request;
  }

  async getRequest(id: Id): Promise<Request | null> {
    const request = await this.loadFile<Request>(this.requestPath(id));
    return request ? this.hydrateRequestResponse(request) : null;
  }

  async updateRequest(id: Id, data: Partial<Request>): Promise<Request> {
    const existing = await this.getRequest(id);
    if (!existing) {
      return this.createRequest({
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
    const updated = this.hydrateRequestResponse({ ...existing, ...data, id, updatedAt: Date.now() });
    await this.saveRequestFile(updated);
    return updated;
  }

  async deleteRequest(id: Id): Promise<void> {
    await fs.unlink(this.requestPath(id)).catch(() => {});
  }

  // ─── Groups ─────────────────────────────────────────────────
  async createGroup(data: Omit<RequestGroup, 'id' | 'createdAt' | 'updatedAt'>): Promise<RequestGroup> {
    const now = Date.now();
    const group: RequestGroup = {
      ...data,
      id: generateId(),
      children: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFile(this.groupPath(group.id), group);
    return group;
  }

  async getGroup(id: Id): Promise<RequestGroup | null> {
    return this.loadFile<RequestGroup>(this.groupPath(id));
  }

  async updateGroup(id: Id, data: Partial<RequestGroup>): Promise<RequestGroup> {
    const existing = await this.getGroup(id);
    if (!existing) throw new Error(`Group ${id} not found`);
    const updated = { ...existing, ...data, id, updatedAt: Date.now() };
    await this.saveFile(this.groupPath(id), updated);
    return updated;
  }

  async deleteGroup(id: Id): Promise<void> {
    await fs.unlink(this.groupPath(id)).catch(() => {});
  }

  // ─── Listing ────────────────────────────────────────────────
  async listAll(): Promise<any[]> {
    const entries = await fs.readdir(this.collectionsDir).catch(() => []);
    const items = await Promise.all(
      entries.map(async (name) => {
        if (name.endsWith('.req.json')) {
          return await this.getRequest(name.slice(0, -'.req.json'.length));
        }
        if (name.endsWith('.grp.json')) {
          return await this.getGroup(name.slice(0, -'.grp.json'.length));
        }
        return null;
      })
    );
    const collectionItems = items.filter(Boolean) as (Request | RequestGroup)[];
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
    const now = Date.now();
    const id = data.id ?? generateId();
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
    await this.saveFile(this.envPath(env.id), env);
    return env;
  }

  async updateEnvironment(id: Id, data: Partial<Environment>): Promise<Environment> {
    const existing = await this.getEnvironment(id);
    if (!existing) throw new Error(`Environment ${id} not found`);
    const updated = { ...existing, ...data, id, updatedAt: Date.now() };
    if (id === CORE_ENVIRONMENT_ID) {
      delete updated.parentId;
    }
    await this.saveFile(this.envPath(id), updated);
    return updated;
  }

  async deleteEnvironment(id: Id): Promise<void> {
    if (id === CORE_ENVIRONMENT_ID) return;
    await fs.unlink(this.envPath(id)).catch(() => {});
    if (this.activeEnvId === id) {
      this.activeEnvId = CORE_ENVIRONMENT_ID;
    }
  }

  async getEnvironment(id: Id): Promise<Environment | null> {
    return this.loadFile<Environment>(this.envPath(id));
  }

  switchEnvironment(id: string | null): void {
    this.activeEnvId = id ?? CORE_ENVIRONMENT_ID;
  }

  getActiveEnvironmentId(): string | null {
    return this.activeEnvId;
  }

  // ─── Settings ───────────────────────────────────────────────
  async getSettings(): Promise<AppSettings> {
    const settings = await this.loadFile<AppSettings>(this.settingsPath);
    return settings ?? defaultSettings();
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    await this.saveFile(this.settingsPath, settings);
  }

  // ─── Import/Export ──────────────────────────────────────────
  async export(id: Id): Promise<any> {
    const request = await this.getRequest(id);
    const group = await this.getGroup(id);
    return request || group;
  }

  async import(data: any): Promise<void> {
    if (this.isPostmanCollection(data)) {
      await this.importPostmanCollection(data);
    } else if (this.isInsomniaExport(data)) {
      await this.importInsomniaExport(data);
    } else if (data.type === 'request') {
      await this.createRequest(data);
    } else if (data.type === 'group') {
      await this.createGroup(data);
    }
  }

  private isPostmanCollection(data: any): boolean {
    return data?.info?.schema?.startsWith('https://schema.getpostman.com') ||
           data?.info?.schema?.startsWith('https://schema.postman.com');
  }

  private isInsomniaExport(data: any): boolean {
    return data?._type === 'collection' ||
           (Array.isArray(data) && data.length > 0 && data[0]?._type);
  }

  private async importPostmanCollection(collection: any): Promise<void> {
    if (collection.item) {
      await this.importPostmanItems(collection.item, undefined);
    }
  }

  private async importPostmanItems(items: any[], parentId: Id | undefined): Promise<void> {
    for (const item of items) {
      if (item.item) {
        const group = await this.createGroup({
          name: item.name,
          parentId,
          children: [],
        });
        await this.importPostmanItems(item.item, group.id);
      } else if (item.request) {
        await this.createRequest({
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

  private async importInsomniaExport(data: any): Promise<void> {
    const resources = Array.isArray(data) ? data : data.resources;
    if (!resources) return;

    const requests = resources.filter((r: any) => r._type === 'request');
    const folders = resources.filter((r: any) => r._type === 'folder');
    const envs = resources.filter((r: any) => r._type === 'environment');

    for (const env of envs) {
      await this.createEnvironment({
        name: env.name || 'Imported Environment',
        variables: (env.variables || []).map((v: any) => ({
          key: v.name,
          value: v.value || '',
          type: 'standard' as const,
        })),
      });
    }

    for (const folder of folders) {
      await this.createGroup({
        name: folder.name,
        parentId: folder.parent,
        children: [],
      });
    }

    for (const req of requests) {
      await this.createRequest({
        name: req.name || 'Untitled Request',
        method: this.parseInsomniaMethod(req.method),
        url: this.parseInsomniaUrl(req),
        headers: this.parseInsomniaHeaders(req.headers),
        parameters: [],
        body: this.parseInsomniaBody(req.body),
        auth: this.parseInsomniaAuth(req.authentication),
        settings: {
          followRedirect: req.followRedirects ?? true,
          timeout: req.timeout ?? 30000,
          cookiesEnabled: true,
        },
        scripts: {},
        parentId: req.parent,
      });
    }
  }

  private parseInsomniaMethod(method: string): import('@shared/types').HttpMethod {
    const upper = method?.toUpperCase();
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    return (validMethods.includes(upper) ? upper : 'GET') as import('@shared/types').HttpMethod;
  }

  private parseInsomniaUrl(req: any): string {
    if (typeof req.url === 'string') return req.url;
    if (typeof req.path === 'string' && req.protocol_profile) {
      const protocol = req.protocol_profile.includes('https') ? 'https' : 'http';
      return `${protocol}://${req.hosts || 'localhost'}${req.path ? '/' + req.path : ''}`;
    }
    return 'http://localhost';
  }

  private parseInsomniaHeaders(headers: any[]): import('@shared/types').Header[] {
    if (!headers) return [];
    return headers
      .filter(h => h.name)
      .map(h => ({ key: h.name, value: h.value || '', enabled: !h.disabled }));
  }

  private parseInsomniaBody(body: any): import('@shared/types').RequestBody {
    if (!body) return { type: 'none' };

    if (body.mimeType === 'application/json' || body.mimeType === 'text/plain') {
      return {
        type: 'raw',
        raw: {
          language: body.mimeType === 'application/json' ? 'json' : 'text',
          content: body.text || '',
        },
      };
    }

    if (body.params) {
      if (body.mimeType?.includes('multipart')) {
        return {
          type: 'multipart',
          multipart: body.params
            .filter((p: any) => p.name)
            .map((p: any) => ({
              key: p.name,
              type: p.type === 'FILES' ? 'file' as const : 'text' as const,
              value: p.value || '',
              enabled: !p.disabled,
            })),
        };
      }
      return {
        type: 'form-urlencoded',
        form: body.params
          .filter((p: any) => p.name)
          .map((p: any) => ({ key: p.name, value: p.value || '', enabled: !p.disabled })),
      };
    }

    return { type: 'none' };
  }

  private parseInsomniaAuth(auth: any): import('@shared/types').AuthConfig {
    if (!auth) return { type: 'none' };

    if (auth.schema === 'oauth2' || auth.schema === 'oauth_2') {
      return {
        type: 'oauth2',
        oauth2: {
          grantType: auth.grantType || auth.grant_type || 'client_credentials',
          authorizationUrl: auth.authorizationUrl || auth.authorization_url || '',
          tokenUrl: auth.tokenUrl || auth.token_url || auth.accessTokenUrl || '',
          clientId: auth.clientId || auth.client_id || '',
          clientSecret: auth.clientSecret || auth.client_secret || '',
          scope: auth.scope || '',
          redirectUri: auth.redirectUri || auth.redirect_uri || '',
        },
      };
    }

    if (auth.schema === 'bearer') {
      return {
        type: 'bearer',
        bearer: {
          token: auth.token || '',
          prefix: 'Bearer',
        },
      };
    }

    if (auth.schema === 'basic') {
      return {
        type: 'basic',
        basic: {
          username: auth.username || '',
          password: auth.password || '',
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
    const { lastResponse, ...requestData } = request;
    const persistedRequest = lastResponse === undefined
      ? requestData
      : { ...requestData, lastResponse: normalizeResponseSnapshotV2(lastResponse) };

    await this.saveFile(this.requestPath(request.id), persistedRequest);
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
    const { nodeType, ...payload } = data ?? {};

    if (nodeType === 'request' || payload.method) {
      return this.updateRequest(id, payload);
    }

    if (nodeType === 'group') {
      return this.updateGroup(id, payload);
    }

    if (await this.getRequest(id)) {
      return this.updateRequest(id, payload);
    }

    return this.updateGroup(id, payload);
  }

  async delete(id: Id): Promise<void> {
    await this.deleteRequest(id);
    await this.deleteGroup(id);
  }

  async duplicate(id: Id): Promise<any> {
    const req = await this.getRequest(id);
    if (req) {
      const { id: _id, createdAt: _createdAt, ...rest } = req as any;
      return this.createRequest({ ...rest, name: `${req.name} (copy)` });
    }
    const grp = await this.getGroup(id);
    if (grp) {
      const { id: _id, createdAt: _createdAt, ...rest } = grp as any;
      return this.createGroup({ ...rest, name: `${grp.name} (copy)`, children: [] });
    }
    throw new Error(`Item ${id} not found`);
  }

  async reorder(data: any): Promise<void> {
    const { parentId, children } = data;
    if (parentId) {
      await this.updateGroup(parentId, { children });
      return;
    }

    await this.saveRootOrder(children);
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
