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
  username: string;
  password: string;
  domain?: string;
  workstation?: string;
}

// ─── Request Settings ──────────────────────────────────────────
export interface RequestSettings {
  followRedirect: boolean;
  timeout: number;
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
  error?: string;
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
