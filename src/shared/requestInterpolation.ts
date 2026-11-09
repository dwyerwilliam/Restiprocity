import type { AuthConfig, OAuth2Config, Request } from './types';
import type { VariableContext } from './variableContext';
import { isActiveMultipart, isMultipartManagedHeader } from './multipartPolicy';

export interface RequestInterpolationOptions {
  operation?: 'send' | 'curl';
  hasOAuthToken?: (config: OAuth2Config) => boolean;
}

/** Shared URL selection for sending, cURL, and preview sensitivity. */
export function resolveUrlFields(request: Pick<Request, 'url' | 'parameters' | 'auth'>, context: VariableContext) {
  const url = context.resolve(request.url);
  let sensitive = url.sensitive;
  const parameters = request.parameters.map(row => {
    if (!row.enabled) return row;
    const key = context.resolve(row.key);
    if (!key.value.trim()) return { ...row, key: key.value };
    const value = context.resolve(row.value);
    sensitive ||= key.sensitive || value.sensitive;
    return { ...row, key: key.value, value: value.value };
  });
  const auth: AuthConfig = { type: 'none' };
  if (request.auth.type === 'api_key' && request.auth.api_key?.in === 'query') {
    const api = request.auth.api_key;
    const key = context.resolve(api.key);
    const value = key.value.trim() && api.value ? context.resolve(api.value) : undefined;
    auth.type = 'api_key';
    auth.api_key = { ...api, key: key.value, value: value?.value ?? '' };
    if (value?.value) sensitive ||= key.sensitive || value.sensitive;
  }
  return { url: url.value, parameters, auth, sensitive };
}

/** Select consumed fields without changing persisted requests or drafts. */
export function resolveRequestFields(request: Request, context: VariableContext, options: RequestInterpolationOptions = {}): Request {
  const str = context.interpolateString;
  const urlFields = resolveUrlFields(request, context);
  const auth = { ...request.auth };
  let authHeader: string | undefined;
  switch (auth.type) {
    case 'bearer':
      if (auth.bearer) {
        const token = str(auth.bearer.token);
        auth.bearer = { ...auth.bearer, token, prefix: token ? str(auth.bearer.prefix ?? '') : auth.bearer.prefix };
        if (token) authHeader = 'authorization';
      }
      break;
    case 'basic':
      if (auth.basic && auth.basic.username && auth.basic.password) {
        const username = str(auth.basic.username);
        const password = username ? str(auth.basic.password) : auth.basic.password;
        auth.basic = { username, password };
        if (username && password) authHeader = 'authorization';
      }
      break;
    case 'api_key':
      if (auth.api_key?.in === 'query') auth.api_key = urlFields.auth.api_key;
      else if (auth.api_key) {
        const key = str(auth.api_key.key);
        const managed = isActiveMultipart(request) && isMultipartManagedHeader(key);
        const value = key && !managed && auth.api_key.value ? str(auth.api_key.value) : '';
        auth.api_key = { ...auth.api_key, key, value };
        if (key && value) authHeader = key.toLowerCase();
      }
      break;
    case 'oauth2':
      if (auth.oauth2) {
        const oauth = auth.oauth2;
        const resolveParameters = (rows: typeof oauth.authorizationParameters | undefined) => rows?.map(row => row.enabled
          ? { ...row, key: str(row.key), value: str(row.value) }
          : row);
        const browserGrant = oauth.grantType === 'authorization_code' || oauth.grantType === 'pkce';
        const clientAuthentication = oauth.clientAuthentication ?? (oauth.grantType === 'client_credentials' ? 'body' : (oauth.clientSecret ? 'body' : 'none'));
        auth.oauth2 = {
          ...oauth,
          authorizationUrl: browserGrant ? str(oauth.authorizationUrl ?? '') : oauth.authorizationUrl,
          tokenUrl: str(oauth.tokenUrl ?? ''),
          clientId: str(oauth.clientId ?? ''),
          clientSecret: clientAuthentication === 'none' ? oauth.clientSecret : str(oauth.clientSecret ?? ''),
          scope: str(oauth.scope ?? ''),
          redirectUri: browserGrant ? str(oauth.redirectUri ?? '') : oauth.redirectUri,
          expectedIssuer: oauth.expectedIssuer === undefined ? undefined : str(oauth.expectedIssuer),
          authorizationParameters: resolveParameters(oauth.authorizationParameters),
          tokenParameters: resolveParameters(oauth.tokenParameters),
        };
        if (options.operation !== 'curl' || options.hasOAuthToken?.(auth.oauth2)) authHeader = 'authorization';
      }
      break;    case 'ntlm':
      if (auth.ntlm?.useCurrentAuthContext === false) {
        const username = str(auth.ntlm.username ?? '');
        auth.ntlm = { ...auth.ntlm, username };
        if (username || options.operation === 'curl') {
          auth.ntlm.domain = str(auth.ntlm.domain ?? '');
          auth.ntlm.password = str(auth.ntlm.password ?? '');
        }
      }
      break;
  }
  // Header names determine precedence; only the final values reach transport.
  const winners = new Map<string, Request['headers'][number]>();
  for (const row of request.headers) {
    if (!row.enabled) continue;
    const key = str(row.key);
    if (key) winners.set(key.toLowerCase(), { ...row, key });
  }
  winners.delete('user-agent');
  if (authHeader) winners.delete(authHeader);
  // The multipart transport will generate these headers; their values are unused.
  if (isActiveMultipart(request)) {
    for (const key of winners.keys()) if (isMultipartManagedHeader(key)) winners.delete(key);
  }
  const headers = [...winners.values()].map(row => ({ ...row, value: str(row.value) }));
  const body = { ...request.body };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (body.type === 'raw' && body.raw) body.raw = { ...body.raw, content: str(body.raw.content) };
    if (body.type === 'form-urlencoded' && body.form) body.form = body.form.map(row => row.enabled ? { ...row, key: str(row.key), value: str(row.value) } : row);
    if (body.type === 'multipart' && body.multipart) body.multipart = body.multipart.map(row => {
      if (!row.enabled) return row;
      const key = str(row.key);
      if (!key) return { ...row, key };
      if (row.type === 'file') {
        const filePath = row.filePath ? str(row.filePath) : row.filePath;
        return { ...row, key, filePath, value: filePath ? row.value : str(row.value) };
      }
      return { ...row, key, value: str(row.value) };
    });
  }
  return { ...request, url: urlFields.url, headers, parameters: urlFields.parameters, body, auth, settings: { ...request.settings, userAgent: request.settings.userAgent === undefined ? undefined : str(request.settings.userAgent) } };
}

