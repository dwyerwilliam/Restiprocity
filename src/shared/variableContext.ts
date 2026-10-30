import { expandUrlVariableShorthand } from './urlVariables';

export type BuiltInVariableValues = {
  readonly timestamp: number;
  readonly randomInt: number;
  readonly uuid: string;
};

export type VariableContext = {
  readonly interpolateString: (value: string) => string;
  readonly interpolate: <T>(value: T) => T;
};

export function createVariableContext(
  inheritedVariables: Iterable<readonly [string, string]>,
  builtIns: BuiltInVariableValues,
): VariableContext {
  const variables = new Map<string, string>([
    ...inheritedVariables,
    ['timestamp', String(builtIns.timestamp)],
    ['randomInt', String(builtIns.randomInt)],
    ['uuid', builtIns.uuid],
  ]);
  const knownKeys = new Set(variables.keys());

  function interpolateString(value: string): string {
    return expandUrlVariableShorthand(value, { knownKeys, includeTrailingUnknown: true })
      .replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match: string, key: string) => variables.get(key) ?? match);
  }

  function interpolate<T>(value: T): T;
  function interpolate(value: unknown): unknown {
    if (typeof value === 'string') return interpolateString(value);
    if (Array.isArray(value)) return value.map((entry: unknown) => interpolate(entry));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]: [string, unknown]) => [key, interpolate(entry)]));
    }
    return value;
  }

  return Object.freeze({ interpolateString, interpolate });
}
