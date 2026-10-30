import type { ResponseV2 } from '../../../src/shared/types';

export function liveCookieResponse(): ResponseV2 {
  return {
    version: 2,
    id: 'cookie-response',
    requestId: 'req-1',
    status: 200,
    statusText: 'OK',
    headers: [
      { key: 'Content-Type', value: 'text/plain', enabled: true },
      { key: 'Set-Cookie', value: 'session=live-cookie-marker', enabled: true },
      { key: 'sEt-CoOkIe', value: 'other=live-cookie-marker', enabled: false },
      { key: 'COOKIE', value: 'session=live-cookie-marker', enabled: true },
      { key: 'cookie', value: 'other=live-cookie-marker', enabled: false },
      { key: 'X-Unrelated', value: 'preserved', enabled: false },
    ],
    cookies: [{ name: 'session', value: 'live-cookie-marker', domain: 'example.test', path: '/', httpOnly: true, secure: true, sameSite: 'strict' }],
    preview: {
      kind: 'text', format: 'text', text: 'live-cookie-marker', parseState: 'not-applicable',
      charset: 'utf-8', decodeError: false, capturedBytes: 18, totalBytes: 18,
      truncated: false, completeness: 'complete',
    },
    timings: { dns: 0, tcp: 0, tls: 0, ttfb: 1, download: 0, total: 1 },
    timestamp: 1,
    size: 18,
  };
}
