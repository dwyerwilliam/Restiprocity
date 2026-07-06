import { expect, test } from '@playwright/test';
import { classifyRequestFailure } from '../../src/main/engine/requestErrors';

test.describe('Request engine failure classification', () => {
  test('classifies certificate errors with raw cause and code', () => {
    const cause = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    const error = new TypeError('fetch failed', { cause });

    expect(classifyRequestFailure(error, 'https://self-signed.example.test')).toEqual({
      kind: 'certificate',
      message: 'TLS certificate verification failed',
      rawMessage: 'fetch failed | caused by: self-signed certificate',
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      url: 'https://self-signed.example.test',
      retryable: false,
    });
  });

  test('classifies generic transport errors with raw cause and code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    const error = new TypeError('fetch failed', { cause });

    expect(classifyRequestFailure(error, 'https://api.example.test')).toEqual({
      kind: 'transport',
      message: 'Network request failed before an HTTP response was received',
      rawMessage: 'fetch failed | caused by: connect ECONNREFUSED 127.0.0.1:9',
      code: 'ECONNREFUSED',
      url: 'https://api.example.test',
      retryable: true,
    });
  });
});
