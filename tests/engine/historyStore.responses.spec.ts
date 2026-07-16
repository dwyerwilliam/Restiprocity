import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { HistoryStore } from '../../src/main/stores/historyStore';
import { RESPONSE_PREVIEW_MAX_BYTES } from '../../src/shared/responseLimits';
import { PersistedResponseSnapshotV2 } from '../../src/shared/types';

const LEGACY_SCHEMA = `
  CREATE TABLE history (
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
  'status_text',
  'cookies_json',
  'preview_version',
  'preview_kind',
  'preview_bytes',
  'preview_truncated',
  'preview_captured_bytes',
  'media_type',
  'charset',
  'download_outcome',
  'download_filename',
  'download_bytes',
];

interface HistoryRow {
  response_body: Buffer | null;
  preview_version: number;
  preview_kind: string;
  preview_bytes: Buffer | null;
  preview_truncated: number;
  preview_captured_bytes: number;
  status_text: string;
  cookies_json: string;
  media_type: string | null;
  charset: string | null;
  download_outcome: string | null;
  download_filename: string | null;
  download_bytes: number | null;
}

async function withTempUserData(run: (userDataPath: string, dbPath: string) => Promise<void>) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-history-'));
  const dbPath = path.join(userDataPath, 'history.db');

  try {
    await run(userDataPath, dbPath);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

function seedLegacyDatabase(dbPath: string, body: Buffer, userVersion = 0): void {
  const db = new Database(dbPath);
  try {
    db.exec(LEGACY_SCHEMA);
    db.pragma(`user_version = ${userVersion}`);
    db.prepare(`
      INSERT INTO history (
        id, request_id, request_name, method, url, status, duration,
        size, timestamp, response_body, response_headers, response_timings
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-response',
      'legacy-request',
      'Legacy request',
      'POST',
      'https://example.test/legacy',
      201,
      47,
      body.byteLength,
      1_725_000_000_000,
      body,
      JSON.stringify([{ key: 'content-type', value: 'text/plain', enabled: true }]),
      JSON.stringify({ dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 47 }),
    );
  } finally {
    db.close();
  }
}

function responseSnapshot(
  id: string,
  preview: PersistedResponseSnapshotV2['preview'],
  download?: PersistedResponseSnapshotV2['download'],
): PersistedResponseSnapshotV2 {
  return {
    version: 2,
    id,
    requestId: `request-${id}`,
    status: 200,
    statusText: 'OK',
    headers: [{ key: 'content-type', value: 'application/octet-stream', enabled: true }],
    preview,
    timings: { dns: 1, tcp: 2, tls: 3, ttfb: 4, download: 5, total: 15 },
    timestamp: 1_725_000_000_000,
    size: preview.totalBytes,
    cookies: [{
      name: 'session',
      value: 'safe',
      domain: 'example.test',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    }],
    ...(download ? { download } : {}),
  };
}

test.describe('HistoryStore bounded response snapshots', () => {
  test('transactionally compacts oversized legacy response bodies', async () => {
    await withTempUserData(async (userDataPath, dbPath) => {
      const legacyBody = Buffer.alloc(RESPONSE_PREVIEW_MAX_BYTES + 257, 0x61);
      seedLegacyDatabase(dbPath, legacyBody);

      const store = new HistoryStore(userDataPath);
      await store.init();

      try {
        const reader = new Database(dbPath, { readonly: true });
        try {
          expect(reader.pragma('user_version', { simple: true })).toBe(2);

          const columns = reader.pragma('table_info(history)') as Array<{ name: string }>;
          expect(columns.slice(12).map(({ name }) => name)).toEqual(VERSION_2_COLUMNS);

          const row = reader.prepare(`
            SELECT response_body, preview_version, preview_kind, preview_bytes,
              preview_truncated, preview_captured_bytes, status_text, cookies_json,
              media_type, charset, download_outcome, download_filename, download_bytes,
              request_id, request_name, method, url, status, duration, size, timestamp,
              response_headers, response_timings
            FROM history WHERE id = ?
          `).get('legacy-response') as HistoryRow & Record<string, unknown>;

          expect(row.response_body).toBeNull();
          expect(row.preview_version).toBe(2);
          expect(row.preview_kind).toBe('text');
          expect(row.preview_bytes).toEqual(legacyBody.subarray(0, RESPONSE_PREVIEW_MAX_BYTES));
          expect(row.preview_bytes?.byteLength).toBe(RESPONSE_PREVIEW_MAX_BYTES);
          expect(row.preview_truncated).toBe(1);
          expect(row.preview_captured_bytes).toBe(RESPONSE_PREVIEW_MAX_BYTES);
          expect(row.charset).toBe('utf-8');
          expect(row).toMatchObject({
            request_id: 'legacy-request',
            request_name: 'Legacy request',
            method: 'POST',
            url: 'https://example.test/legacy',
            status: 201,
            duration: 47,
            size: legacyBody.byteLength,
            timestamp: 1_725_000_000_000,
          });
          expect(JSON.parse(row.response_headers as string)).toEqual([
            { key: 'content-type', value: 'text/plain', enabled: true },
          ]);
          expect(JSON.parse(row.response_timings as string)).toMatchObject({ total: 47 });
        } finally {
          reader.close();
        }

        const listed = await store.list();
        expect(listed).toEqual([{
          id: 'legacy-response',
          requestId: 'legacy-request',
          requestName: 'Legacy request',
          method: 'POST',
          url: 'https://example.test/legacy',
          status: 201,
          timestamp: 1_725_000_000_000,
          duration: 47,
          size: legacyBody.byteLength,
        }]);
        expect(Object.keys(listed[0])).not.toEqual(expect.arrayContaining([
          'response_body',
          'preview_bytes',
          'headers',
          'timings',
          'cookies',
        ]));

        const entry = await store.getEntry('legacy-response');
        expect(entry).not.toHaveProperty('response_body');
        expect(entry.preview_bytes).toHaveLength(RESPONSE_PREVIEW_MAX_BYTES);
      } finally {
        store.destroy();
      }
    });
  });

  test('rolls back a failed response history migration', async () => {
    await withTempUserData(async (userDataPath, dbPath) => {
      const legacyBody = Buffer.alloc(RESPONSE_PREVIEW_MAX_BYTES + 1, 0x62);
      seedLegacyDatabase(dbPath, legacyBody, 1);

      const setup = new Database(dbPath);
      setup.exec(`
        CREATE TRIGGER fail_response_body_clear
        BEFORE UPDATE OF response_body ON history
        WHEN NEW.response_body IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'forced migration failure');
        END;
      `);
      setup.close();

      const failedStore = new HistoryStore(userDataPath);
      await expect(failedStore.init()).rejects.toThrow('forced migration failure');

      const legacyReader = new Database(dbPath);
      try {
        expect(legacyReader.pragma('user_version', { simple: true })).toBe(1);
        const columns = legacyReader.pragma('table_info(history)') as Array<{ name: string }>;
        expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining(VERSION_2_COLUMNS));

        const row = legacyReader.prepare(
          'SELECT response_body, method, url, status, size FROM history WHERE id = ?',
        ).get('legacy-response') as {
          response_body: Buffer;
          method: string;
          url: string;
          status: number;
          size: number;
        };
        expect(row.response_body).toEqual(legacyBody);
        expect(row).toMatchObject({
          method: 'POST',
          url: 'https://example.test/legacy',
          status: 201,
          size: legacyBody.byteLength,
        });

        legacyReader.exec('DROP TRIGGER fail_response_body_clear');
      } finally {
        legacyReader.close();
      }

      const retryStore = new HistoryStore(userDataPath);
      await retryStore.init();
      retryStore.destroy();

      const migratedReader = new Database(dbPath, { readonly: true });
      try {
        expect(migratedReader.pragma('user_version', { simple: true })).toBe(2);
        const row = migratedReader.prepare(
          'SELECT response_body, length(preview_bytes) AS preview_length FROM history WHERE id = ?',
        ).get('legacy-response') as { response_body: null; preview_length: number };
        expect(row.response_body).toBeNull();
        expect(row.preview_length).toBe(RESPONSE_PREVIEW_MAX_BYTES);
      } finally {
        migratedReader.close();
      }
    });
  });

  test('persists bounded previews and final download outcomes without payloads or paths', async () => {
    await withTempUserData(async (userDataPath, dbPath) => {
      const store = new HistoryStore(userDataPath);
      await store.init();

      const oversizedText = `${'a'.repeat(RESPONSE_PREVIEW_MAX_BYTES - 1)}€`;
      await store.saveSnapshot(responseSnapshot('text', {
        kind: 'text',
        format: 'text',
        text: oversizedText,
        parseState: 'unparsed',
        charset: 'utf-8',
        decodeError: false,
        capturedBytes: RESPONSE_PREVIEW_MAX_BYTES + 2,
        totalBytes: RESPONSE_PREVIEW_MAX_BYTES + 2,
        truncated: false,
        completeness: 'complete',
      }));

      await store.saveSnapshot(responseSnapshot('image', {
        kind: 'image',
        mediaType: 'image/png',
        dimensions: { width: 1, height: 1, pixels: 1, validated: true },
        capturedBytes: 68,
        totalBytes: 68,
        truncated: false,
      }));

      for (const [state, bytes] of [['saved', 4096], ['cancelled', 0], ['failed', 512]] as const) {
        const download = {
          state,
          reason: 'attachment' as const,
          mediaType: 'application/zip',
          suggestedFileName: `${state}.zip`,
          receivedBytes: bytes,
          ...(state === 'failed' ? { failure: { code: 'disk-full', message: 'Download failed.' } } : {}),
        };
        const unsafeSnapshot = {
          ...responseSnapshot(state, {
            kind: 'download-only' as const,
            mediaType: 'application/zip',
            capturedBytes: 0,
            totalBytes: bytes,
            truncated: bytes > 0,
            download,
          }, download),
          destinationPath: `C:\\private\\${state}.zip`,
          downloadedBytes: Buffer.alloc(32, 0x7f),
        };
        await store.saveSnapshot(unsafeSnapshot);
      }

      try {
        const reader = new Database(dbPath, { readonly: true });
        try {
          const rows = reader.prepare(`
            SELECT id, response_body, preview_kind, preview_bytes, preview_captured_bytes,
              preview_truncated, media_type, charset, status_text, cookies_json,
              download_outcome, download_filename, download_bytes
            FROM history ORDER BY id
          `).all() as Array<HistoryRow & { id: string }>;

          expect(rows).toHaveLength(5);
          expect(rows.every((row) => row.response_body === null)).toBe(true);

          const text = rows.find((row) => row.id === 'text')!;
          expect(text.preview_kind).toBe('text');
          expect(text.preview_bytes?.byteLength).toBe(RESPONSE_PREVIEW_MAX_BYTES - 1);
          expect(text.preview_truncated).toBe(1);
          expect(text.preview_captured_bytes).toBe(RESPONSE_PREVIEW_MAX_BYTES - 1);
          expect(text.charset).toBe('utf-8');
          expect(text.status_text).toBe('OK');
          expect(JSON.parse(text.cookies_json)).toHaveLength(1);

          const image = rows.find((row) => row.id === 'image')!;
          expect(image).toMatchObject({
            preview_kind: 'image',
            preview_bytes: null,
            media_type: 'image/png',
            download_outcome: null,
          });

          for (const [state, bytes] of [['saved', 4096], ['cancelled', 0], ['failed', 512]] as const) {
            const row = rows.find((candidate) => candidate.id === state)!;
            expect(row).toMatchObject({
              preview_kind: 'download-only',
              preview_bytes: null,
              media_type: 'application/zip',
              download_outcome: state,
              download_filename: `${state}.zip`,
              download_bytes: bytes,
            });
          }

          const serializedRows = JSON.stringify(rows);
          expect(serializedRows).not.toContain('C:\\private');
          expect(serializedRows).not.toContain(Buffer.alloc(32, 0x7f).toString('base64'));
        } finally {
          reader.close();
        }
      } finally {
        store.destroy();
      }
    });
  });
});
