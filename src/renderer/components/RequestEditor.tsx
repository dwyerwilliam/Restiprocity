import React, { useState, useCallback, useEffect } from 'react';
import { useRequestStore } from '../stores';
import { HttpMethod, Header, QueryParameter, BodyType, AuthType, Response, Request, FormField, MultipartField, RawBodyLanguage, AuthConfig, OAuth2GrantType } from '../../shared/types';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: 'var(--color-success)', POST: 'var(--color-primary)', PUT: 'var(--color-warning)',
  PATCH: 'var(--color-accent)', DELETE: 'var(--color-error)', HEAD: 'var(--color-text-muted)',
  OPTIONS: 'var(--color-text-muted)',
};

function KeyValueEditor({ items, onChange, label }: {
  items: (Header | QueryParameter)[]; onChange: (items: (Header | QueryParameter)[]) => void; label: string;
}) {
  const addRow = () => onChange([...items, { key: '', value: '', enabled: true }]);
  const removeRow = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: string, val: string | boolean) =>
    onChange(items.map((item, idx) => idx === i ? { ...item, [field]: val } : item));

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
        <button onClick={addRow} className="text-xs text-[var(--color-primary)] hover:underline">+ Add</button>
      </div>
      {items.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">No {label.toLowerCase()} defined.</p>}
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 mb-2">
          <input type="checkbox" checked={item.enabled} onChange={e => updateRow(i, 'enabled', e.target.checked)} className="accent-[var(--color-primary)]" />
          <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key" value={item.key} onChange={e => updateRow(i, 'key', e.target.value)} />
          <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={item.value} onChange={e => updateRow(i, 'value', e.target.value)} />
          <button onClick={() => removeRow(i)} className="text-[var(--color-error)] text-xs hover:underline">✕</button>
        </div>
      ))}
    </div>
  );
}

export function RequestEditor({ heightPercent = 50 }: { heightPercent?: number }) {
  const { currentRequest, updateRequest, isSending, setIsSending, setSendError, setCurrentResponse } = useRequestStore();
  const [activeTab, setActiveTab] = useState<'headers' | 'params' | 'body' | 'auth' | 'settings'>('headers');

  const saveRequest = useCallback((request: Request | null) => {
    if (!request) return;

    void window.api.collectionUpdate(request.id, {
      ...request,
      nodeType: 'request',
    }).catch((error) => {
      console.error('Failed to save request:', error);
    });
  }, []);

  const updateAndSaveRequest = useCallback((updates: Partial<Request>) => {
    updateRequest(updates);

    if (!currentRequest) return;

    saveRequest({ ...currentRequest, ...updates, updatedAt: Date.now() });
  }, [currentRequest, saveRequest, updateRequest]);

  const handleSend = useCallback(async () => {
    if (!currentRequest) return;
    const sentRequest = currentRequest;
    setIsSending(true);
    try {
      const result = await window.api.sendRequest({ request: sentRequest });
      if (result.success && result.response) {
        const latestRequest = useRequestStore.getState().currentRequest;
        if (latestRequest?.id === sentRequest.id) {
          setCurrentResponse(result.response as unknown as Response);
          updateRequest({ lastResponse: result.response });
        }
        saveRequest({ ...sentRequest, lastResponse: result.response, updatedAt: Date.now() });
      } else {
        setSendError(result.error || 'Request failed');
      }
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setIsSending(false);
    }
  }, [currentRequest, saveRequest, setIsSending, setSendError, setCurrentResponse, updateRequest]);

  const tabs = [
    { id: 'headers' as const, label: 'Headers' },
    { id: 'params' as const, label: 'Params' },
    { id: 'body' as const, label: 'Body' },
    { id: 'auth' as const, label: 'Auth' },
    { id: 'settings' as const, label: 'Settings' },
  ];

  return (
    <div className="flex flex-col bg-[var(--color-surface)]" style={{ height: `${heightPercent}%` }}>
      {/* URL Bar */}
      <div className="flex items-center gap-2 p-3">
        <select
          className="px-2 py-1.5 text-xs font-bold bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]"
          value={currentRequest?.method || 'GET'}
          onChange={e => updateAndSaveRequest({ method: e.target.value as HttpMethod })}
          style={{ color: METHOD_COLORS[(currentRequest?.method || 'GET') as HttpMethod] }}
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="flex-1 px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]"
          placeholder="Enter request URL"
          value={currentRequest?.url || ''}
          onChange={e => updateRequest({ url: e.target.value })}
          onBlur={() => saveRequest(currentRequest)}
        />
        <button
          onClick={handleSend}
          disabled={isSending}
          className="px-4 py-1.5 text-xs font-semibold bg-[var(--color-primary)] text-[var(--color-bg)] rounded hover:opacity-80 disabled:opacity-50"
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-border)]">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs border-b-2 transition-colors ${activeTab === tab.id ? 'border-[var(--color-primary)] text-[var(--color-primary)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'headers' && <KeyValueEditor items={currentRequest?.headers || []} onChange={h => updateAndSaveRequest({ headers: h })} label="Headers" />}
        {activeTab === 'params' && <KeyValueEditor items={currentRequest?.parameters || []} onChange={p => updateAndSaveRequest({ parameters: p })} label="Query Parameters" />}
        {activeTab === 'body' && <BodyEditor request={currentRequest} onUpdate={updateAndSaveRequest} />}
        {activeTab === 'auth' && <AuthEditor request={currentRequest} onUpdate={updateAndSaveRequest} />}
        {activeTab === 'settings' && <SettingsEditor request={currentRequest} onUpdate={updateAndSaveRequest} />}
      </div>
    </div>
  );
}

function BodyEditor({ request, onUpdate }: { request: Request | null; onUpdate: (u: Partial<Request>) => void }) {
  const [bodyType, setBodyType] = useState<BodyType>(request?.body?.type || 'none');
  const [rawContent, setRawContent] = useState(request?.body?.raw?.content || '');
  const [rawLang, setRawLang] = useState(request?.body?.raw?.language || 'json');
  const [formFields, setFormFields] = useState<FormField[]>(request?.body?.form ?? []);
  const [multipartFields, setMultipartFields] = useState<MultipartField[]>(request?.body?.multipart ?? []);

  useEffect(() => {
    setBodyType(request?.body?.type || 'none');
    setRawContent(request?.body?.raw?.content || '');
    setRawLang(request?.body?.raw?.language || 'json');
    setFormFields(request?.body?.form ?? []);
    setMultipartFields(request?.body?.multipart ?? []);
  }, [request?.id, request?.body]);

  const switchBodyType = (type: BodyType) => {
    if (type === bodyType) return;

    setBodyType(type);

    if (type === 'raw') {
      onUpdate({ body: { type, raw: { language: rawLang, content: rawContent } } });
    } else if (type === 'form-urlencoded') {
      onUpdate({ body: { type, form: formFields } });
    } else if (type === 'multipart') {
      onUpdate({ body: { type, multipart: multipartFields } });
    } else {
      onUpdate({ body: { type } });
    }
  };

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-3">
        {(['none', 'raw', 'form-urlencoded', 'multipart'] as BodyType[]).map(t => (
          <button key={t} onClick={() => switchBodyType(t)}
            className={`px-3 py-1 text-xs rounded ${bodyType === t ? 'bg-[var(--color-primary)] text-[var(--color-bg)]' : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {t === 'none' ? 'None' : t === 'raw' ? 'Raw' : t === 'form-urlencoded' ? 'Form URL' : 'Multipart'}
          </button>
        ))}
      </div>
      {bodyType === 'raw' && (
        <>
          <select className="mb-2 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={rawLang} onChange={e => {
            const language = e.target.value as RawBodyLanguage;
            setRawLang(language);
            onUpdate({ body: { type: 'raw', raw: { language, content: rawContent } } });
          }}>
            <option value="json">JSON</option><option value="xml">XML</option><option value="text">Text</option><option value="html">HTML</option>
          </select>
          <textarea className="w-full h-48 px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] resize-none" value={rawContent} onChange={e => { setRawContent(e.target.value); onUpdate({ body: { type: 'raw', raw: { language: rawLang, content: e.target.value } } }); }} />
        </>
      )}
      {bodyType === 'none' && <p className="text-xs text-[var(--color-text-muted)]">No body for this request.</p>}
      {bodyType === 'form-urlencoded' && (
        <FormFieldsEditor fields={formFields} onChange={fields => {
          setFormFields(fields);
          onUpdate({ body: { type: 'form-urlencoded', form: fields } });
        }} />
      )}
      {bodyType === 'multipart' && (
        <MultipartFieldsEditor fields={multipartFields} onChange={fields => {
          setMultipartFields(fields);
          onUpdate({ body: { type: 'multipart', multipart: fields } });
        }} />
      )}
    </div>
  );
}

function FormFieldsEditor({ fields, onChange }: { fields: FormField[]; onChange: (fields: FormField[]) => void }) {
  const addRow = () => onChange([...fields, { key: '', value: '', enabled: true }]);
  const removeRow = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: keyof FormField, val: string | boolean) =>
    onChange(fields.map((item, idx) => idx === i ? { ...item, [field]: val } : item));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[var(--color-text-muted)]">Form URL-Encoded</span>
        <button onClick={addRow} className="text-xs text-[var(--color-primary)] hover:underline">+ Add</button>
      </div>
      {fields.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">No form fields defined.</p>}
      {fields.map((item, i) => (
        <div key={i} className="flex items-center gap-2 mb-2">
          <input type="checkbox" checked={item.enabled} onChange={e => updateRow(i, 'enabled', e.target.checked)} className="accent-[var(--color-primary)]" />
          <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key" value={item.key} onChange={e => updateRow(i, 'key', e.target.value)} />
          <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={item.value} onChange={e => updateRow(i, 'value', e.target.value)} />
          <button onClick={() => removeRow(i)} className="text-[var(--color-error)] text-xs hover:underline">✕</button>
        </div>
      ))}
    </div>
  );
}

function MultipartFieldsEditor({ fields, onChange }: { fields: MultipartField[]; onChange: (fields: MultipartField[]) => void }) {
  const addRow = () => onChange([...fields, { key: '', type: 'text', value: '', enabled: true }]);
  const removeRow = (i: number) => onChange(fields.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: keyof MultipartField, val: string | boolean) =>
    onChange(fields.map((item, idx) => idx === i ? { ...item, [field]: val } : item));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[var(--color-text-muted)]">Multipart</span>
        <button onClick={addRow} className="text-xs text-[var(--color-primary)] hover:underline">+ Add</button>
      </div>
      {fields.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">No multipart fields defined.</p>}
      {fields.map((item, i) => (
        <div key={i} className="mb-2">
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={item.enabled} onChange={e => updateRow(i, 'enabled', e.target.checked)} className="accent-[var(--color-primary)]" />
            <select className="w-20 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={item.type} onChange={e => updateRow(i, 'type', e.target.value as 'text' | 'file')}>
              <option value="text">Text</option>
              <option value="file">File</option>
            </select>
            <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key" value={item.key} onChange={e => updateRow(i, 'key', e.target.value)} />
            {item.type === 'text' ? (
              <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={item.value} onChange={e => updateRow(i, 'value', e.target.value)} />
            ) : (
              <input className="flex-1 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="File path" value={item.filePath || ''} onChange={e => updateRow(i, 'filePath', e.target.value)} />
            )}
            <button onClick={() => removeRow(i)} className="text-[var(--color-error)] text-xs hover:underline">✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AuthEditor({ request, onUpdate }: { request: Request | null; onUpdate: (u: Partial<Request>) => void }) {
  const [authType, setAuthType] = useState<AuthType>(request?.auth?.type || 'none');
  const [bearerToken, setBearerToken] = useState(request?.auth?.bearer?.token || '');
  const [bearerPrefix, setBearerPrefix] = useState(request?.auth?.bearer?.prefix || 'Bearer');
  const [apiKeyKey, setApiKeyKey] = useState(request?.auth?.api_key?.key || '');
  const [apiKeyValue, setApiKeyValue] = useState(request?.auth?.api_key?.value || '');
  const [apiKeyIn, setApiKeyIn] = useState<'header' | 'query'>(request?.auth?.api_key?.in || 'header');
  const [basicUser, setBasicUser] = useState(request?.auth?.basic?.username || '');
  const [basicPass, setBasicPass] = useState(request?.auth?.basic?.password || '');
  const [oauthGrantType, setOauthGrantType] = useState<OAuth2GrantType>(request?.auth?.oauth2?.grantType || 'client_credentials');
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState(request?.auth?.oauth2?.authorizationUrl || '');
  const [oauthTokenUrl, setOauthTokenUrl] = useState(request?.auth?.oauth2?.tokenUrl || '');
  const [oauthClientId, setOauthClientId] = useState(request?.auth?.oauth2?.clientId || '');
  const [oauthClientSecret, setOauthClientSecret] = useState(request?.auth?.oauth2?.clientSecret || '');
  const [oauthScope, setOauthScope] = useState(request?.auth?.oauth2?.scope || '');
  const [oauthRedirectUri, setOauthRedirectUri] = useState(request?.auth?.oauth2?.redirectUri || '');
  const [ntlmUser, setNtlmUser] = useState(request?.auth?.ntlm?.username || '');
  const [ntlmPassword, setNtlmPassword] = useState(request?.auth?.ntlm?.password || '');
  const [ntlmDomain, setNtlmDomain] = useState(request?.auth?.ntlm?.domain || '');
  const [ntlmWorkstation, setNtlmWorkstation] = useState(request?.auth?.ntlm?.workstation || '');

  useEffect(() => {
    setAuthType(request?.auth?.type || 'none');
    setBearerToken(request?.auth?.bearer?.token || '');
    setBearerPrefix(request?.auth?.bearer?.prefix || 'Bearer');
    setApiKeyKey(request?.auth?.api_key?.key || '');
    setApiKeyValue(request?.auth?.api_key?.value || '');
    setApiKeyIn(request?.auth?.api_key?.in || 'header');
    setBasicUser(request?.auth?.basic?.username || '');
    setBasicPass(request?.auth?.basic?.password || '');
    setOauthGrantType(request?.auth?.oauth2?.grantType || 'client_credentials');
    setOauthAuthorizationUrl(request?.auth?.oauth2?.authorizationUrl || '');
    setOauthTokenUrl(request?.auth?.oauth2?.tokenUrl || '');
    setOauthClientId(request?.auth?.oauth2?.clientId || '');
    setOauthClientSecret(request?.auth?.oauth2?.clientSecret || '');
    setOauthScope(request?.auth?.oauth2?.scope || '');
    setOauthRedirectUri(request?.auth?.oauth2?.redirectUri || '');
    setNtlmUser(request?.auth?.ntlm?.username || '');
    setNtlmPassword(request?.auth?.ntlm?.password || '');
    setNtlmDomain(request?.auth?.ntlm?.domain || '');
    setNtlmWorkstation(request?.auth?.ntlm?.workstation || '');
  }, [request?.id, request?.auth]);

  const buildAuth = (
    type: AuthType,
    overrides: Partial<{
      bearerToken: string;
      bearerPrefix: string;
      apiKeyKey: string;
      apiKeyValue: string;
      apiKeyIn: 'header' | 'query';
      basicUser: string;
      basicPass: string;
      oauthGrantType: OAuth2GrantType;
      oauthAuthorizationUrl: string;
      oauthTokenUrl: string;
      oauthClientId: string;
      oauthClientSecret: string;
      oauthScope: string;
      oauthRedirectUri: string;
      ntlmUser: string;
      ntlmPassword: string;
      ntlmDomain: string;
      ntlmWorkstation: string;
    }> = {},
  ): AuthConfig => {
    const values = {
      bearerToken,
      bearerPrefix,
      apiKeyKey,
      apiKeyValue,
      apiKeyIn,
      basicUser,
      basicPass,
      oauthGrantType,
      oauthAuthorizationUrl,
      oauthTokenUrl,
      oauthClientId,
      oauthClientSecret,
      oauthScope,
      oauthRedirectUri,
      ntlmUser,
      ntlmPassword,
      ntlmDomain,
      ntlmWorkstation,
      ...overrides,
    };

    switch (type) {
      case 'bearer':
        return { type, bearer: { token: values.bearerToken, prefix: values.bearerPrefix || 'Bearer' } };
      case 'api_key':
        return { type, api_key: { key: values.apiKeyKey, value: values.apiKeyValue, in: values.apiKeyIn } };
      case 'basic':
        return { type, basic: { username: values.basicUser, password: values.basicPass } };
      case 'oauth2':
        return {
          type,
          oauth2: {
            grantType: values.oauthGrantType,
            authorizationUrl: values.oauthAuthorizationUrl,
            tokenUrl: values.oauthTokenUrl,
            clientId: values.oauthClientId,
            clientSecret: values.oauthClientSecret,
            scope: values.oauthScope,
            redirectUri: values.oauthRedirectUri,
          },
        };
      case 'ntlm':
        return {
          type,
          ntlm: {
            username: values.ntlmUser,
            password: values.ntlmPassword,
            domain: values.ntlmDomain || undefined,
            workstation: values.ntlmWorkstation || undefined,
          },
        };
      default:
        return { type: 'none' };
    }
  };

  const persistAuth = (type: AuthType) => {
    setAuthType(type);
    onUpdate({ auth: buildAuth(type) });
  };

  return (
    <div className="p-4">
      <select className="mb-4 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={authType} onChange={e => persistAuth(e.target.value as AuthType)}>
        <option value="none">None</option><option value="bearer">Bearer Token</option><option value="api_key">API Key</option><option value="basic">Basic Auth</option><option value="oauth2">OAuth 2.0</option><option value="ntlm">NTLM</option>
      </select>
      {authType === 'bearer' && <div className="space-y-2"><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Token" value={bearerToken} onChange={e => { const value = e.target.value; setBearerToken(value); onUpdate({ auth: buildAuth('bearer', { bearerToken: value }) }); }} /><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Prefix" value={bearerPrefix} onChange={e => { const value = e.target.value; setBearerPrefix(value); onUpdate({ auth: buildAuth('bearer', { bearerPrefix: value }) }); }} /></div>}
      {authType === 'api_key' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key header name" value={apiKeyKey} onChange={e => { const value = e.target.value; setApiKeyKey(value); onUpdate({ auth: buildAuth('api_key', { apiKeyKey: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={apiKeyValue} onChange={e => { const value = e.target.value; setApiKeyValue(value); onUpdate({ auth: buildAuth('api_key', { apiKeyValue: value }) }); }} />
        <select className="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={apiKeyIn} onChange={e => { const value = e.target.value as 'header' | 'query'; setApiKeyIn(value); onUpdate({ auth: buildAuth('api_key', { apiKeyIn: value }) }); }}>
          <option value="header">Header</option>
          <option value="query">Query</option>
        </select>
      </>)}
      {authType === 'basic' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={basicUser} onChange={e => { const value = e.target.value; setBasicUser(value); onUpdate({ auth: buildAuth('basic', { basicUser: value }) }); }} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={basicPass} onChange={e => { const value = e.target.value; setBasicPass(value); onUpdate({ auth: buildAuth('basic', { basicPass: value }) }); }} />
      </>)}
      {authType === 'oauth2' && (<>
        <div className="mb-2 text-xs text-[var(--color-text-muted)]">Current engine support: client credentials only.</div>
        <select className="w-full mb-2 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={oauthGrantType} onChange={e => { const value = e.target.value as OAuth2GrantType; setOauthGrantType(value); onUpdate({ auth: buildAuth('oauth2', { oauthGrantType: value }) }); }}>
          <option value="client_credentials">Client Credentials</option>
          <option value="authorization_code">Authorization Code</option>
          <option value="password">Password</option>
          <option value="pkce">PKCE</option>
        </select>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Token URL" value={oauthTokenUrl} onChange={e => { const value = e.target.value; setOauthTokenUrl(value); onUpdate({ auth: buildAuth('oauth2', { oauthTokenUrl: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Authorization URL" value={oauthAuthorizationUrl} onChange={e => { const value = e.target.value; setOauthAuthorizationUrl(value); onUpdate({ auth: buildAuth('oauth2', { oauthAuthorizationUrl: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Client ID" value={oauthClientId} onChange={e => { const value = e.target.value; setOauthClientId(value); onUpdate({ auth: buildAuth('oauth2', { oauthClientId: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Client Secret" type="password" value={oauthClientSecret} onChange={e => { const value = e.target.value; setOauthClientSecret(value); onUpdate({ auth: buildAuth('oauth2', { oauthClientSecret: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Scope" value={oauthScope} onChange={e => { const value = e.target.value; setOauthScope(value); onUpdate({ auth: buildAuth('oauth2', { oauthScope: value }) }); }} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Redirect URI" value={oauthRedirectUri} onChange={e => { const value = e.target.value; setOauthRedirectUri(value); onUpdate({ auth: buildAuth('oauth2', { oauthRedirectUri: value }) }); }} />
      </>)}
      {authType === 'ntlm' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={ntlmUser} onChange={e => { const value = e.target.value; setNtlmUser(value); onUpdate({ auth: buildAuth('ntlm', { ntlmUser: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Domain (optional)" value={ntlmDomain} onChange={e => { const value = e.target.value; setNtlmDomain(value); onUpdate({ auth: buildAuth('ntlm', { ntlmDomain: value }) }); }} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Workstation (optional)" value={ntlmWorkstation} onChange={e => { const value = e.target.value; setNtlmWorkstation(value); onUpdate({ auth: buildAuth('ntlm', { ntlmWorkstation: value }) }); }} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={ntlmPassword} onChange={e => { const value = e.target.value; setNtlmPassword(value); onUpdate({ auth: buildAuth('ntlm', { ntlmPassword: value }) }); }} />
      </>)}
    </div>
  );
}

function SettingsEditor({ request, onUpdate }: { request: any; onUpdate: (u: any) => void }) {
  if (!request) return null;
  return (
    <div className="p-4 space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={request.settings?.followRedirect ?? true} onChange={e => onUpdate({ settings: { ...request.settings, followRedirect: e.target.checked } })} className="accent-[var(--color-primary)]" /><span className="text-xs text-[var(--color-text)]">Follow Redirects</span></label>
      <div><span className="text-xs text-[var(--color-text-muted)] block mb-1">Timeout (ms)</span><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" type="number" value={request.settings?.timeout ?? 30000} onChange={e => onUpdate({ settings: { ...request.settings, timeout: Number(e.target.value) } })} /></div>
      <div><span className="text-xs text-[var(--color-text-muted)] block mb-1">User Agent</span><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={request.settings?.userAgent || ''} onChange={e => onUpdate({ settings: { ...request.settings, userAgent: e.target.value } })} /></div>
    </div>
  );
}
