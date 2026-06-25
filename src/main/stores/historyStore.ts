import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import { Response, HistoryEntry, Id } from '@shared/types';

export class HistoryStore {
  private db: Database.Database;
  private dbPath: string;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, 'history.db');
    this.db = null as any;
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        request_name TEXT,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        size INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        response_body BLOB,
        response_headers TEXT,
        response_timings TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);
      CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
    `);
  }

  async save(response: Response): Promise<void> {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO history (
        id, request_id, request_name, method, url, status,
        duration, size, timestamp, response_body,
        response_headers, response_timings
      ) VALUES (@id, @request_id, @request_name, @method, @url, @status,
        @duration, @size, @timestamp, @response_body,
        @response_headers, @response_timings)
    `);

    insert.run({
      id: response.id,
      request_id: response.requestId,
      request_name: '', // Could be populated from request store
      method: '', // Populated from request
      url: '', // Populated from request
      status: response.status,
      duration: response.timings.total,
      size: response.size,
      timestamp: response.timestamp,
      response_body: response.body,
      response_headers: JSON.stringify(response.headers),
      response_timings: JSON.stringify(response.timings),
    });
  }

  async list(filters?: {
    dateFrom?: number;
    dateTo?: number;
    status?: number;
    url?: string;
    limit?: number;
  }): Promise<HistoryEntry[]> {
    let query = 'SELECT * FROM history WHERE 1=1';
    const params: any = {};

    if (filters?.dateFrom) {
      query += ' AND timestamp >= @dateFrom';
      params.dateFrom = filters.dateFrom;
    }
    if (filters?.dateTo) {
      query += ' AND timestamp <= @dateTo';
      params.dateTo = filters.dateTo;
    }
    if (filters?.status) {
      query += ' AND status = @status';
      params.status = filters.status;
    }
    if (filters?.url) {
      query += ' AND url LIKE @url';
      params.url = `%${filters.url}%`;
    }

    query += ' ORDER BY timestamp DESC';

    if (filters?.limit) {
      query += ' LIMIT @limit';
      params.limit = filters.limit;
    }

    const rows = this.db.prepare(query).all(params) as any[];
    return rows.map(row => ({
      id: row.id,
      requestId: row.request_id,
      requestName: row.request_name,
      method: row.method,
      url: row.url,
      status: row.status,
      timestamp: row.timestamp,
      duration: row.duration,
      size: row.size,
    }));
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM history');
  }

  async getEntry(id: Id): Promise<any | null> {
    const row = this.db.prepare('SELECT * FROM history WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      ...row,
      headers: JSON.parse(row.response_headers),
      timings: JSON.parse(row.response_timings),
    };
  }

  destroy(): void {
    this.db.close();
  }
}
