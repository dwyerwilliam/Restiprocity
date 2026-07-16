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

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
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
  cookiesEnabled: boolean;
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
  lastResponse?: Response;
  parentId?: Id;
  createdAt: number;
  updatedAt: number;
}

// ─── Scripts ───────────────────────────────────────────────────
export interface RequestScripts {
  preRequest?: string;
  afterResponse?: string;
}

// ─── Response ──────────────────────────────────────────────────
export interface ResponseTiming {
  dns: number;
  tcp: number;
  tls: number;
  ttfb: number;
  download: number;
  total: number;
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

export type RequestErrorKind = 'transport' | 'certificate' | 'timeout' | 'cancelled';

export interface RequestError {
  kind: RequestErrorKind;
  message: string;
  rawMessage: string;
  code: string | null;
  url: string;
  retryable: boolean;
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

export interface CollectionNode {
  type: NodeType;
  id: Id;
  name: string;
  parentId?: Id;
  children?: Id[];
}

// ─── Environment ───────────────────────────────────────────────
export const CORE_ENVIRONMENT_ID = 'core';
export const CORE_ENVIRONMENT_NAME = 'Core';

export interface EnvironmentVariable {
  key: string;
  value: string;
  type: 'standard' | 'secret';
}

export interface Environment {
  id: Id;
  name: string;
  parentId?: Id;
  variables: EnvironmentVariable[];
  createdAt: number;
  updatedAt: number;
}

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

// ─── IPC Types ─────────────────────────────────────────────────
export interface IpcRequestPayload {
  request: Request;
  environmentId?: Id;
}

export interface IpcResponsePayload {
  success: boolean;
  response?: Response;
  error?: RequestError;
}

// ─── App Settings ──────────────────────────────────────────────
export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  fontFamily: string;
  defaultTimeout: number;
  defaultFollowRedirect: boolean;
  autoSaveHistory: boolean;
  maxHistorySize: number;
}
