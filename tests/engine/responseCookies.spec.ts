import { expect, test } from '@playwright/test';
import { getNetSetCookieLines, parseResponseCookies } from '../../src/main/engine/responseCookies';

const now = 1_700_000_000_000;
const url = 'https://final.example.test/folder/leaf?query=1';

test('complete lines preserve Expires commas and duplicate names with independent paths', () => {
  const lines = [
    'id=first; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; Secure; SameSite=Strict',
    'id=second; Domain=.Example.TEST; Path=/other; SameSite=None',
    'session="quoted=content"',
  ];
  const cookies = parseResponseCookies(lines, url, now);
  expect(cookies).toEqual([
    { name: 'id', value: 'first', domain: 'final.example.test', path: '/folder',
      expires: 2139722880000, httpOnly: true, secure: true, sameSite: 'strict' },
    { name: 'id', value: 'second', domain: 'example.test', path: '/other', httpOnly: false, secure: false, sameSite: 'none' },
    { name: 'session', value: 'quoted=content', domain: 'final.example.test', path: '/folder', httpOnly: false, secure: false, sameSite: 'lax' },
  ]);
  expect(lines[0]).toContain('Wed, 21 Oct');
});

for (const line of [
  'id=value; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
  'id=value; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=60',
]) {
  test(`Max-Age takes precedence in milliseconds: ${line}`, () => {
    expect(parseResponseCookies([line], url, now)[0].expires).toBe(now + 60_000);
  });
}

test('deletion and expired cookies remain observations rather than jar inventory', () => {
  const cookies = parseResponseCookies([
    'id=; Max-Age=0', 'id=deleted; Max-Age=-100', 'old=value; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
  ], url, now);
  expect(cookies.map(({ name, value, expires }) => ({ name, value, expires }))).toEqual([
    { name: 'id', value: '', expires: now }, { name: 'id', value: 'deleted', expires: now },
    { name: 'old', value: 'value', expires: 1445412480000 },
  ]);
});

for (const [pathname, expected] of [['/', '/'], ['/leaf', '/'], ['/folder/', '/folder'], ['/a/b/c', '/a/b']]) {
  test(`RFC default path for ${pathname}`, () => {
    const [cookie] = parseResponseCookies(['id=value; Path=invalid; SameSite=invalid; Expires=bad; Max-Age=1.5'], `https://host.test${pathname}`, now);
    expect(cookie).toEqual({ name: 'id', value: 'value', domain: 'host.test', path: expected, httpOnly: false, secure: false, sameSite: 'lax' });
  });
}

test('malformed cookie lines and inseparable combined headers are skipped without discarding valid neighbors', () => {
  const cookies = parseResponseCookies([
    '', 'missing-equals', '=missing-name', 'bad name=value', 'control=bad\r\nvalue', 'id=bad,value',
    'id=one, other=two', 'id=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT, other=two',
    'id=one; Path=/, other=two', 'good=kept; Unknown=ignored',
  ], url, now);
  expect(cookies.map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'good', value: 'kept' }]);
});

test('invalid Max-Age falls back to Expires and oversized valid ages remain finite', () => {
  const cookies = parseResponseCookies([
    'id=one; Max-Age=invalid; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
    `id=two; Max-Age=${'9'.repeat(400)}`,
  ], url, now);
  expect(cookies.map(({ expires }) => expires)).toEqual([2139722880000, 8.64e15]);
});

test('native extraction never treats a joined header as a complete cookie array', () => {
  expect(getNetSetCookieLines({ 'set-cookie': 'id=one, other=two' })).toEqual([]);
  expect(getNetSetCookieLines({ 'set-cookie': ['id=one', 'other=two'] })).toEqual(['id=one', 'other=two']);
  expect(getNetSetCookieLines({})).toEqual([]);
});
