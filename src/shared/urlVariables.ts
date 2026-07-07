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
