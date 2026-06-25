import fs from 'fs/promises';
import path from 'path';
import { Request, RequestGroup, Environment, AppSettings, Id } from '@shared/types';

export class CollectionStore {
  private collectionsDir: string;
  private envsDir: string;
  private settingsPath: string;
  private activeEnvId: string | null = null;

  constructor(userDataPath: string) {
    this.collectionsDir = path.join(userDataPath, 'collections');
    this.envsDir = path.join(userDataPath, 'environments');
    this.settingsPath = path.join(userDataPath, 'settings.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.collectionsDir, { recursive: true });
    await fs.mkdir(this.envsDir, { recursive: true });

    // Load settings or create defaults
    if (!await this.fileExists(this.settingsPath)) {
      await this.saveSettings(defaultSettings());
    }
  }

  // ─── Requests ───────────────────────────────────────────────
  async createRequest(data: Omit<Request, 'id' | 'createdAt' | 'updatedAt'>): Promise<Request> {
    const now = Date.now();
    const request: Request = {
      ...data,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFile(this.requestPath(request.id), request);
    return request;
  }

  async getRequest(id: Id): Promise<Request | null> {
    return this.loadFile<Request>(this.requestPath(id));
  }

  async updateRequest(id: Id, data: Partial<Request>): Promise<Request> {
    const existing = await this.getRequest(id);
    if (!existing) throw new Error(`Request ${id} not found`);
    const updated = { ...existing, ...data, id, updatedAt: Date.now() };
    await this.saveFile(this.requestPath(id), updated);
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
        const ext = path.extname(name);
        const id = path.basename(name, ext);
        if (ext === '.req.json') {
          return await this.getRequest(id);
        }
        if (ext === '.grp.json') {
          return await this.getGroup(id);
        }
        return null;
      })
    );
    return items.filter(Boolean);
  }

  // ─── Environments ───────────────────────────────────────────
  async listEnvironments(): Promise<Environment[]> {
    const entries = await fs.readdir(this.envsDir).catch(() => []);
    const envs = await Promise.all(
      entries
        .filter(n => n.endsWith('.json'))
        .map(name => this.loadFile<Environment>(path.join(this.envsDir, name)))
    );
    return envs.filter(Boolean) as Environment[];
  }

  async createEnvironment(data: Omit<Environment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Environment> {
    const now = Date.now();
    const env: Environment = {
      ...data,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
    };
    await this.saveFile(this.envPath(env.id), env);
    return env;
  }

  async updateEnvironment(id: Id, data: Partial<Environment>): Promise<Environment> {
    const existing = await this.getEnvironment(id);
    if (!existing) throw new Error(`Environment ${id} not found`);
    const updated = { ...existing, ...data, id, updatedAt: Date.now() };
    await this.saveFile(this.envPath(id), updated);
    return updated;
  }

  async deleteEnvironment(id: Id): Promise<void> {
    await fs.unlink(this.envPath(id)).catch(() => {});
  }

  async getEnvironment(id: Id): Promise<Environment | null> {
    return this.loadFile<Environment>(this.envPath(id));
  }

  switchEnvironment(id: string | null): void {
    this.activeEnvId = id;
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
    // TODO: Parse various formats (Postman, Insomnia, OpenAPI, cURL)
    // For now, handle our native format
    if (data.type === 'request') {
      await this.createRequest(data);
    } else if (data.type === 'group') {
      await this.createGroup(data);
    }
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
    if (data.nodeType === 'request') {
      return this.createRequest(data);
    }
    return this.createGroup(data);
  }

  async update(id: Id, data: any): Promise<any> {
    if (data.nodeType === 'request' || data.method) {
      return this.updateRequest(id, data);
    }
    return this.updateGroup(id, data);
  }

  async delete(id: Id): Promise<void> {
    await this.deleteRequest(id);
    await this.deleteGroup(id);
  }

  async duplicate(id: Id): Promise<any> {
    const req = await this.getRequest(id);
    if (req) {
      return this.createRequest({ ...(req as any), name: `${req.name} (copy)` });
    }
    const grp = await this.getGroup(id);
    if (grp) {
      return this.createGroup({ ...(grp as any), name: `${grp.name} (copy)`, children: [] });
    }
    throw new Error(`Item ${id} not found`);
  }

  async reorder(data: any): Promise<void> {
    // Reorder is handled by updating parent group's children array
    const { parentId, children } = data;
    if (parentId) {
      await this.updateGroup(parentId, { children });
    }
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
