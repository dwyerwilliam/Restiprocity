import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ElectronApplication, type Page } from 'playwright';
import { closeApp, expect, launchApp, test } from './fixtures/electronApp';
import { startHttpFixture } from './fixtures/nativeServers';

const repoRoot = path.resolve(__dirname, '..', '..');

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof (window as any).api?.envStorageStatus === 'function', undefined, { timeout: 60_000 });
  return { app, page };
}

function request(id: string, url: string, headers: Array<{ key: string; value: string; enabled: boolean }>) {
  const now = Date.now();
  return {
    id, name: id, method: 'GET' as const, url, headers, parameters: [], body: { type: 'none' as const }, auth: { type: 'none' as const },
    settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true }, scripts: {}, createdAt: now, updatedAt: now,
  };
}

/** Records what Copy as cURL writes to the clipboard in the main process, without touching the shared system clipboard. */
async function clipboardWrites(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as any).__secretCurlWrites as string[]);
}

async function interceptClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    (globalThis as any).__secretCurlWrites = [];
    clipboard.writeText = (value: string) => { (globalThis as any).__secretCurlWrites.push(value); };
  });
}

test('secret variables are encrypted at rest, sent to the server, and gated behind an explicit cURL copy when a keyring is available', async () => {
  const server = await startHttpFixture();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-secret-vars-'));
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(dir));
    const page = await app.firstWindow();
    const status = await page.evaluate(() => window.api.envStorageStatus());
    test.skip(!status.available, `No usable OS keyring on this machine (${status.backend}); the unavailable-provider test covers this platform.`);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const created = await page.evaluate((url) => window.api.envCreate({
      name: 'Vault',
      variables: [
        { key: 'baseUrl', value: url, type: 'standard' },
        { key: 'apiSecret', value: 'native-secret-value', type: 'secret' },
        { key: 'partner', value: 'native-confidential-value', type: 'confidential' },
      ],
    }), baseUrl);

    // The renderer-facing list never carries values for secret or confidential variables.
    const listed = (await page.evaluate(() => window.api.envList())).find(env => env.id === created.id)!;
    expect(JSON.stringify(listed)).not.toContain('native-secret-value');
    expect(JSON.stringify(listed)).not.toContain('native-confidential-value');

    // At rest: the secret is ciphertext, the confidential value is plain text by design, and neither leaks elsewhere.
    const onDisk = await fs.readFile(path.join(dir, 'environments', `${created.id}.json`), 'utf-8');
    expect(onDisk).not.toContain('native-secret-value');
    const diskVariables = JSON.parse(onDisk).variables as Array<{ key: string; type: string; value: string; encrypted?: { version: number; bound?: string } }>;
    expect(diskVariables.find(v => v.key === 'apiSecret')?.encrypted).toMatchObject({ version: 2 });
    expect(diskVariables.find(v => v.key === 'partner')).toMatchObject({ type: 'confidential', value: 'native-confidential-value' });

    // A send with the secret reaches the server with the real value.
    const sent = await page.evaluate(({ req, environmentId }) => window.api.sendRequest({ operationId: 'secret-send', request: req, environmentId }), {
      req: request('secret-send', `{{baseUrl}}/identity`, [{ key: 'Authorization', value: 'Bearer {{apiSecret}}', enabled: true }]),
      environmentId: created.id,
    });
    expect(sent.kind).toBe('response');
    expect(server.observations.at(-1)).toMatchObject({ path: '/identity', authorization: 'Bearer native-secret-value' });

    // Copy as cURL is refused until the user confirms that the command holds secret values.
    await interceptClipboard(app);
    const secretRequest = request('secret-curl', '{{baseUrl}}/identity', [{ key: 'Authorization', value: 'Bearer {{apiSecret}}', enabled: true }]);
    const first = await page.evaluate(({ req, environmentId }) => window.api.copyRequestAsCurl({ request: req, environmentId }), { req: secretRequest, environmentId: created.id });
    expect(first).toMatchObject({ copied: false, requiresConfirmation: true });
    expect(await clipboardWrites(app)).toEqual([]);

    const confirmed = await page.evaluate(({ req, environmentId }) => window.api.copyRequestAsCurl({ request: req, environmentId, confirmSensitive: true }), { req: secretRequest, environmentId: created.id });
    expect(confirmed).toMatchObject({ copied: true });
    const writes = await clipboardWrites(app);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('native-secret-value');

    // A request that uses no secret copies without the gate.
    const plain = await page.evaluate(({ req, environmentId }) => window.api.copyRequestAsCurl({ request: req, environmentId }), {
      req: request('plain-curl', '{{baseUrl}}/identity', []),
      environmentId: created.id,
    });
    expect(plain).toMatchObject({ copied: true });
    expect(await clipboardWrites(app)).toHaveLength(2);
    expect(server.observations.filter(item => item.path === '/identity')).toHaveLength(1);

    // The stored secret copied under another key in the file (by something that can write it but not decrypt it)
    // is not used there: no reveal, and a send that names it stops before the network.
    const stored = JSON.parse(onDisk);
    stored.variables.push({ key: 'copied', value: diskVariables.find(v => v.key === 'apiSecret')!.value, type: 'secret', encrypted: diskVariables.find(v => v.key === 'apiSecret')!.encrypted });
    await fs.writeFile(path.join(dir, 'environments', `${created.id}.json`), JSON.stringify(stored, null, 2), 'utf-8');
    await page.evaluate(id => window.api.envSetEditing(id), created.id);
    await expect(page.evaluate(id => window.api.envRevealSecret({ environmentId: id, key: 'copied' }), created.id))
      .rejects.toThrow(/encrypted for a different variable or environment/);
    expect(await page.evaluate(id => window.api.envRevealSecret({ environmentId: id, key: 'apiSecret' }), created.id)).toBe('native-secret-value');
    const refused = await page.evaluate(({ req, environmentId }) => window.api.sendRequest({ operationId: 'copied-send', request: req, environmentId }), {
      req: request('copied-send', `{{baseUrl}}/identity`, [{ key: 'Authorization', value: 'Bearer {{copied}}', enabled: true }]),
      environmentId: created.id,
    });
    expect(refused).toMatchObject({ kind: 'failed', error: { kind: 'interpolation' } });
    expect(JSON.stringify(refused)).toContain('encrypted for a different variable or environment');
    expect(server.observations.filter(item => item.path === '/identity')).toHaveLength(1);
  } finally {
    if (app) await closeApp(app);
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('without a usable keyring a secret is refused with an actionable error, nothing is written, and plain environments still save', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-secret-unavailable-'));
  let app: ElectronApplication | undefined;
  try {
    ({ app } = await launch(dir));
    const page = await app.firstWindow();
    const status = await page.evaluate(() => window.api.envStorageStatus());
    test.skip(status.available, 'A usable OS keyring is present; the encrypted-at-rest test covers this platform.');

    await expect(page.evaluate(() => window.api.envCreate({
      name: 'Refused',
      variables: [{ key: 'apiSecret', value: 'should-not-persist', type: 'secret' }],
    }))).rejects.toThrow(/unavailable/i);
    const names = (await page.evaluate(() => window.api.envList())).map(env => env.name);
    expect(names).not.toContain('Refused');
    const files = await fs.readdir(path.join(dir, 'environments')).catch(() => [] as string[]);
    for (const file of files) {
      expect(await fs.readFile(path.join(dir, 'environments', file), 'utf-8')).not.toContain('should-not-persist');
    }

    const plain = await page.evaluate(() => window.api.envCreate({
      name: 'Plain',
      variables: [{ key: 'baseUrl', value: 'https://example.test', type: 'standard' }],
    }));
    expect(plain.name).toBe('Plain');
  } finally {
    if (app) await closeApp(app);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
