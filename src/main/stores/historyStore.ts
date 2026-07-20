import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import {
  DownloadMetadataV2,
  HistoryEntry,
  Id,
  PersistedResponseSnapshotV2,
  ResponseV2,
} from '@shared/types';
import { normalizeResponseSnapshotV2, toPersistedResponseV2 } from '@shared/responseContracts';

const HISTORY_SCHEMA_VERSION = 2;
const TERMINAL_DOWNLOAD_OUTCOMES = new Set(['saved', 'cancelled', 'failed']);

const LEGACY_HISTORY_SCHEMA = `
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
`;

const VERSION_2_COLUMNS = [
  'status_text TEXT',
  'cookies_json TEXT',
  'preview_version INTEGER',
  'preview_kind TEXT',
  'preview_bytes BLOB',
  'preview_truncated INTEGER',
  'preview_captured_bytes INTEGER',
  'media_type TEXT',
  'charset TEXT',
  'download_outcome TEXT',
  'download_filename TEXT',
  'download_bytes INTEGER',
] as const;

function downloadMetadata(snapshot: PersistedResponseSnapshotV2): DownloadMetadataV2 | undefined {
  if (snapshot.download) {
    return snapshot.download;
  }
  if (snapshot.preview.kind === 'binary' || snapshot.preview.kind === 'download-only') {
    return snapshot.preview.download;
  }
  return undefined;
}

function mediaType(snapshot: PersistedResponseSnapshotV2): string | null {
  if (
    snapshot.preview.kind === 'image'
    || snapshot.preview.kind === 'binary'
    || snapshot.preview.kind === 'download-only'
  ) {
    return snapshot.preview.mediaType;
  }

  const contentType = snapshot.headers.find(
    (header) => header.enabled && header.key.toLowerCase() === 'content-type',
  )?.value;
  return contentType?.split(';', 1)[0].trim().toLowerCase() || null;
}

function terminalDownloadMetadata(snapshot: PersistedResponseSnapshotV2): DownloadMetadataV2 | undefined {
  const download = downloadMetadata(snapshot);
  return download && TERMINAL_DOWNLOAD_OUTCOMES.has(download.state) ? download : undefined;
}

function filenameOnly(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const filename = value.split(/[\\/]/).pop()?.trim();
  return filename || null;
}

export class HistoryStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(userDataPath: string) {
    this.dbPath = path.join(userDataPath, 'history.db');
  }

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    const db = new Database(this.dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      this.migrate(db);
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private migrate(db: Database.Database): void {
    const currentVersion = db.pragma('user_version', { simple: true }) as number;
    if (currentVersion > HISTORY_SCHEMA_VERSION) {
      throw new Error(`Unsupported history schema version: ${currentVersion}`);
    }
    if (currentVersion === HISTORY_SCHEMA_VERSION) {
      return;
    }

    const migrateToVersion2 = db.transaction(() => {
      db.exec(LEGACY_HISTORY_SCHEMA);
      for (const column of VERSION_2_COLUMNS) {
        db.exec(`ALTER TABLE history ADD COLUMN ${column}`);
      }

      db.exec(`
        UPDATE history
        SET
          status_text = '',
          cookies_json = '[]',
          preview_version = 2,
          preview_kind = 'empty',
          preview_bytes = NULL,
          preview_truncated = 0,
          preview_captured_bytes = 0,
          media_type = NULL,
          charset = NULL,
          download_outcome = NULL,
          download_filename = NULL,
          download_bytes = NULL;

        UPDATE history SET response_body = NULL;

        CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_history_status ON history(status);
        CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
      `);
      db.pragma(`user_version = ${HISTORY_SCHEMA_VERSION}`);
    });

    migrateToVersion2.immediate();
  }

  private database(): Database.Database {
    if (!this.db) {
      throw new Error('HistoryStore is not initialized');
    }
    return this.db;
  }

  async save(response: ResponseV2): Promise<void> {
    await this.saveSnapshot(toPersistedResponseV2(response));
  }

  async saveSnapshot(response: PersistedResponseSnapshotV2): Promise<void> {
    const snapshot = normalizeResponseSnapshotV2(response);
    const previewBytes = snapshot.preview.kind === 'text'
      ? Buffer.from(snapshot.preview.text, 'utf8')
      : null;
    const download = terminalDownloadMetadata(snapshot);

    this.database().prepare(`
      INSERT OR REPLACE INTO history (
        id, request_id, request_name, method, url, status,
        duration, size, timestamp, response_body,
        response_headers, response_timings, status_text, cookies_json,
        preview_version, preview_kind, preview_bytes, preview_truncated,
        preview_captured_bytes, media_type, charset, download_outcome,
        download_filename, download_bytes
      ) VALUES (
        @id, @request_id, @request_name, @method, @url, @status,
        @duration, @size, @timestamp, NULL,
        @response_headers, @response_timings, @status_text, @cookies_json,
        2, @preview_kind, @preview_bytes, @preview_truncated,
        @preview_captured_bytes, @media_type, @charset, @download_outcome,
        @download_filename, @download_bytes
      )
    `).run({
      id: snapshot.id,
      request_id: snapshot.requestId,
      request_name: '',
      method: '',
      url: '',
      status: snapshot.status,
      duration: snapshot.timings.total,
      size: snapshot.size,
      timestamp: snapshot.timestamp,
      response_headers: JSON.stringify(snapshot.headers),
      response_timings: JSON.stringify(snapshot.timings),
      status_text: snapshot.statusText,
      cookies_json: JSON.stringify(snapshot.cookies),
      preview_kind: snapshot.preview.kind,
      preview_bytes: previewBytes,
      preview_truncated: snapshot.preview.truncated ? 1 : 0,
      preview_captured_bytes: previewBytes?.byteLength ?? snapshot.preview.capturedBytes,
      media_type: mediaType(snapshot),
      charset: snapshot.preview.kind === 'text' ? snapshot.preview.charset : null,
      download_outcome: download?.state ?? null,
      download_filename: filenameOnly(download?.suggestedFileName),
      download_bytes: download?.receivedBytes ?? null,
    });
  }

  async list(filters?: {
    dateFrom?: number;
    dateTo?: number;
    status?: number;
    url?: string;
    limit?: number;
  }): Promise<HistoryEntry[]> {
    let query = `
      SELECT id, request_id, request_name, method, url, status,
        timestamp, duration, size
      FROM history
      WHERE 1=1
    `;
    const params: Record<string, number | string> = {};

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

    const rows = this.database().prepare(query).all(params) as Array<Record<string, any>>;
    return rows.map((row) => ({
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
    this.database().exec('DELETE FROM history');
  }

  async getEntry(id: Id): Promise<any | null> {
    const row = this.database().prepare(`
      SELECT id, request_id, request_name, method, url, status, duration, size,
        timestamp, response_headers, response_timings, status_text, cookies_json,
        preview_version, preview_kind, preview_bytes, preview_truncated,
        preview_captured_bytes, media_type, charset, download_outcome,
        download_filename, download_bytes
      FROM history
      WHERE id = ?
    `).get(id) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      ...row,
      headers: JSON.parse(row.response_headers ?? '[]'),
      timings: JSON.parse(row.response_timings ?? '{}'),
      cookies: JSON.parse(row.cookies_json ?? '[]'),
    };
  }

  destroy(): void {
    this.db?.close();
    this.db = null;
  }
}
