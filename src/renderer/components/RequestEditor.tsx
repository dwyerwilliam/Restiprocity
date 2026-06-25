import React, { useState, useCallback } from 'react';
import { useRequestStore } from '../stores';
import { HttpMethod, Header, QueryParameter, BodyType, AuthType, Response } from '../../shared/types';

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

export function RequestEditor() {
  const { currentRequest, updateRequest, isSending, setIsSending, setSendError, setCurrentResponse } = useRequestStore();
  const [activeTab, setActiveTab] = useState<'headers' | 'params' | 'body' | 'auth' | 'settings'>('headers');

  const handleSend = useCallback(async () => {
    if (!currentRequest) return;
    setIsSending(true);
    try {
      const result = await window.api.sendRequest({ request: currentRequest });
      if (result.success && result.response) {
        setCurrentResponse(result.response as unknown as Response);
      } else {
        setSendError(result.error || 'Request failed');
      }
    } catch (err: any) {
      setSendError(err.message);
    }
  }, [currentRequest, setIsSending, setSendError, setCurrentResponse]);

  const tabs = [
    { id: 'headers' as const, label: 'Headers' },
    { id: 'params' as const, label: 'Params' },
    { id: 'body' as const, label: 'Body' },
    { id: 'auth' as const, label: 'Auth' },
    { id: 'settings' as const, label: 'Settings' },
  ];

  return (
    <div className="flex flex-col bg-[var(--color-surface)] border-b border-[var(--color-border)]" style={{ height: '50%' }}>
      {/* URL Bar */}
      <div className="flex items-center gap-2 p-3">
        <select
          className="px-2 py-1.5 text-xs font-bold bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]"
          value={currentRequest?.method || 'GET'}
          onChange={e => updateRequest({ method: e.target.value as HttpMethod })}
          style={{ color: METHOD_COLORS[(currentRequest?.method || 'GET') as HttpMethod] }}
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="flex-1 px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]"
          placeholder="Enter request URL"
          value={currentRequest?.url || ''}
          onChange={e => updateRequest({ url: e.target.value })}
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
        {activeTab === 'headers' && <KeyValueEditor items={currentRequest?.headers || []} onChange={h => updateRequest({ headers: h })} label="Headers" />}
        {activeTab === 'params' && <KeyValueEditor items={currentRequest?.parameters || []} onChange={p => updateRequest({ parameters: p })} label="Query Parameters" />}
        {activeTab === 'body' && <BodyEditor request={currentRequest} onUpdate={updateRequest} />}
        {activeTab === 'auth' && <AuthEditor request={currentRequest} onUpdate={updateRequest} />}
        {activeTab === 'settings' && <SettingsEditor request={currentRequest} onUpdate={updateRequest} />}
      </div>
    </div>
  );
}

function BodyEditor({ request, onUpdate }: { request: any; onUpdate: (u: any) => void }) {
  const [bodyType, setBodyType] = useState<BodyType>(request?.body?.type || 'none');
  const [rawContent, setRawContent] = useState(request?.body?.raw?.content || '');
  const [rawLang, setRawLang] = useState(request?.body?.raw?.language || 'json');

  return (
    <div className="p-4">
      <div className="flex gap-2 mb-3">
        {(['none', 'raw', 'form-urlencoded', 'multipart'] as BodyType[]).map(t => (
          <button key={t} onClick={() => { setBodyType(t); onUpdate({ body: { ...request?.body, type: t } }); }}
            className={`px-3 py-1 text-xs rounded ${bodyType === t ? 'bg-[var(--color-primary)] text-[var(--color-bg)]' : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {t === 'none' ? 'None' : t === 'raw' ? 'Raw' : t === 'form-urlencoded' ? 'Form URL' : 'Multipart'}
          </button>
        ))}
      </div>
      {bodyType === 'raw' && (
        <>
          <select className="mb-2 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={rawLang} onChange={e => setRawLang(e.target.value)}>
            <option value="json">JSON</option><option value="xml">XML</option><option value="text">Text</option><option value="html">HTML</option>
          </select>
          <textarea className="w-full h-48 px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] resize-none" value={rawContent} onChange={e => { setRawContent(e.target.value); onUpdate({ body: { ...request?.body, type: 'raw', raw: { language: rawLang, content: e.target.value } } }); }} />
        </>
      )}
      {bodyType === 'none' && <p className="text-xs text-[var(--color-text-muted)]">No body for this request.</p>}
    </div>
  );
}

function AuthEditor({ request, onUpdate }: { request: any; onUpdate: (u: any) => void }) {
  const [authType, setAuthType] = useState<AuthType>(request?.auth?.type || 'none');
  const [bearerToken, setBearerToken] = useState(request?.auth?.bearer?.token || '');
  const [apiKeyKey, setApiKeyKey] = useState(request?.auth?.api_key?.key || '');
  const [apiKeyValue, setApiKeyValue] = useState(request?.auth?.api_key?.value || '');
  const [basicUser, setBasicUser] = useState(request?.auth?.basic?.username || '');
  const [basicPass, setBasicPass] = useState(request?.auth?.basic?.password || '');

  const updateAuth = (type: AuthType, data: any) => {
    setAuthType(type);
    onUpdate({ auth: { type, ...data } });
  };

  return (
    <div className="p-4">
      <select className="mb-4 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={authType} onChange={e => setAuthType(e.target.value as AuthType)}>
        <option value="none">None</option><option value="bearer">Bearer Token</option><option value="api_key">API Key</option><option value="basic">Basic Auth</option>
      </select>
      {authType === 'bearer' && <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Token" value={bearerToken} onChange={e => { setBearerToken(e.target.value); updateAuth('bearer', { bearer: { token: e.target.value, prefix: 'Bearer' } }); }} />}
      {authType === 'api_key' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key header name" value={apiKeyKey} onChange={e => setApiKeyKey(e.target.value)} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={apiKeyValue} onChange={e => { setApiKeyValue(e.target.value); updateAuth('api_key', { api_key: { key: apiKeyKey, value: e.target.value, in: 'header' } }); }} />
      </>)}
      {authType === 'basic' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={basicUser} onChange={e => setBasicUser(e.target.value)} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={basicPass} onChange={e => { setBasicPass(e.target.value); updateAuth('basic', { basic: { username: basicUser, password: e.target.value } }); }} />
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
