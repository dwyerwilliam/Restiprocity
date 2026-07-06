import type { RequestError } from '@shared/types';

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

export class RequestFailureError extends Error {
  readonly requestError: RequestError;

  constructor(requestError: RequestError, cause: unknown) {
    super(requestError.message);
    this.name = 'RequestFailureError';
    this.requestError = requestError;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function classifyRequestFailure(error: unknown, url: string): RequestError {
  const rawMessage = formatRawMessage(error);
  const code = findErrorCode(error);
  const text = `${rawMessage} ${code ?? ''}`.toLowerCase();

  if (isCertificateError(text)) {
    return {
      kind: 'certificate',
      message: 'TLS certificate verification failed',
      rawMessage,
      code,
      url,
      retryable: false,
    };
  }

  if (isTimeoutError(error, text, code)) {
    return {
      kind: 'timeout',
      message: 'Request timed out before an HTTP response was received',
      rawMessage,
      code,
      url,
      retryable: true,
    };
  }

  if (isCancelledError(error, text)) {
    return {
      kind: 'cancelled',
      message: 'Request was cancelled before an HTTP response was received',
      rawMessage,
      code,
      url,
      retryable: false,
    };
  }

  return {
    kind: 'transport',
    message: 'Network request failed before an HTTP response was received',
    rawMessage,
    code,
    url,
    retryable: true,
  };
}

function formatRawMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;

  while (current) {
    const message = readMessage(current);
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
    current = readCause(current);
  }

  return parts.length > 0 ? parts.join(' | caused by: ') : String(error);
}

function findErrorCode(error: unknown): string | null {
  let current: unknown = error;

  while (current) {
    const code = readCode(current);
    if (code) {
      return code;
    }
    current = readCause(current);
  }

  return null;
}

function readMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message || value.name;
  }

  if (value && typeof value === 'object') {
    const message = (value as ErrorLike).message;
    if (typeof message === 'string' && message) {
      return message;
    }
  }

  if (typeof value === 'string') {
    return value;
  }

  return null;
}

function readCode(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const code = (value as ErrorLike).code;
    return typeof code === 'string' && code ? code : null;
  }

  return null;
}

function readCause(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as ErrorLike).cause : null;
}

function readName(value: unknown): string | null {
  if (value instanceof Error) {
    return value.name;
  }

  if (value && typeof value === 'object') {
    const name = (value as ErrorLike).name;
    return typeof name === 'string' ? name : null;
  }

  return null;
}

function isCertificateError(text: string): boolean {
  return /certificate|self-signed|cert_|err_cert|unable_to_verify|unable to verify|secure channel|ssl|tls|hostname\/ip does not match/.test(text);
}

function isTimeoutError(error: unknown, text: string, code: string | null): boolean {
  return readName(error) === 'TimeoutError' || code === 'ETIMEDOUT' || /timed?\s*out|timeout/.test(text);
}

function isCancelledError(error: unknown, text: string): boolean {
  return readName(error) === 'AbortError' || /cancelled|canceled|aborted/.test(text);
}
