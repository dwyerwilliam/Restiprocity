import type { TokenErrorCode } from '@shared/types';

/**
 * A failure getting a request's outputs. Its message is shown as written (it names outputs, the token request and
 * the field, never a value, a body or a resolved URL), unlike OAuth errors, whose text is replaced.
 */
export class TokenSourceError extends Error {
  constructor(readonly code: TokenErrorCode, message: string) {
    super(message);
    this.name = 'TokenSourceError';
  }
}

export function isTokenSourceError(error: unknown): error is TokenSourceError {
  if (error instanceof TokenSourceError) return true;
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('TOKEN_');
}
