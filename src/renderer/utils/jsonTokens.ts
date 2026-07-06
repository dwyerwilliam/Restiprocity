export type JsonTokenType = 'string' | 'number' | 'boolean' | 'null' | 'structural' | 'whitespace';

export interface JsonToken {
  type: JsonTokenType;
  value: string;
  isKey?: boolean;
}

function findStringEnd(text: string, start: number): number {
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      return i;
    }
  }

  return text.length - 1;
}

export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < text.length && /\s/.test(text[end])) {
        end += 1;
      }
      tokens.push({ type: 'whitespace', value: text.slice(index, end) });
      index = end;
      continue;
    }

    if (char === '"') {
      const endQuote = findStringEnd(text, index + 1);
      const token = text.slice(index, endQuote + 1);
      let lookahead = endQuote + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      const isKey = text[lookahead] === ':';
      tokens.push({ type: 'string', value: token, isKey });
      index = endQuote + 1;
      continue;
    }

    if ('{}[]:,.'.includes(char)) {
      tokens.push({ type: 'structural', value: char });
      index += 1;
      continue;
    }

    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }

    const literalMatch = text.slice(index).match(/^(true|false|null)\b/);
    if (literalMatch) {
      tokens.push({ type: literalMatch[0] as 'boolean' | 'null', value: literalMatch[0] });
      index += literalMatch[0].length;
      continue;
    }

    tokens.push({ type: 'whitespace', value: char });
    index += 1;
  }

  return tokens;
}

export function tokenClass(token: JsonToken): string {
  if (token.type === 'string') {
    return token.isKey ? 'text-[var(--color-json-key)]' : 'text-[var(--color-json-value)]';
  }

  if (token.type === 'structural') {
    return 'text-[var(--color-json-structural)]';
  }

  if (token.type === 'number') {
    return 'text-[var(--color-json-number)]';
  }

  if (token.type === 'boolean') {
    return 'text-[var(--color-json-boolean)]';
  }

  if (token.type === 'null') {
    return 'text-[var(--color-json-null)]';
  }

  return '';
}


