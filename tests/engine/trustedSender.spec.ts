import { expect, test } from '@playwright/test';
import { assertAppPageSender, createAppPageCheck, isAppPageSender } from '../../src/main/ipc/trustedSender';

test('the packaged page is recognised by path, whatever the URL spelling', () => {
  const windows = createAppPageCheck({ indexPath: 'C:\\Program Files\\Restiprocity\\resources\\app.asar\\dist\\index.html', platform: 'win32' });
  expect(windows('file:///C:/Program%20Files/Restiprocity/resources/app.asar/dist/index.html')).toBe(true);
  expect(windows('file:///c:/program%20files/restiprocity/resources/app.asar/dist/index.html?x#y')).toBe(true);
  expect(windows('file:///C:/Program%20Files/Restiprocity/resources/app.asar/dist/other.html')).toBe(false);
  expect(windows('file:///C:/Program%20Files/Restiprocity/resources/app.asar/dist/index.html/../../evil.html')).toBe(false);
  expect(windows('file:///C:/Users/someone/Downloads/index.html')).toBe(false);
  expect(windows('file://server/share/dist/index.html')).toBe(false);

  const posix = createAppPageCheck({ indexPath: '/opt/Restiprocity/resources/app.asar/dist/index.html', platform: 'linux' });
  expect(posix('file:///opt/Restiprocity/resources/app.asar/dist/index.html')).toBe(true);
  expect(posix('file:///opt/restiprocity/resources/app.asar/dist/index.html')).toBe(false);
  expect(posix('file:///tmp/index.html')).toBe(false);

  const accented = createAppPageCheck({ indexPath: 'C:\\Users\\Zoë Ünal\\app\\dist\\index.html', platform: 'win32' });
  expect(accented('file:///C:/Users/Zo%C3%AB%20%C3%9Cnal/app/dist/index.html')).toBe(true);

  for (const url of ['https://example.com/index.html', 'data:text/html,<p>hi</p>', 'about:blank', 'devtools://devtools/x', '', 'not a url']) {
    expect(windows(url), url).toBe(false);
  }
});

test('while developing, only the dev server origin is the app page', () => {
  const check = createAppPageCheck({ indexPath: '/repo/dist/index.html', devServerUrl: 'http://localhost:5173/', platform: 'linux' });
  expect(check('http://localhost:5173/')).toBe(true);
  expect(check('http://localhost:5173/index.html?x=1')).toBe(true);
  expect(check('http://localhost:5174/')).toBe(false);
  expect(check('http://127.0.0.1:5173/')).toBe(false);
  expect(check('https://localhost:5173/')).toBe(false);
  expect(check('file:///repo/dist/index.html')).toBe(false);
});

test('only the top frame of the app page is answered', () => {
  const isAppPage = createAppPageCheck({ indexPath: '/app/dist/index.html', platform: 'linux' });
  const appUrl = 'file:///app/dist/index.html';
  expect(isAppPageSender({ senderFrame: { url: appUrl, parent: null } }, isAppPage)).toBe(true);
  // A frame inside the page, a page that is not the app, and a frame that no longer exists.
  expect(isAppPageSender({ senderFrame: { url: appUrl, parent: { url: appUrl } } }, isAppPage)).toBe(false);
  expect(isAppPageSender({ senderFrame: { url: 'https://example.com/', parent: null } }, isAppPage)).toBe(false);
  expect(isAppPageSender({ senderFrame: null }, isAppPage)).toBe(false);
  expect(() => assertAppPageSender({ senderFrame: null }, isAppPage)).toThrow('This call must come from the application page.');
  expect(() => assertAppPageSender({ senderFrame: { url: appUrl, parent: null } }, isAppPage)).not.toThrow();
});
