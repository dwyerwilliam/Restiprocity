import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRequestStore, useEnvironmentStore } from '../stores';
import { tokenizeJson, tokenClass } from '../utils/jsonTokens';
import { HttpMethod, Header, QueryParameter, BodyType, AuthType, Response, Request, FormField, MultipartField, RawBodyLanguage, AuthConfig, OAuth2GrantType, Environment, CORE_ENVIRONMENT_ID } from '../../shared/types';
import { BUILT_IN_VARIABLE_KEYS, composeRequestUrl, expandUrlVariableShorthand, expandUrlVariableShorthandWithSelection, extractQueryParamsFromUrl, removeQueryFromUrl, removeQueryParamFromUrl } from '../../shared/urlVariables';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: 'var(--color-success)', POST: 'var(--color-primary)', PUT: 'var(--color-warning)',
  PATCH: 'var(--color-accent)', DELETE: 'var(--color-error)', HEAD: 'var(--color-text-muted)',
  OPTIONS: 'var(--color-text-muted)',
};

function collectActiveEnvironmentKeys(environments: Environment[], activeEnvironmentId: string | null): Set<string> {
  const keys = new Set<string>(BUILT_IN_VARIABLE_KEYS);
  const byId = new Map(environments.map(env => [env.id, env]));
  const seen = new Set<string>();

  const collect = (environmentId: string | undefined) => {
    if (!environmentId || seen.has(environmentId)) return;
    seen.add(environmentId);

    const environment = byId.get(environmentId);
    if (!environment) return;

    collect(environment.parentId);
    for (const variable of environment.variables) {
      keys.add(variable.key);
    }
  };

  collect(activeEnvironmentId ?? undefined);
  return keys;
}

function getSendEnvironmentId(): string | undefined {
  const { activeEnvironmentId, environments } = useEnvironmentStore.getState();
  return activeEnvironmentId
    ?? (environments.some(env => env.id === CORE_ENVIRONMENT_ID) ? CORE_ENVIRONMENT_ID : undefined);
}

function renderHighlightedInterpolations(text: string, interpolationClass = 'text-[var(--color-primary)]'): React.ReactNode {
  if (!text) return null;

  const nodes: React.ReactNode[] = [];
  const pattern = /\{\{[^{}]+\}\}/g;
  let lastIndex = 0;

  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>);
    }
    nodes.push(
      <span key={`var-${match.index}`} className={interpolationClass}>
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return nodes;
}

function moveQueryParamToParams(url: string, paramIndex: number, parameters: QueryParameter[], updateAndSave: (u: Partial<Request>) => void) {
  const result = removeQueryParamFromUrl(url, paramIndex);
  if (!result) return;

  updateAndSave({
    url: result.url,
    parameters: [...parameters, { key: result.param.key, value: result.param.value, enabled: true }],
  });
}

function renderUrlOverlay(url: string, urlVariableKeys: ReadonlySet<string>, parameters: QueryParameter[], updateAndSave: (u: Partial<Request>) => void): React.ReactNode {
  if (!url) return null;

  const queryParams = extractQueryParamsFromUrl(url);
  if (queryParams.length === 0) {
    return renderHighlightedInterpolations(url);
  }

  const baseUrl = removeQueryFromUrl(url);
  const nodes: React.ReactNode[] = [];

  // Separate hash fragment so it renders after query params, not before
  const hashIdx = baseUrl.indexOf('#');
  const baseWithoutHash = hashIdx >= 0 ? baseUrl.slice(0, hashIdx) : baseUrl;
  const hashFragment = hashIdx >= 0 ? baseUrl.slice(hashIdx) : '';

  const baseParts = renderHighlightedInterpolations(baseWithoutHash, 'text-[var(--color-text)]');
  if (Array.isArray(baseParts)) {
    nodes.push(...baseParts);
  }

  nodes.push(<span key="qs" className="text-[var(--color-text-muted)]">?</span>);

  queryParams.forEach((param, i) => {
    const isEven = i % 2 === 0;
    const bgClass = isEven ? 'bg-[var(--color-surface)]' : 'bg-[var(--color-surface-hover)]';

    nodes.push(
      <span key={`qp-${i}`} className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs font-mono ${bgClass}`}>
        <span>{renderHighlightedInterpolations(param.key, 'text-[var(--color-primary)]')}</span>
        <span className="text-[var(--color-text-muted)]">=</span>
        <span>{renderHighlightedInterpolations(param.value, 'text-[var(--color-primary)]')}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            moveQueryParamToParams(url, i, parameters, updateAndSave);
          }}
          className="ml-0.5 text-[var(--color-primary)] hover:text-[var(--color-accent)] leading-none pointer-events-auto"
          aria-label={`Move ${param.key} to Params tab`}
          title={`Move ${param.key} to Params tab`}
        >
          +
        </button>
      </span>,
    );

    if (i < queryParams.length - 1) {
      nodes.push(<span key={`qa-${i}`} className="text-[var(--color-text-muted)]">&amp;</span>);
    }
  });

  if (hashFragment) {
    nodes.push(<span key="hash">{renderHighlightedInterpolations(hashFragment, 'text-[var(--color-text)]')}</span>);
  }

  return nodes;
}

function InterpolatedTextInput({
  value,
  onChange,
  placeholder,
  knownKeys,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  knownKeys: ReadonlySet<string>;
  inputClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const nextValue = expandUrlVariableShorthandWithSelection(
      input.value,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      { knownKeys },
    );

    if (nextValue.value !== input.value) {
      input.value = nextValue.value;
      input.setSelectionRange(nextValue.selectionStart, nextValue.selectionEnd);
    }

    onChange(nextValue.value);
  }, [knownKeys, onChange]);

  return (
    <div className="relative">
      <div
        aria-hidden="true"
        className="absolute inset-0 px-2 py-1 text-xs leading-4 text-[var(--color-text)] pointer-events-none whitespace-pre overflow-hidden"
        style={{ transform: `translateX(${-scrollLeft}px)` }}
      >
        {value ? renderHighlightedInterpolations(value) : (
          <span className="text-[var(--color-text-muted)]">{placeholder}</span>
        )}
      </div>
      <input
        ref={inputRef}
        className={inputClassName ?? 'relative z-0 w-full px-3 py-1.5 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-transparent caret-[var(--color-primary)] selection:bg-[var(--color-primary)] selection:text-[var(--color-bg)] placeholder-transparent'}
        value={value}
        onChange={handleChange}
        onScroll={e => setScrollLeft(e.currentTarget.scrollLeft)}
        placeholder={placeholder}
      />
    </div>
  );
}

function InterpolatedTextarea({
  value,
  onChange,
  placeholder,
  knownKeys,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  knownKeys: ReadonlySet<string>;
  className?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    const nextValue = expandUrlVariableShorthandWithSelection(
      input.value,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      { knownKeys },
    );

    if (nextValue.value !== input.value) {
      input.value = nextValue.value;
      input.setSelectionRange(nextValue.selectionStart, nextValue.selectionEnd);
    }

    onChange(nextValue.value);
  }, [knownKeys, onChange]);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="relative w-full">
      <pre
        ref={preRef}
        className="absolute inset-0 m-0 px-3 py-2 h-48 text-xs font-mono whitespace-pre-wrap break-all leading-5 pointer-events-none overflow-auto"
        aria-hidden="true"
      >
        {value ? renderHighlightedInterpolations(value) : (
          <span className="text-[var(--color-text-muted)]">{placeholder}</span>
        )}
      </pre>
      <textarea
        ref={textareaRef}
        className={className ?? 'w-full h-48 px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded resize-none text-transparent caret-[var(--color-primary)] placeholder-transparent overflow-auto'}
        value={value}
        onChange={handleChange}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
}

function KeyValueEditor({ items, onChange, label, knownKeys }: {
  items: (Header | QueryParameter)[]; onChange: (items: (Header | QueryParameter)[]) => void; label: string; knownKeys: ReadonlySet<string>;
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
          <div className="flex-1 min-w-0">
            <InterpolatedTextInput
              value={item.value}
              onChange={value => updateRow(i, 'value', value)}
              placeholder="Value"
              knownKeys={knownKeys}
              inputClassName="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-transparent caret-[var(--color-primary)] selection:bg-[var(--color-primary)] selection:text-[var(--color-bg)] placeholder-transparent"
            />
          </div>
          <button onClick={() => removeRow(i)} className="text-[var(--color-error)] text-xs hover:underline">✕</button>
        </div>
      ))}
    </div>
  );
}

export function RequestEditor({ heightPercent = 50 }: { heightPercent?: number }) {
  const { currentRequest, updateRequest, isSending, setIsSending, setSendError, setCurrentResponse, setRequestStart } = useRequestStore();
  const environments = useEnvironmentStore(state => state.environments);
  const activeEnvironmentId = useEnvironmentStore(state => state.activeEnvironmentId);
  const resolveVariables = useEnvironmentStore(state => state.resolveVariables);
  const [activeTab, setActiveTab] = useState<'headers' | 'params' | 'body' | 'auth' | 'settings'>('headers');

  const urlInputRef = useRef<HTMLInputElement>(null);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteOptions, setAutocompleteOptions] = useState<string[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [autocompleteTriggerPos, setAutocompleteTriggerPos] = useState(0);
  const [urlScrollLeft, setUrlScrollLeft] = useState(0);

  const urlVariableKeys = useMemo(
    () => collectActiveEnvironmentKeys(environments, activeEnvironmentId),
    [activeEnvironmentId, environments],
  );

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
    const baseRequest = useRequestStore.getState().currentRequest;
    if (!baseRequest) return;

    const nextRequest = { ...baseRequest, ...updates, updatedAt: Date.now() };

    updateRequest(updates);
    saveRequest(nextRequest);
  }, [saveRequest, updateRequest]);

  const handleUrlChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const nextUrl = expandUrlVariableShorthandWithSelection(
      input.value,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      { knownKeys: urlVariableKeys },
    );

    if (nextUrl.value !== input.value) {
      input.value = nextUrl.value;
      input.setSelectionRange(nextUrl.selectionStart, nextUrl.selectionEnd);
    }

    const cursorPos = input.selectionStart ?? input.value.length;
    const beforeCursor = input.value.slice(0, cursorPos);
    const triggerMatch = beforeCursor.match(/_\.([A-Za-z0-9_]*)$/);
    if (triggerMatch) {
      const partial = triggerMatch[1];
      const matches = Array.from(urlVariableKeys).filter(k =>
        k.toLowerCase().startsWith(partial.toLowerCase()),
      );
      if (matches.length > 0) {
        setShowAutocomplete(true);
        setAutocompleteOptions(matches);
        setSelectedOptionIndex(0);
        setAutocompleteTriggerPos(cursorPos - triggerMatch[0].length);
      }
    } else {
      setShowAutocomplete(false);
    }

    updateRequest({ url: nextUrl.value });
  }, [updateRequest, urlVariableKeys]);

  const handleUrlScroll = useCallback((event: React.UIEvent<HTMLInputElement>) => {
    setUrlScrollLeft(event.currentTarget.scrollLeft);
  }, []);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showAutocomplete) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedOptionIndex(prev => (prev + 1) % autocompleteOptions.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedOptionIndex(prev =>
        (prev - 1 + autocompleteOptions.length) % autocompleteOptions.length,
      );
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && autocompleteOptions.length > 0) {
      e.preventDefault();
      const input = urlInputRef.current;
      if (!input) return;
      const key = autocompleteOptions[selectedOptionIndex];
      const cursorPos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, autocompleteTriggerPos);
      const after = input.value.slice(cursorPos);
      const newValue = before + '{{' + key + '}}' + after;
      updateRequest({ url: newValue });
      setShowAutocomplete(false);
      setAutocompleteOptions([]);
      return;
    }
    if (e.key === 'Escape') {
      setShowAutocomplete(false);
      setAutocompleteOptions([]);
    }
  }, [showAutocomplete, autocompleteOptions, selectedOptionIndex, autocompleteTriggerPos, updateRequest]);

  const resolvePreviewText = useCallback((text: string) => (
    resolveVariables(expandUrlVariableShorthand(text, { knownKeys: urlVariableKeys, includeTrailingUnknown: true }))
  ), [resolveVariables, urlVariableKeys]);

  const urlPreview = useMemo(() => {
    if (!currentRequest) return '';

    return composeRequestUrl(
      resolvePreviewText(currentRequest.url),
      currentRequest.parameters.map(param => ({
        ...param,
        key: resolvePreviewText(param.key),
        value: resolvePreviewText(param.value),
      })),
      currentRequest.auth,
    );
  }, [currentRequest, resolvePreviewText]);

  const handleUrlBlur = useCallback(() => {
    setShowAutocomplete(false);
    if (!currentRequest) return;

    const normalizedUrl = expandUrlVariableShorthand(currentRequest.url, {
      knownKeys: urlVariableKeys,
      includeTrailingUnknown: true,
    });
    const nextRequest = normalizedUrl === currentRequest.url
      ? currentRequest
      : { ...currentRequest, url: normalizedUrl, updatedAt: Date.now() };

    if (normalizedUrl !== currentRequest.url) {
      updateRequest({ url: normalizedUrl });
    }

    saveRequest(nextRequest);
  }, [currentRequest, saveRequest, updateRequest, urlVariableKeys]);

  const handleSend = useCallback(async (request: Request | null) => {
    if (!request) return;
    const normalizedUrl = expandUrlVariableShorthand(request.url, {
      knownKeys: urlVariableKeys,
      includeTrailingUnknown: true,
    });
    const sentRequest = normalizedUrl === request.url
      ? request
      : { ...request, url: normalizedUrl, updatedAt: Date.now() };

    if (sentRequest !== request) {
      updateRequest({ url: normalizedUrl });
      saveRequest(sentRequest);
    }

    setCurrentResponse(null);
    setSendError(null);
    setIsSending(true);
    setRequestStart();
    try {
      const result = await window.api.sendRequest({ request: sentRequest, environmentId: getSendEnvironmentId() });
      if (result.success && result.response) {
        const latestRequest = useRequestStore.getState().currentRequest;
        if (latestRequest?.id === sentRequest.id) {
          setCurrentResponse(result.response as unknown as Response);
          updateRequest({ lastResponse: result.response });
        }
        saveRequest({ ...sentRequest, lastResponse: result.response, updatedAt: Date.now() });
      } else {
        setCurrentResponse(null);
        setSendError(result.error || 'Request denied', sentRequest.url);
      }
    } catch (err: unknown) {
      setCurrentResponse(null);
      setSendError(err instanceof Error ? err : 'Request denied', sentRequest.url);
    } finally {
      setIsSending(false);
    }
  }, [saveRequest, setIsSending, setRequestStart, setSendError, setCurrentResponse, updateRequest, urlVariableKeys]);

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
      <div className="flex items-start gap-2 p-3">
        <select
          className="px-2 py-1.5 text-xs font-bold bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]"
          value={currentRequest?.method || 'GET'}
          onChange={e => updateAndSaveRequest({ method: e.target.value as HttpMethod })}
          style={{ color: METHOD_COLORS[(currentRequest?.method || 'GET') as HttpMethod] }}
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="flex-1 min-w-0">
          <div className="relative">
            <div
              className="absolute inset-0 z-10 px-3 py-1.5 text-sm leading-5 text-[var(--color-text)] pointer-events-none whitespace-pre overflow-hidden"
              style={{ transform: `translateX(${-urlScrollLeft}px)` }}
            >
              {currentRequest?.url
                ? renderUrlOverlay(currentRequest.url, urlVariableKeys, currentRequest.parameters || [], updateAndSaveRequest)
                : <span className="text-[var(--color-text-muted)]">Enter request URL</span>
              }
            </div>
            <input
              ref={urlInputRef}
              className="relative z-0 w-full px-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-transparent caret-[var(--color-primary)] selection:bg-[var(--color-primary)] selection:text-[var(--color-bg)] placeholder-transparent"
              placeholder="Enter request URL"
              value={currentRequest?.url || ''}
              onChange={handleUrlChange}
              onScroll={handleUrlScroll}
              onKeyDown={handleUrlKeyDown}
              onBlur={handleUrlBlur}
            />
            {showAutocomplete && autocompleteOptions.length > 0 && (
              <div
                className="absolute z-50 w-full mt-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded shadow-lg overflow-hidden"
                style={{ maxHeight: '200px', overflowY: 'auto' }}
              >
                {autocompleteOptions.map((key, i) => (
                  <div
                    key={key}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      const before = (urlInputRef.current?.value || '').slice(0, autocompleteTriggerPos);
                      const cursorPos = urlInputRef.current?.selectionStart ?? 0;
                      const after = (urlInputRef.current?.value || '').slice(cursorPos);
                      updateRequest({ url: before + '{{' + key + '}}' + after });
                      setShowAutocomplete(false);
                      setAutocompleteOptions([]);
                    }}
                    className={`px-3 py-1.5 text-sm cursor-pointer font-mono ${
                      i === selectedOptionIndex
                        ? 'bg-[var(--color-primary)] text-[var(--color-bg)]'
                        : 'text-[var(--color-text)] hover:bg-[var(--color-surface)]'
                    }`}
                  >
                    {key}
                  </div>
                ))}
                <div className="px-3 py-1 text-[11px] text-[var(--color-text-muted)] border-t border-[var(--color-border)]">
                  ↑↓ navigate · Enter/Tab select · Esc close
                </div>
              </div>
            )}
          </div>
          <div data-testid="request-url-preview" className="mt-1 px-1 text-[11px] text-[var(--color-text-muted)] truncate">
            Preview: <span className="font-mono text-[var(--color-text)]">{urlPreview || '—'}</span>
          </div>
        </div>
        <button
          onClick={() => handleSend(currentRequest)}
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
        {activeTab === 'headers' && <KeyValueEditor items={currentRequest?.headers || []} onChange={h => updateAndSaveRequest({ headers: h })} label="Headers" knownKeys={urlVariableKeys} />}
        {activeTab === 'params' && <KeyValueEditor items={currentRequest?.parameters || []} onChange={p => updateAndSaveRequest({ parameters: p })} label="Query Parameters" knownKeys={urlVariableKeys} />}
        {activeTab === 'body' && <BodyEditor key={currentRequest?.id ?? 'none'} request={currentRequest} onUpdate={updateAndSaveRequest} knownKeys={urlVariableKeys} />}
        {activeTab === 'auth' && <ControlledAuthEditor key={currentRequest?.id ?? 'none'} request={currentRequest} onUpdate={updateAndSaveRequest} />}
        {activeTab === 'settings' && <SettingsEditor key={currentRequest?.id ?? 'none'} request={currentRequest} onUpdate={updateAndSaveRequest} />}
      </div>
    </div>
  );
}

function JsonHighlightTextarea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const tokens = useMemo(() => tokenizeJson(value), [value]);

  const highlighted = useMemo(() => (
    tokens.map((token, i) => (
      <span key={i} className={tokenClass(token)}>
        {token.type === 'string' ? renderHighlightedInterpolations(token.value) : token.value}
      </span>
    ))
  ), [tokens]);

  const handleScroll = useCallback(() => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
      preRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="relative w-full">
      <pre
        ref={preRef}
        className="absolute inset-0 m-0 px-3 py-2 h-48 text-xs font-mono whitespace-pre-wrap break-all leading-5 pointer-events-none overflow-auto"
        aria-hidden="true"
      >
        {highlighted}
      </pre>
      <textarea
        ref={textareaRef}
        className="w-full h-48 px-3 py-2 text-xs font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded resize-none focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] text-transparent caret-[var(--color-text)] placeholder-[var(--color-text-muted)] overflow-auto"
        value={value}
        onChange={e => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  );
}

function BodyEditor({ request, onUpdate, knownKeys }: { request: Request | null; onUpdate: (u: Partial<Request>) => void; knownKeys: ReadonlySet<string> }) {
  const requestDraft = useRequestStore(state => (request ? state.requestDrafts[request.id] : undefined));
  const sourceRequest = request ?? requestDraft;
  const [bodyType, setBodyType] = useState<BodyType>(sourceRequest?.body?.type || 'none');
  const [rawContent, setRawContent] = useState(sourceRequest?.body?.raw?.content || '');
  const [rawLang, setRawLang] = useState(sourceRequest?.body?.raw?.language || 'json');
  const [formFields, setFormFields] = useState<FormField[]>(sourceRequest?.body?.form ?? []);
  const [multipartFields, setMultipartFields] = useState<MultipartField[]>(sourceRequest?.body?.multipart ?? []);

  useEffect(() => {
    setBodyType(sourceRequest?.body?.type || 'none');
    setRawContent(sourceRequest?.body?.raw?.content || '');
    setRawLang(sourceRequest?.body?.raw?.language || 'json');
    setFormFields(sourceRequest?.body?.form ?? []);
    setMultipartFields(sourceRequest?.body?.multipart ?? []);
  }, [sourceRequest?.id, sourceRequest?.body]);

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
          {rawLang === 'json' ? (
            <JsonHighlightTextarea
              value={rawContent}
              onChange={value => { setRawContent(value); onUpdate({ body: { type: 'raw', raw: { language: rawLang, content: value } } }); }}
              placeholder='{"key": "value"}'
            />
          ) : (
            <InterpolatedTextarea
              value={rawContent}
              onChange={value => { setRawContent(value); onUpdate({ body: { type: 'raw', raw: { language: rawLang, content: value } } }); }}
              placeholder="Raw body"
              knownKeys={knownKeys}
            />
          )}
        </>
      )}
      {bodyType === 'none' && <p className="text-xs text-[var(--color-text-muted)]">No body for this request.</p>}
      {bodyType === 'form-urlencoded' && (
        <FormFieldsEditor fields={formFields} onChange={fields => {
          setFormFields(fields);
          onUpdate({ body: { type: 'form-urlencoded', form: fields } });
        }} knownKeys={knownKeys} />
      )}
      {bodyType === 'multipart' && (
        <MultipartFieldsEditor fields={multipartFields} onChange={fields => {
          setMultipartFields(fields);
          onUpdate({ body: { type: 'multipart', multipart: fields } });
        }} knownKeys={knownKeys} />
      )}
    </div>
  );
}

function FormFieldsEditor({ fields, onChange, knownKeys }: { fields: FormField[]; onChange: (fields: FormField[]) => void; knownKeys: ReadonlySet<string> }) {
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
          <div className="flex-1 min-w-0">
            <InterpolatedTextInput
              value={item.value}
              onChange={value => updateRow(i, 'value', value)}
              placeholder="Value"
              knownKeys={knownKeys}
              inputClassName="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-transparent caret-[var(--color-primary)] selection:bg-[var(--color-primary)] selection:text-[var(--color-bg)] placeholder-transparent"
            />
          </div>
          <button onClick={() => removeRow(i)} className="text-[var(--color-error)] text-xs hover:underline">✕</button>
        </div>
      ))}
    </div>
  );
}

function MultipartFieldsEditor({ fields, onChange, knownKeys }: { fields: MultipartField[]; onChange: (fields: MultipartField[]) => void; knownKeys: ReadonlySet<string> }) {
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
              <div className="flex-1 min-w-0">
                <InterpolatedTextInput
                  value={item.value}
                  onChange={value => updateRow(i, 'value', value)}
                  placeholder="Value"
                  knownKeys={knownKeys}
                  inputClassName="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-transparent caret-[var(--color-primary)] selection:bg-[var(--color-primary)] selection:text-[var(--color-bg)] placeholder-transparent"
                />
              </div>
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
  const requestDraft = useRequestStore(state => (request ? state.requestDrafts[request.id] : undefined));
  const sourceRequest = request ?? requestDraft;
  const [authType, setAuthType] = useState<AuthType>(sourceRequest?.auth?.type || 'none');
  const [bearerToken, setBearerToken] = useState(sourceRequest?.auth?.bearer?.token || '');
  const [bearerPrefix, setBearerPrefix] = useState(sourceRequest?.auth?.bearer?.prefix || 'Bearer');
  const [apiKeyKey, setApiKeyKey] = useState(sourceRequest?.auth?.api_key?.key || '');
  const [apiKeyValue, setApiKeyValue] = useState(sourceRequest?.auth?.api_key?.value || '');
  const [apiKeyIn, setApiKeyIn] = useState<'header' | 'query'>(sourceRequest?.auth?.api_key?.in || 'header');
  const [basicUser, setBasicUser] = useState(sourceRequest?.auth?.basic?.username || '');
  const [basicPass, setBasicPass] = useState(sourceRequest?.auth?.basic?.password || '');
  const [oauthGrantType, setOauthGrantType] = useState<OAuth2GrantType>(sourceRequest?.auth?.oauth2?.grantType || 'client_credentials');
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState(sourceRequest?.auth?.oauth2?.authorizationUrl || '');
  const [oauthTokenUrl, setOauthTokenUrl] = useState(sourceRequest?.auth?.oauth2?.tokenUrl || '');
  const [oauthClientId, setOauthClientId] = useState(sourceRequest?.auth?.oauth2?.clientId || '');
  const [oauthClientSecret, setOauthClientSecret] = useState(sourceRequest?.auth?.oauth2?.clientSecret || '');
  const [oauthScope, setOauthScope] = useState(sourceRequest?.auth?.oauth2?.scope || '');
  const [oauthRedirectUri, setOauthRedirectUri] = useState(sourceRequest?.auth?.oauth2?.redirectUri || '');
  const [ntlmUseCurrentAuth, setNtlmUseCurrentAuth] = useState(sourceRequest?.auth?.ntlm?.useCurrentAuthContext ?? true);
  const [ntlmUser, setNtlmUser] = useState(sourceRequest?.auth?.ntlm?.username || '');
  const [ntlmPassword, setNtlmPassword] = useState(sourceRequest?.auth?.ntlm?.password || '');
  const [ntlmDomain, setNtlmDomain] = useState(sourceRequest?.auth?.ntlm?.domain || '');
  const [ntlmWorkstation, setNtlmWorkstation] = useState(sourceRequest?.auth?.ntlm?.workstation || '');

  useEffect(() => {
    if (!sourceRequest?.id) return;

    let cancelled = false;

    void window.api.collectionExport(sourceRequest.id).then((fresh) => {
      if (cancelled) return;

      const auth = fresh?.auth ?? sourceRequest.auth;
      setAuthType(auth?.type || 'none');
      setBearerToken(auth?.bearer?.token || '');
      setBearerPrefix(auth?.bearer?.prefix || 'Bearer');
      setApiKeyKey(auth?.api_key?.key || '');
      setApiKeyValue(auth?.api_key?.value || '');
      setApiKeyIn(auth?.api_key?.in || 'header');
      setBasicUser(auth?.basic?.username || '');
      setBasicPass(auth?.basic?.password || '');
      setOauthGrantType(auth?.oauth2?.grantType || 'client_credentials');
      setOauthAuthorizationUrl(auth?.oauth2?.authorizationUrl || '');
      setOauthTokenUrl(auth?.oauth2?.tokenUrl || '');
      setOauthClientId(auth?.oauth2?.clientId || '');
      setOauthClientSecret(auth?.oauth2?.clientSecret || '');
      setOauthScope(auth?.oauth2?.scope || '');
      setOauthRedirectUri(auth?.oauth2?.redirectUri || '');
      setNtlmUseCurrentAuth(auth?.ntlm?.useCurrentAuthContext ?? true);
      setNtlmUser(auth?.ntlm?.username || '');
      setNtlmPassword(auth?.ntlm?.password || '');
      setNtlmDomain(auth?.ntlm?.domain || '');
      setNtlmWorkstation(auth?.ntlm?.workstation || '');
    }).catch(() => {
      if (cancelled) return;

      setAuthType(sourceRequest?.auth?.type || 'none');
      setBearerToken(sourceRequest?.auth?.bearer?.token || '');
      setBearerPrefix(sourceRequest?.auth?.bearer?.prefix || 'Bearer');
      setApiKeyKey(sourceRequest?.auth?.api_key?.key || '');
      setApiKeyValue(sourceRequest?.auth?.api_key?.value || '');
      setApiKeyIn(sourceRequest?.auth?.api_key?.in || 'header');
      setBasicUser(sourceRequest?.auth?.basic?.username || '');
      setBasicPass(sourceRequest?.auth?.basic?.password || '');
      setOauthGrantType(sourceRequest?.auth?.oauth2?.grantType || 'client_credentials');
      setOauthAuthorizationUrl(sourceRequest?.auth?.oauth2?.authorizationUrl || '');
      setOauthTokenUrl(sourceRequest?.auth?.oauth2?.tokenUrl || '');
      setOauthClientId(sourceRequest?.auth?.oauth2?.clientId || '');
      setOauthClientSecret(sourceRequest?.auth?.oauth2?.clientSecret || '');
      setOauthScope(sourceRequest?.auth?.oauth2?.scope || '');
      setOauthRedirectUri(sourceRequest?.auth?.oauth2?.redirectUri || '');
      setNtlmUseCurrentAuth(sourceRequest?.auth?.ntlm?.useCurrentAuthContext ?? true);
      setNtlmUser(sourceRequest?.auth?.ntlm?.username || '');
      setNtlmPassword(sourceRequest?.auth?.ntlm?.password || '');
      setNtlmDomain(sourceRequest?.auth?.ntlm?.domain || '');
      setNtlmWorkstation(sourceRequest?.auth?.ntlm?.workstation || '');
    });

    return () => {
      cancelled = true;
    };
  }, [sourceRequest?.id, sourceRequest?.auth]);

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
      ntlmUseCurrentAuth: boolean;
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
      ntlmUseCurrentAuth,
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
            useCurrentAuthContext: values.ntlmUseCurrentAuth ?? true,
            username: values.ntlmUseCurrentAuth ? undefined : values.ntlmUser,
            password: values.ntlmUseCurrentAuth ? undefined : values.ntlmPassword,
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
        <label className="flex items-center gap-2 mb-3">
          <input type="checkbox" checked={ntlmUseCurrentAuth} onChange={e => { const value = e.target.checked; setNtlmUseCurrentAuth(value); onUpdate({ auth: buildAuth('ntlm', { ntlmUseCurrentAuth: value }) }); }} className="accent-[var(--color-primary)]" />
          <span className="text-xs text-[var(--color-text)]">Use current Windows auth context</span>
        </label>
        {!ntlmUseCurrentAuth && (<>
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={ntlmUser} onChange={e => { const value = e.target.value; setNtlmUser(value); onUpdate({ auth: buildAuth('ntlm', { ntlmUser: value }) }); }} />
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Domain (optional)" value={ntlmDomain} onChange={e => { const value = e.target.value; setNtlmDomain(value); onUpdate({ auth: buildAuth('ntlm', { ntlmDomain: value }) }); }} />
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Workstation (optional)" value={ntlmWorkstation} onChange={e => { const value = e.target.value; setNtlmWorkstation(value); onUpdate({ auth: buildAuth('ntlm', { ntlmWorkstation: value }) }); }} />
          <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={ntlmPassword} onChange={e => { const value = e.target.value; setNtlmPassword(value); onUpdate({ auth: buildAuth('ntlm', { ntlmPassword: value }) }); }} />
        </>)}
      </>)}
    </div>
  );
}

function ControlledAuthEditor({ request, onUpdate }: { request: Request | null; onUpdate: (u: Partial<Request>) => void }) {
  const [hydratedRequest, setHydratedRequest] = useState<Request | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHydratedRequest(null);

    if (!request?.id) return () => { cancelled = true; };

    void window.api.collectionExport(request.id).then((fresh) => {
      if (cancelled) return;
      setHydratedRequest((fresh as Request) ?? null);
    }).catch(() => {
      if (cancelled) return;
      setHydratedRequest(null);
    });

    return () => {
      cancelled = true;
    };
  }, [request?.id]);

  const sourceRequest = hydratedRequest?.auth?.type && hydratedRequest.auth.type !== 'none'
    ? hydratedRequest
    : request;
  const auth = sourceRequest?.auth ?? { type: 'none' as AuthType };

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
      ntlmUseCurrentAuth: boolean;
      ntlmUser: string;
      ntlmPassword: string;
      ntlmDomain: string;
      ntlmWorkstation: string;
    }> = {},
  ): AuthConfig => {
    const values = {
      bearerToken: auth.bearer?.token ?? '',
      bearerPrefix: auth.bearer?.prefix ?? 'Bearer',
      apiKeyKey: auth.api_key?.key ?? '',
      apiKeyValue: auth.api_key?.value ?? '',
      apiKeyIn: auth.api_key?.in ?? 'header',
      basicUser: auth.basic?.username ?? '',
      basicPass: auth.basic?.password ?? '',
      oauthGrantType: auth.oauth2?.grantType ?? 'client_credentials',
      oauthAuthorizationUrl: auth.oauth2?.authorizationUrl ?? '',
      oauthTokenUrl: auth.oauth2?.tokenUrl ?? '',
      oauthClientId: auth.oauth2?.clientId ?? '',
      oauthClientSecret: auth.oauth2?.clientSecret ?? '',
      oauthScope: auth.oauth2?.scope ?? '',
      oauthRedirectUri: auth.oauth2?.redirectUri ?? '',
      ntlmUseCurrentAuth: auth.ntlm?.useCurrentAuthContext ?? true,
      ntlmUser: auth.ntlm?.username ?? '',
      ntlmPassword: auth.ntlm?.password ?? '',
      ntlmDomain: auth.ntlm?.domain ?? '',
      ntlmWorkstation: auth.ntlm?.workstation ?? '',
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
            useCurrentAuthContext: values.ntlmUseCurrentAuth ?? true,
            username: values.ntlmUseCurrentAuth ? undefined : values.ntlmUser,
            password: values.ntlmUseCurrentAuth ? undefined : values.ntlmPassword,
            domain: values.ntlmDomain || undefined,
            workstation: values.ntlmWorkstation || undefined,
          },
        };
      default:
        return { type: 'none' };
    }
  };

  return (
    <div className="p-4">
      <select className="mb-4 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={auth.type} onChange={e => onUpdate({ auth: buildAuth(e.target.value as AuthType) })}>
        <option value="none">None</option><option value="bearer">Bearer Token</option><option value="api_key">API Key</option><option value="basic">Basic Auth</option><option value="oauth2">OAuth 2.0</option><option value="ntlm">NTLM</option>
      </select>
      {auth.type === 'bearer' && <div className="space-y-2"><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Token" value={auth.bearer?.token || ''} onChange={e => onUpdate({ auth: buildAuth('bearer', { bearerToken: e.target.value }) })} /><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Prefix" value={auth.bearer?.prefix || 'Bearer'} onChange={e => onUpdate({ auth: buildAuth('bearer', { bearerPrefix: e.target.value }) })} /></div>}
      {auth.type === 'api_key' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Key header name" value={auth.api_key?.key || ''} onChange={e => onUpdate({ auth: buildAuth('api_key', { apiKeyKey: e.target.value }) })} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Value" value={auth.api_key?.value || ''} onChange={e => onUpdate({ auth: buildAuth('api_key', { apiKeyValue: e.target.value }) })} />
        <select className="w-full px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={auth.api_key?.in || 'header'} onChange={e => onUpdate({ auth: buildAuth('api_key', { apiKeyIn: e.target.value as 'header' | 'query' }) })}>
          <option value="header">Header</option>
          <option value="query">Query</option>
        </select>
      </>)}
      {auth.type === 'basic' && (<>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={auth.basic?.username || ''} onChange={e => onUpdate({ auth: buildAuth('basic', { basicUser: e.target.value }) })} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={auth.basic?.password || ''} onChange={e => onUpdate({ auth: buildAuth('basic', { basicPass: e.target.value }) })} />
      </>)}
      {auth.type === 'oauth2' && (<>
        <div className="mb-2 text-xs text-[var(--color-text-muted)]">Current engine support: client credentials only.</div>
        <select className="w-full mb-2 px-2 py-1 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" value={auth.oauth2?.grantType || 'client_credentials'} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthGrantType: e.target.value as OAuth2GrantType }) })}>
          <option value="client_credentials">Client Credentials</option>
          <option value="authorization_code">Authorization Code</option>
          <option value="password">Password</option>
          <option value="pkce">PKCE</option>
        </select>
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Token URL" value={auth.oauth2?.tokenUrl || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthTokenUrl: e.target.value }) })} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Authorization URL" value={auth.oauth2?.authorizationUrl || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthAuthorizationUrl: e.target.value }) })} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Client ID" value={auth.oauth2?.clientId || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthClientId: e.target.value }) })} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Client Secret" type="password" value={auth.oauth2?.clientSecret || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthClientSecret: e.target.value }) })} />
        <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Scope" value={auth.oauth2?.scope || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthScope: e.target.value }) })} />
        <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Redirect URI" value={auth.oauth2?.redirectUri || ''} onChange={e => onUpdate({ auth: buildAuth('oauth2', { oauthRedirectUri: e.target.value }) })} />
      </>)}
      {auth.type === 'ntlm' && (<>
        <label className="flex items-center gap-2 mb-3">
          <input type="checkbox" checked={auth.ntlm?.useCurrentAuthContext ?? true} onChange={e => onUpdate({ auth: buildAuth('ntlm', { ntlmUseCurrentAuth: e.target.checked }) })} className="accent-[var(--color-primary)]" />
          <span className="text-xs text-[var(--color-text)]">Use current Windows auth context</span>
        </label>
        {!auth.ntlm?.useCurrentAuthContext && (<>
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Username" value={auth.ntlm?.username || ''} onChange={e => onUpdate({ auth: buildAuth('ntlm', { ntlmUser: e.target.value }) })} />
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Domain (optional)" value={auth.ntlm?.domain || ''} onChange={e => onUpdate({ auth: buildAuth('ntlm', { ntlmDomain: e.target.value }) })} />
          <input className="w-full mb-2 px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Workstation (optional)" value={auth.ntlm?.workstation || ''} onChange={e => onUpdate({ auth: buildAuth('ntlm', { ntlmWorkstation: e.target.value }) })} />
          <input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" placeholder="Password" type="password" value={auth.ntlm?.password || ''} onChange={e => onUpdate({ auth: buildAuth('ntlm', { ntlmPassword: e.target.value }) })} />
        </>)}
      </>)}
    </div>
  );
}

function SettingsEditor({ request, onUpdate }: { request: any; onUpdate: (u: any) => void }) {
  const requestDraft = useRequestStore(state => (request ? state.requestDrafts[request.id] : undefined));
  const sourceRequest = request ?? requestDraft;

  if (!sourceRequest) return null;
  return (
    <div className="p-4 space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={sourceRequest.settings?.followRedirect ?? true} onChange={e => onUpdate({ settings: { ...sourceRequest.settings, followRedirect: e.target.checked } })} className="accent-[var(--color-primary)]" /><span className="text-xs text-[var(--color-text)]">Follow Redirects</span></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={sourceRequest.settings?.allowInsecureCertificates ?? false} onChange={e => onUpdate({ settings: { ...sourceRequest.settings, allowInsecureCertificates: e.target.checked } })} className="accent-[var(--color-primary)]" /><span className="text-xs text-[var(--color-text)]">Allow insecure certificates</span></label>
      <p className="text-[11px] text-[var(--color-text-muted)]">Disables TLS certificate verification for this request.</p>
      <div><span className="text-xs text-[var(--color-text-muted)] block mb-1">Timeout (ms)</span><input className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)]" type="number" value={sourceRequest.settings?.timeout ?? 30000} onChange={e => onUpdate({ settings: { ...sourceRequest.settings, timeout: Number(e.target.value) } })} /></div>
      <div>
        <span className="text-xs text-[var(--color-text-muted)] block mb-1">User Agent</span>
        <input
          className="w-full px-3 py-2 text-xs bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder-[var(--color-text-muted)]"
          placeholder="Restiprocity"
          value={sourceRequest.settings?.userAgent || ''}
          onChange={e => onUpdate({ settings: { ...sourceRequest.settings, userAgent: e.target.value } })}
        />
      </div>
    </div>
  );
}
