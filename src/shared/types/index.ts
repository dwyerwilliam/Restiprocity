/**
 * Core domain types for Restiprocity.
 * Defines the data model for requests, responses, collections, environments, etc.
 */

// ─── Identifiers ───────────────────────────────────────────────
export type Id = string;

// ─── HTTP Methods ──────────────────────────────────────────────
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

// ─── Request Body Types ────────────────────────────────────────
export type BodyType = 'none' | 'raw' | 'form-urlencoded' | 'multipart';

export type RawBodyLanguage = 'json' | 'xml' | 'text' | 'html' | 'javascript';

export interface RawBody {
  language: RawBodyLanguage;
  content: string;
}

export interface FormField {
  key: string;
  value: string;
  enabled: boolean;
}

export interface MultipartField {
  key: string;
  type: 'text' | 'file';
  value: string;
  filePath?: string;
  enabled: boolean;
}

export interface RequestBody {
  type: BodyType;
  raw?: RawBody;
  form?: FormField[];
  multipart?: MultipartField[];
}

// ─── Headers & Parameters ──────────────────────────────────────
export interface Header {
  key: string;
  value: string;
  enabled: boolean;
}

export interface QueryParameter {
  key: string;
  value: string;
  enabled: boolean;
}

// ─── Authentication ────────────────────────────────────────────
export type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2' | 'ntlm';

export interface AuthConfig {
  type: AuthType;
  bearer?: {
    token: string;
    prefix: string;
  };
  api_key?: {
    key: string;
    value: string;
    in: 'header' | 'query';
  };
  basic?: {
    username: string;
    password: string;
  };
  oauth2?: OAuth2Config;
  ntlm?: NtlmConfig;
}

export type OAuth2GrantType = 'authorization_code' | 'client_credentials' | 'password' | 'pkce';
export type OAuth2ClientAuthentication = 'none' | 'basic' | 'body';

export interface OAuth2Parameter {
  key: string;
  value: string;
  enabled: boolean;
}

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  clientAuthentication?: OAuth2ClientAuthentication;
  expectedIssuer?: string;
  authorizationParameters?: OAuth2Parameter[];
  tokenParameters?: OAuth2Parameter[];
}

export interface NtlmConfig {
  useCurrentAuthContext?: boolean;
  username?: string;
  password?: string;
  domain?: string;
  workstation?: string;
}

// ─── Request Settings ──────────────────────────────────────────
export interface RequestSettings {
  followRedirect: boolean;
  timeout: number;
  allowInsecureCertificates?: boolean;
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  cookiesEnabled?: boolean;
  userAgent?: string;
}

// ─── Request ───────────────────────────────────────────────────
export interface Request {
  id: Id;
  name: string;
  method: HttpMethod;
  url: string;
  headers: Header[];
  parameters: QueryParameter[];
  body: RequestBody;
  auth: AuthConfig;
  settings: RequestSettings;
  scripts: RequestScripts;
  /** Values taken from this request's response and offered to every request as `{{name}}`. */
  outputs?: RequestOutputs;
  lastResponse?: PersistedResponseV2;
  parentId?: Id;
  createdAt: number;
  updatedAt: number;
}

// ─── Scripts ───────────────────────────────────────────────────
export interface RequestScripts {
  preRequest?: string;
  afterResponse?: string;
}

// ─── Request outputs (token chaining) ─────────────────────────
export type RequestOutputSource =
  /** RFC 6901 pointer into the JSON body; '' is the whole document. */
  | { kind: 'json'; pointer: string }
  /** Response header, case-insensitive, first occurrence. */
  | { kind: 'header'; name: string }
  /** The whole decoded body text, trimmed. */
  | { kind: 'body' };

export interface RequestOutputValue {
  name: string;
  source: RequestOutputSource;
}

export interface RequestOutputs {
  /** Turning outputs off keeps the definition; IPC drops `undefined`, so a definition is never removed. */
  enabled: boolean;
  /** 1..10 when enabled (0 allowed when off); names unique. */
  values: RequestOutputValue[];
  /** Whole seconds, 1..31,536,000. */
  refreshAfterSeconds: number;
  /** Pointer to a seconds value in the JSON body; null ignores the response's expiry. */
  expiresInPointer: string | null;
  resendOn401: boolean;
}

export type TokenErrorCode =
  | 'TOKEN_SOURCE_MISSING'
  | 'TOKEN_SOURCE_INVALID'
  | 'TOKEN_SOURCE_CHAINED'
  | 'TOKEN_SOURCE_FAILED'
  | 'TOKEN_SOURCE_HTTP'
  | 'TOKEN_SOURCE_NOT_TEXT'
  | 'TOKEN_EXTRACT_FAILED'
  | 'TOKEN_NOT_FETCHED';

export type ResponseOutputsNoteV2 =
  /** A manual send of a request with outputs filled the cache. */
  | { kind: 'updated'; names: string[] }
  /** A manual send of a request with outputs did not fill the cache. */
  | { kind: 'not-updated'; message: string }
  /** The request got HTTP 401 with a cached value and was sent once more with a new one. */
  | { kind: 'resent-after-401'; names: string[] };

export interface RequestOutputStatus {
  requestId: Id;
  /** The canonical environment the status is for. */
  environmentId: Id;
  state: 'empty' | 'fresh' | 'stale' | 'fetching' | 'failed';
  /** Enabled output names; never values. */
  names: string[];
  fetchedAt?: number;
  refreshAt?: number;
  error?: { code: TokenErrorCode | null; message: string };
}

export interface OutputsStatusPayload {
  requestId: Id;
  environmentId?: Id;
}

export interface OutputsClearPayload {
  requestId: Id;
}

// ─── Response ──────────────────────────────────────────────────
/**
 * Where the DNS/TCP/TLS phases came from:
 * - `new-tcp`: measured from Chromium's NetLog for a fresh TCP (+TLS) connection.
 * - `new-quic`: measured for a fresh QUIC session; `tls` is the combined QUIC handshake and `tcp` is 0.
 * - `reused`: the request ran on an existing connection, so there was no connection setup.
 * - `unmeasured`: no NetLog data could be attributed; `dns`/`tcp`/`tls` are 0 and mean nothing.
 * Absent on snapshots recorded before measurement existed, which are equivalent to `unmeasured`.
 */
export type ResponseConnectionTiming = 'new-tcp' | 'new-quic' | 'reused' | 'unmeasured';

export interface ResponseTiming {
  dns: number;
  tcp: number;
  tls: number;
  ttfb: number;
  download: number;
  total: number;
  connection?: ResponseConnectionTiming;
}

export interface ResponseCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
}

export interface Response {
  id: Id;
  requestId: Id;
  status: number;
  statusText: string;
  headers: Header[];
  body: string;
  timings: ResponseTiming;
  timestamp: number;
  size: number;
  cookies: ResponseCookie[];
}

export type ResponseTextFormatV2 = 'json' | 'xml' | 'html' | 'svg' | 'text';
export type ResponseTextParseStateV2 = 'not-applicable' | 'unparsed' | 'valid' | 'invalid' | 'over-budget';
export type ResponseCompletenessV2 = 'complete' | 'truncated' | 'unknown';

export interface EmptyResponsePreviewV2 {
  kind: 'empty';
  capturedBytes: 0;
  totalBytes: 0;
  truncated: false;
  completeness: ResponseCompletenessV2;
}

export interface TextResponsePreviewV2 {
  kind: 'text';
  format: ResponseTextFormatV2;
  text: string;
  parseState: ResponseTextParseStateV2;
  charset: string;
  decodeError: boolean;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  completeness: ResponseCompletenessV2;
}

export interface ValidatedImageDimensionsV2 {
  width: number;
  height: number;
  pixels: number;
  validated: true;
}

export interface ImageResponsePreviewV2 {
  kind: 'image';
  mediaType: string;
  bytes: Uint8Array;
  dimensions: ValidatedImageDimensionsV2;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
}

export type DownloadReasonV2 =
  | 'attachment'
  | 'binary'
  | 'unsupported-media-type'
  | 'preview-limit'
  | 'invalid-image';

export type DownloadStateV2 =
  | 'awaiting-destination'
  | 'downloading'
  | 'publishing'
  | 'saved'
  | 'cancelled'
  | 'failed';

export interface DownloadFailureV2 {
  code: string | null;
  message: string;
}

export interface DownloadMetadataV2 {
  state: DownloadStateV2;
  reason: DownloadReasonV2;
  mediaType: string | null;
  suggestedFileName?: string;
  receivedBytes: number;
  declaredSize?: number;
  failure?: DownloadFailureV2;
}

export interface BinaryResponsePreviewV2 {
  kind: 'binary';
  mediaType: string | null;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  download: DownloadMetadataV2;
}

export interface DownloadOnlyResponsePreviewV2 {
  kind: 'download-only';
  mediaType: string | null;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  download: DownloadMetadataV2;
}

export type ResponsePreviewV2 =
  | EmptyResponsePreviewV2
  | TextResponsePreviewV2
  | ImageResponsePreviewV2
  | BinaryResponsePreviewV2
  | DownloadOnlyResponsePreviewV2;

export interface ResponseV2 {
  version: 2;
  id: Id;
  requestId: Id;
  status: number;
  statusText: string;
  headers: Header[];
  preview: ResponsePreviewV2;
  timings: ResponseTiming;
  timestamp: number;
  size: number;
  declaredSize?: number;
  cookies: ResponseCookie[];
  download?: DownloadMetadataV2;
  outputsNote?: ResponseOutputsNoteV2;
  /** The body was not stored because the request provides outputs, which are kept in memory only. */
  bodyWithheld?: 'outputs';
}

export type PersistedImageResponsePreviewV2 = Omit<ImageResponsePreviewV2, 'bytes'>;

export type PersistedResponsePreviewV2 =
  | EmptyResponsePreviewV2
  | TextResponsePreviewV2
  | PersistedImageResponsePreviewV2
  | BinaryResponsePreviewV2
  | DownloadOnlyResponsePreviewV2;

export interface PersistedResponseV2 extends Omit<ResponseV2, 'preview'> {
  preview: PersistedResponsePreviewV2;
}

export type PersistedResponseSnapshotV2 = PersistedResponseV2;

export type ResponseProgressPhaseV2 =
  | 'acquiring-token'
  | 'waiting-headers'
  | 'receiving'
  | 'awaiting-destination'
  | 'downloading'
  | 'publishing';

export interface ResponseProgressV2 {
  version: 2;
  operationId: Id;
  phase: ResponseProgressPhaseV2;
  receivedBytes: number;
  declaredSize?: number;
  /** Name of the request being run for its outputs (`acquiring-token` only). */
  tokenSource?: string;
}

export interface ResponseOperationErrorV2 {
  kind: RequestErrorKind;
  code: string | null;
  message: string;
  retryable: boolean;
}

export type ResponseResultV2 =
  | { version: 2; operationId: Id; kind: 'response'; response: ResponseV2 }
  | { version: 2; operationId: Id; kind: 'download'; response: ResponseV2; download: DownloadMetadataV2 }
  | { version: 2; operationId: Id; kind: 'busy' }
  | { version: 2; operationId: Id; kind: 'cancelled' }
  | { version: 2; operationId: Id; kind: 'failed'; error: ResponseOperationErrorV2 };

export type ResponseOperationProgressV2 = ResponseProgressV2;
export type ResponseOperationResultV2 = ResponseResultV2;

// ─── Response file actions (Save As / open in editor) ─────────
/**
 * Wire payload for the renderer-triggered response body file actions.
 * `content` is the body text exactly as shown in the response viewer —
 * the full body for complete text previews, the captured prefix otherwise.
 */
export interface ResponseFileActionPayload {
  content: string;
  contentType: string | null;
  suggestedFileName?: string;
}

export type ResponseSaveAsResult =
  | { saved: true; path: string }
  | { saved: false; reason: 'cancelled' }
  | { saved: false; reason: 'failed'; message: string };

export type ResponseOpenExternalResult =
  | { opened: true; editor: 'notepad++' | 'default' }
  | { opened: false; message: string };

export type RequestErrorKind = 'transport' | 'certificate' | 'timeout' | 'cancelled' | 'interpolation' | 'body' | 'authentication';

export interface RequestError {
  kind: RequestErrorKind;
  message: string;
  rawMessage: string;
  code: string | null;
  url: string;
  retryable: boolean;
}

export type OAuthTokenStatusKind = 'unauthorized' | 'opening-browser' | 'waiting-for-sign-in' | 'exchanging-code' | 'refreshing' | 'ready' | 'expired' | 'cancelled' | 'failed';

export interface OAuthTokenStatus {
  bindingId: Id;
  kind: OAuthTokenStatusKind;
  /** Opaque identifier for the active interactive sign-in operation. */
  operationId?: string;
  expiresAt?: number;
  hasRefreshToken?: boolean;
  grantedScope?: string;
  message?: string;
  code?: string;
  callbackUri?: string;
  revision: number;
}

export interface OAuthBindingPayload {
  requestId: Id;
  requestUrl: string;
  environmentId?: Id;
  config: OAuth2Config;
  /** Used to cancel/clear an operation after the request binding changed. */
  operationId?: string;
}

// ─── Collection / Folder ───────────────────────────────────────
export type NodeType = 'request' | 'group';

export interface RequestGroup {
  id: Id;
  name: string;
  parentId?: Id;
  auth?: AuthConfig;
  scripts?: RequestScripts;
  children: Id[];
  createdAt: number;
  updatedAt: number;
}

export type RequestGroupNode = RequestGroup & { type: 'group' };

export interface CollectionNode {
  type: NodeType;
  id: Id;
  name: string;
  parentId?: Id;
  children?: Id[];
}

/** Native Restiprocity collection export file (`*.restiprocity.json`). */
export const COLLECTION_EXPORT_FORMAT = 'restiprocity.collection';
export const COLLECTION_EXPORT_VERSION = 1;

export interface CollectionExportBundle {
  format: typeof COLLECTION_EXPORT_FORMAT;
  version: typeof COLLECTION_EXPORT_VERSION;
  exportedAt: string;
  /** Top-level node IDs in display order; every other node is reachable through group `children`. */
  roots: Id[];
  groups: RequestGroup[];
  /** Requests without `lastResponse`: exports carry request definitions, not response data. */
  requests: Omit<Request, 'lastResponse'>[];
}

export type CollectionExportFileResult =
  | { saved: true; path: string; requests: number; groups: number }
  | { saved: false; reason: 'cancelled' }
  | { saved: false; reason: 'failed'; message: string };

/** What an import added; `warnings` lists what couldn't be carried over from another client's file. */
export interface CollectionImportSummary {
  requests: number;
  groups: number;
  environments: number;
  warnings: string[];
}

export type CollectionImportFileResult =
  | ({ imported: true } & CollectionImportSummary)
  | { imported: false; reason: 'cancelled' }
  | { imported: false; reason: 'failed'; message: string };

export interface CopyCurlPayload extends IpcRequestPayload {
  /** Set on the second request, after the user has accepted that the command contains secret values. */
  confirmSensitive?: boolean;
}

export type CurlExportResult =
  | { copied: true; warnings: string[] }
  | { copied: false; requiresConfirmation: true; message: string }
  | { copied: false; requiresConfirmation?: false; message: string };

export interface CollectionMoveRequestPayload {
  requestId: Id;
  targetParentId?: Id;
  targetIndex: number;
}

// ─── Environment ───────────────────────────────────────────────
export const CORE_ENVIRONMENT_ID = 'core';
export const CORE_ENVIRONMENT_NAME = 'Core';

export type EnvironmentVariableType = 'standard' | 'confidential' | 'secret';

/**
 * A Secret value as stored. Version 1 (written up to 0.3.1) holds the value alone. Version 2 holds the value
 * together with the environment and key it belongs to, and is read only there (`src/main/crypto/secretEnvelope.ts`).
 */
export type EncryptedSecretEnvelope =
  | { version: 1; cipher: string }
  | { version: 2; bound: string };

export interface EnvironmentVariable {
  key: string;
  value: string;
  type: EnvironmentVariableType;
  /** Present on disk when type === 'secret' and OS encryption has been applied. */
  encrypted?: EncryptedSecretEnvelope;
  /** Present when a legacy file had type: 'secret' with plaintext value before OS migration. */
  legacyUnencrypted?: boolean;
  /** Sent by the editor on save only, for a renamed row: the key it is stored under. Never written to disk. */
  originalKey?: string;
  /**
   * Sent by the editor on save only, after the user confirmed it: the stored value may be saved under a less
   * protected type. Without it a masked value is never written or returned as plain text. Never written to disk.
   */
  lowerProtection?: boolean;
}

/** How strongly each variable type protects its value. A save that lowers it for a stored value must say so. */
export const VARIABLE_PROTECTION: Record<EnvironmentVariableType, number> = { standard: 0, confidential: 1, secret: 2 };

export interface SafeStorageStatus {
  available: boolean;
  backend: string;
  warning?: string;
}

export interface EnvRevealSecretPayload {
  environmentId: Id;
  key: string;
}

export interface EnvMigrateSecretsPayload {
  environmentId: Id;
  /** Convert only this legacy value. Omit to convert every legacy value in the environment. */
  key?: string;
}

export interface EnvMigrateSecretsResult {
  migratedCount: number;
  failedCount: number;
  errors: string[];
}

export interface Environment {
  id: Id;
  name: string;
  parentId?: Id;
  variables: EnvironmentVariable[];
  createdAt: number;
  updatedAt: number;
}

export type EnvironmentCreateData = Omit<Environment, 'id' | 'createdAt' | 'updatedAt'>
  & Partial<Pick<Environment, 'id' | 'createdAt' | 'updatedAt'>>;

// ─── History ───────────────────────────────────────────────────
export interface HistoryEntry {
  id: Id;
  requestId: Id;
  requestName: string;
  method: HttpMethod;
  url: string;
  status: number;
  timestamp: number;
  duration: number;
  size: number;
}

export type HistoryDetail = HistoryEntry & Omit<PersistedResponseV2, 'id' | 'requestId' | 'status' | 'timestamp' | 'size'> & {
  id: Id;
  requestId: Id;
  status: number;
  timestamp: number;
  size: number;
};

/** Shown for history saved before v0.3.0 stored the request's method and URL; those entries cannot be reopened, so no retry is offered. */
export const LEGACY_HISTORY_ENTRY_MESSAGE = "This entry was saved by an older version and can't be reopened.";

export type HistoryDetailErrorPayload =
  | { code: 'invalid-history-entry'; message: string; retryable: true }
  | { code: 'legacy-history-entry'; message: typeof LEGACY_HISTORY_ENTRY_MESSAGE; retryable: false };

// ─── IPC Types ─────────────────────────────────────────────────
export interface IpcRequestPayload {
  request: Request;
  environmentId?: Id;
}

export interface UpdateDownloadProgress {
  bytesPerSecond: number;
  percent: number;
  total: number;
  transferred: number;
}

export type UpdateStatus =
  | { kind: 'unsupported'; currentVersion: string }
  | { kind: 'idle'; currentVersion: string }
  | { kind: 'checking'; currentVersion: string }
  | { kind: 'no-update'; currentVersion: string; latestVersion: string }
  | { kind: 'available'; currentVersion: string; latestVersion: string }
  | { kind: 'downloading'; currentVersion: string; latestVersion: string; progress: UpdateDownloadProgress }
  | { kind: 'downloaded'; currentVersion: string; latestVersion: string }
  | { kind: 'installing'; currentVersion: string; latestVersion: string }
  | {
      kind: 'error';
      currentVersion: string;
      stage: 'check' | 'download' | 'install';
      message: string;
      retryable: boolean;
    };

// ─── App Settings ──────────────────────────────────────────────
export interface AppSettings {
  activeEnvironmentId?: Id;
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  fontFamily: string;
  defaultTimeout: number;
  defaultFollowRedirect: boolean;
  autoSaveHistory: boolean;
  maxHistorySize: number;
}
