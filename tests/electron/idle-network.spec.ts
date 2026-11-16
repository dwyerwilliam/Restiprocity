import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication } from 'playwright';
import { closeApp, expect, launchApp, test } from './fixtures/electronApp';

const repoRoot = path.resolve(__dirname, '..', '..');

interface NetLog {
  constants: { logEventTypes: Record<string, number> };
  events: Array<{ type: number; params?: Record<string, unknown> }>;
}

/** Chromium writes the log as it goes; one cut short by the exit still parses once it is closed off. */
function parseNetLog(text: string): NetLog {
  try {
    return JSON.parse(text) as NetLog;
  } catch {
    return JSON.parse(`${text.replace(/,\s*$/, '')}]}`) as NetLog;
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
}

/**
 * Every web request and host lookup the whole process made, from a NetLog recorded since launch. It covers all
 * sessions and Chromium's own services, not only what the page asked for.
 */
function networkActivity(log: NetLog): { requests: string[]; lookups: string[] } {
  const typeNames = new Map(Object.entries(log.constants.logEventTypes).map(([name, id]) => [id, name]));
  const requests = new Set<string>();
  const lookups = new Set<string>();
  for (const event of log.events) {
    const params = event.params ?? {};
    if (typeof params.url === 'string' && /^(https?|wss?):/i.test(params.url)) {
      let host = '';
      try { host = new URL(params.url).hostname; } catch { /* listed as it is */ }
      if (!isLoopback(host)) requests.add(params.url.slice(0, 200));
    }
    if (typeNames.get(event.type) === 'HOST_RESOLVER_MANAGER_REQUEST' && typeof params.host === 'string') {
      const host = params.host.replace(/^[a-z]+:\/\//i, '').replace(/:\d+$/, '');
      // "wpad" is the system's proxy auto-detection, which the app follows like any other program on the machine.
      if (!isLoopback(host) && host !== 'wpad' && !host.startsWith('wpad.')) lookups.add(host);
    }
  }
  return { requests: [...requests], lookups: [...lookups] };
}

/**
 * Local-first: the app sends the requests the user sends and nothing else. A new profile used to fetch a
 * spellcheck dictionary from Google's servers for each session (seen on Linux). A machine whose system proxy
 * setting names a PAC file on another host would list that file here; that is the system's setting, not the app's.
 */
test('the app starts no web request or host lookup of its own, and the spellchecker is off in every session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-idle-network-'));
  const netLogPath = path.join(dir, 'netlog.json');
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp({ args: ['.', `--log-net-log=${netLogPath}`], cwd: repoRoot,
      env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: path.join(dir, 'profile') } });
    const page = await app.firstWindow();
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 60_000 });

    const spellcheck = await app.evaluate(({ session, BrowserWindow }) => ({
      window: BrowserWindow.getAllWindows()[0].webContents.session.isSpellCheckerEnabled(),
      requests: session.fromPartition('restiprocity-api').isSpellCheckerEnabled(),
      insecureRequests: session.fromPartition('restiprocity-api-insecure').isSpellCheckerEnabled(),
      // A session nothing has asked for yet is restricted as it is created.
      later: session.fromPartition('restiprocity-test-later-session').isSpellCheckerEnabled(),
    }));
    // Soft, so a failure here still goes on to show what the process then fetched.
    expect.soft(spellcheck).toEqual({ window: false, requests: false, insecureRequests: false, later: false });

    // Typing is what would make a spellchecker load its dictionary.
    const url = page.locator('textarea[aria-label="Request URL"]');
    await url.click();
    await page.keyboard.type('mispeled wurds heer ');
    expect(await url.evaluate(element => (element as HTMLTextAreaElement).value)).toContain('mispeled');
    // The dictionary request went out within the first second of a new profile; leave room for anything slower.
    await page.waitForTimeout(4000);

    await closeApp(app);
    app = undefined;
    const activity = networkActivity(parseNetLog(await fs.readFile(netLogPath, 'utf-8')));
    expect(activity).toEqual({ requests: [], lookups: [] });
  } finally {
    if (app) await closeApp(app).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
