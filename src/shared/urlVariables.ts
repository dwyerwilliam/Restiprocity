export const BUILT_IN_VARIABLE_KEYS = ['timestamp', 'randomInt', 'uuid'] as const;

interface ShorthandOptions {
  knownKeys?: ReadonlySet<string>;
  includeTrailingUnknown?: boolean;
}

interface ShorthandSelectionResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

const URL_VARIABLE_SHORTHAND_PATTERN = /(^|[/?#&=\s])_\.([A-Za-z][A-Za-z0-9_]*)(?=$|[/?#&=\s])/g;

function shouldExpandShorthand(value: string, matchEnd: number, key: string, options: ShorthandOptions): boolean {
  if (matchEnd < value.length) {
    return true;
  }

  return options.includeTrailingUnknown === true || options.knownKeys?.has(key) === true;
}

function adjustSelection(selection: number, matchStart: number, matchEnd: number, replacementEnd: number, diff: number): number {
  if (matchEnd <= selection) {
    return selection + diff;
  }

  if (matchStart < selection) {
    return replacementEnd;
  }

  return selection;
}

export function expandUrlVariableShorthand(value: string, options: ShorthandOptions = {}): string {
  return value.replace(URL_VARIABLE_SHORTHAND_PATTERN, (match, prefix: string, key: string, offset: number) => {
    const matchEnd = offset + match.length;
    if (!shouldExpandShorthand(value, matchEnd, key, options)) {
      return match;
    }

    return `${prefix}{{${key}}}`;
  });
}

export function expandUrlVariableShorthandWithSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  options: ShorthandOptions = {},
): ShorthandSelectionResult {
  let nextValue = '';
  let lastIndex = 0;
  let nextSelectionStart = selectionStart;
  let nextSelectionEnd = selectionEnd;

  for (const match of value.matchAll(URL_VARIABLE_SHORTHAND_PATTERN)) {
    const matchText = match[0];
    const prefix = match[1];
    const key = match[2];
    const matchStart = match.index ?? 0;
    const matchEnd = matchStart + matchText.length;

    if (!shouldExpandShorthand(value, matchEnd, key, options)) {
      continue;
    }

    const replacement = `${prefix}{{${key}}}`;
    const replacementEnd = matchStart + replacement.length;
    const diff = replacement.length - matchText.length;

    nextValue += value.slice(lastIndex, matchStart);
    nextValue += replacement;
    lastIndex = matchEnd;
    nextSelectionStart = adjustSelection(nextSelectionStart, matchStart, matchEnd, replacementEnd, diff);
    nextSelectionEnd = adjustSelection(nextSelectionEnd, matchStart, matchEnd, replacementEnd, diff);
  }

  if (lastIndex === 0) {
    return { value, selectionStart, selectionEnd };
  }

  nextValue += value.slice(lastIndex);

  return {
    value: nextValue,
    selectionStart: Math.min(nextSelectionStart, nextValue.length),
    selectionEnd: Math.min(nextSelectionEnd, nextValue.length),
  };
}

export interface QueryParameterLike {
  key: string;
  value: string;
  enabled?: boolean;
}

function tryDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function splitUrlQuery(url: string): { beforeQuery: string; query: string; hash: string } | null {
  const hashIdx = url.indexOf('#');
  const beforeHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const hash = hashIdx >= 0 ? url.slice(hashIdx) : '';
  const qIdx = beforeHash.indexOf('?');

  if (qIdx < 0) return null;

  return {
    beforeQuery: beforeHash.slice(0, qIdx),
    query: beforeHash.slice(qIdx + 1),
    hash,
  };
}

function queryPairToParam(pair: string): { key: string; value: string } {
  const eqIdx = pair.indexOf('=');
  if (eqIdx < 0) return { key: tryDecode(pair), value: '' };

  return {
    key: tryDecode(pair.slice(0, eqIdx)),
    value: tryDecode(pair.slice(eqIdx + 1)),
  };
}

export function extractQueryParamsFromUrl(url: string): { key: string; value: string }[] {
  const parts = splitUrlQuery(url);
  if (!parts?.query) return [];

  return parts.query.split('&').filter(Boolean).map(queryPairToParam);
}

export function removeQueryFromUrl(url: string): string {
  const parts = splitUrlQuery(url);
  return parts ? `${parts.beforeQuery}${parts.hash}` : url;
}

export function removeQueryParamFromUrl(url: string, paramIndex: number): { url: string; param: { key: string; value: string } } | null {
  const parts = splitUrlQuery(url);
  if (!parts?.query) return null;

  const pairs = parts.query.split('&').filter(Boolean);
  const pair = pairs[paramIndex];
  if (!pair) return null;

  const remainingPairs = pairs.filter((_, index) => index !== paramIndex);
  const nextQuery = remainingPairs.length > 0 ? `?${remainingPairs.join('&')}` : '';

  return {
    url: `${parts.beforeQuery}${nextQuery}${parts.hash}`,
    param: queryPairToParam(pair),
  };
}

export function composeRequestUrl(
  baseUrl: string,
  parameters: ReadonlyArray<QueryParameterLike> = [],
  auth?: { type: string; api_key?: { key: string; value: string; in: 'header' | 'query' } } | null,
): string {
  if (!baseUrl) return baseUrl;

  const [beforeHash, hash = ''] = baseUrl.split('#', 2);
  const [path, existingQuery = ''] = beforeHash.split('?', 2);
  const additions: string[] = [];

  for (const param of parameters) {
    if (param.enabled === false) continue;

    const key = param.key.trim();
    if (!key) continue;

    additions.push(`${encodeURIComponent(key)}=${encodeURIComponent(param.value)}`);
  }

  if (auth?.type === 'api_key' && auth.api_key?.in === 'query') {
    const key = auth.api_key.key.trim();
    const value = auth.api_key.value;
    if (key && value) {
      additions.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }

  const query = [existingQuery, ...additions].filter(Boolean).join('&');
  const next = query ? `${path}?${query}` : path;

  return hash ? `${next}#${hash}` : next;
}
