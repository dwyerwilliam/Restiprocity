import type { ResponseCookie } from '@shared/types';

const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

export function parseResponseCookies(lines: readonly string[], finalUrl: string, now: number): ResponseCookie[] {
  const url = new URL(finalUrl);
  const lastSlash = url.pathname.lastIndexOf('/');
  const defaultPath = lastSlash > 0 ? url.pathname.slice(0, lastSlash) : '/';
  const cookies: ResponseCookie[] = [];

  for (const line of lines) {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line) || /,\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=/.test(line)) continue;
    const [pair, ...attributes] = line.split(';');
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
    if (!cookieName.test(name) || !cookieValue.test(value)) continue;
    const cookie: ResponseCookie = {
      name, value, domain: url.hostname, path: defaultPath, httpOnly: false, secure: false, sameSite: 'lax',
    };
    let maxAge: number | undefined;
    for (const attribute of attributes) {
      const equals = attribute.indexOf('=');
      const key = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
      const attributeValue = equals < 0 ? '' : attribute.slice(equals + 1).trim();
      switch (key) {
        case 'domain':
          if (attributeValue) cookie.domain = attributeValue.replace(/^\./, '').toLowerCase();
          break;
        case 'path':
          if (attributeValue.startsWith('/')) cookie.path = attributeValue;
          break;
        case 'httponly': cookie.httpOnly = true; break;
        case 'secure': cookie.secure = true; break;
        case 'samesite': {
          const sameSite = attributeValue.toLowerCase();
          cookie.sameSite = sameSite === 'strict' || sameSite === 'none' ? sameSite : 'lax';
          break;
        }
        case 'expires': {
          const expires = Date.parse(attributeValue);
          if (Number.isFinite(expires)) cookie.expires = expires;
          break;
        }
        case 'max-age':
          if (/^-?\d+$/.test(attributeValue)) maxAge = Number(attributeValue);
          break;
      }
    }
    if (maxAge !== undefined) cookie.expires = maxAge <= 0 ? now : Math.min(now + maxAge * 1000, 8.64e15);
    cookies.push(cookie);
  }
  return cookies;
}

export function getNetSetCookieLines(headers: Record<string, string | string[] | undefined>): readonly string[] {
  const lines = headers['set-cookie'];
  return Array.isArray(lines) ? lines : [];
}
