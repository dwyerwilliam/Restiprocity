import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron, type ElectronApplication } from 'playwright';
import { expect, test } from '@playwright/test';

test('editor persists nested environments and restores selection after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-env-ui-'));
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    return app.firstWindow();
  };
  try {
    let page = await launch();
    await page.getByRole('button', { name: 'Create child environment', exact: true }).click();
    let editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-name').fill('Parent');
    await editor.getByLabel('Variable key 1').fill('token');
    await editor.getByLabel('Variable type 1').selectOption('secret');
    await editor.getByLabel('Variable value 1').fill('fixture-secret');
    await editor.getByRole('button', { name: 'Create Environment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Env: Parent' })).toBeVisible();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Create child environment', exact: true }).click();
    await editor.getByTestId('environment-editor-name').fill('Child');
    await expect(editor.getByTestId('environment-editor-inherited')).toContainText('token');
    await expect(editor.getByTestId('environment-editor-inherited')).not.toContainText('fixture-secret');
    await editor.getByRole('button', { name: 'Create Environment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Env: Child' })).toBeVisible();
    await editor.getByTestId('environment-editor-name').fill('Renamed Child');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: 'Env: Renamed Child' })).toBeVisible();
    const records = await page.evaluate(() => window.api.envList());
    const parent = records.find(env => env.name === 'Parent')!;
    const child = records.find(env => env.name === 'Renamed Child')!;
    expect(child.parentId).toBe(parent.id);
    expect(parent.variables).toEqual([{ key: 'token', value: 'fixture-secret', type: 'secret' }]);
    await expect(page.evaluate(id => window.api.envDelete(id), parent.id)).rejects.toThrow();
    await app!.close(); app = undefined;
    page = await launch();
    await expect(page.getByRole('button', { name: 'Env: Renamed Child' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    editor = page.getByTestId('environment-editor');
    await editor.getByTestId('environment-editor-tree-item-' + parent.id).click();
    await expect(editor.getByLabel('Variable value 1')).toHaveAttribute('type', 'password');
    await editor.getByRole('button', { name: 'Switch to environment' }).click();
    await expect(page.getByRole('button', { name: 'Env: Parent' })).toBeVisible();
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nested interpolation reaches a local server and cycles stop before send', async () => {
  const { startHttpFixture } = await import('./fixtures/nativeServers');
  const server = await startHttpFixture();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-nested-ui-'));
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Edit selected environment' }).click();
    const editor = page.getByTestId('environment-editor');
    await editor.getByLabel('Variable key 1').fill('host');
    await editor.getByLabel('Variable value 1').fill('127.0.0.1:' + server.port);
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 2').fill('base');
    await editor.getByLabel('Variable value 2').fill('http://{{host}}');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 3').fill('route');
    await editor.getByLabel('Variable value 3').fill('{{base}}/identity');
    await editor.getByTestId('environment-editor-add-variable').click();
    await editor.getByLabel('Variable key 4').fill('loop');
    await editor.getByLabel('Variable value 4').fill('{{loop}}');
    await editor.getByRole('button', { name: 'Save Changes' }).click();
    await expect(editor.getByRole('status')).toHaveText('Changes saved.');
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    const response = await page.evaluate(async () => {
      const now = Date.now();
      const request = { id: 'nested-native', name: 'Nested', method: 'GET' as const,
        url: '{{route}}', headers: [
          { key: 'User-Agent', value: '{{loop}}', enabled: true },
          { key: 'X-Replaced', value: '{{loop}}', enabled: true },
          { key: 'x-replaced', value: 'winner', enabled: true },
          { key: 'X-Disabled', value: '{{loop}}', enabled: false },
        ], parameters: [{ key: ' ', value: '{{loop}}', enabled: true }], body: { type: 'none' as const },
        auth: { type: 'none' as const }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: true },
        scripts: {}, createdAt: now, updatedAt: now };
      const first = await window.api.sendRequest({ operationId: 'nested-native-ok', request, environmentId: 'core' });
      const cycle = await window.api.sendRequest({ operationId: 'nested-native-cycle', request: { ...request, url: '{{loop}}' }, environmentId: 'core' });
      return { first, cycle };
    });
    expect(response.first.kind).toBe('response');
    expect(response.cycle).toMatchObject({ kind: 'failed', error: { kind: 'interpolation', code: 'INTERPOLATION_ERROR' } });
    expect(server.observations.map(item => item.path)).toEqual(['/identity']);
  } finally {
    if (app) await app.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('correction plan end-to-end: imported Staging, large literal body, and unused cycles', async () => {
  const { startHttpFixture } = await import('./fixtures/nativeServers');
  const server = await startHttpFixture();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-interpolation-e2e-'));
  const importPath = path.join(dir, 'insomnia.yaml');
  await fs.copyFile(path.resolve(__dirname, '../engine/fixtures/insomnia-v5-collection.yaml'), importPath);
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '../..'), env: { ...process.env, RESTIPROCITY_TEST_USER_DATA: dir } });
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filePath] })) as typeof dialog.showOpenDialog;
    }, importPath);
    const page = await app.firstWindow();
    const imported = await page.evaluate(() => window.api.importCollectionFile());
    expect(imported).toMatchObject({ imported: true, environments: 3 });
    const environments = await page.evaluate(() => window.api.envList());
    const base = environments.find(environment => environment.name === 'Shop API');
    const staging = environments.find(environment => environment.name === 'Staging');
    expect(base).toBeDefined();
    expect(staging?.parentId).toBe(base?.id);
    await page.evaluate(({ id, port, variables }) => window.api.envUpdate(id, {
      variables: [...variables, { key: 'base_url', value: 'http://127.0.0.1:' + port, type: 'standard' }, { key: 'loop', value: '{{loop}}', type: 'standard' }],
    }), { id: base!.id, port: server.port, variables: base!.variables.filter(variable => variable.key !== 'base_url' && variable.key !== 'loop') });

    const now = Date.now();
    const importedRequest = { id: 'imported-staging-e2e', name: 'Imported staging', method: 'GET' as const, url: '{{base_url}}', headers: [], parameters: [], body: { type: 'none' as const }, auth: { type: 'none' as const }, settings: { followRedirect: true, timeout: 5000, cookiesEnabled: false }, scripts: {}, createdAt: now, updatedAt: now };
    const first = await page.evaluate(({ request, environmentId }) => window.api.sendRequest({ operationId: 'imported-staging-e2e', request, environmentId }), { request: importedRequest, environmentId: staging!.id });
    expect(first.kind).toBe('response');
    expect(server.observations.at(-1)?.path).toBe('/staging');
    const curl = await page.evaluate(({ request, environmentId }) => window.api.copyRequestAsCurl({ request, environmentId }), { request: importedRequest, environmentId: staging!.id });
    expect(curl.copied).toBe(true);
    expect(curl.command).toContain("'http://127.0.0.1:" + server.port + "/staging'");
    expect(server.observations).toHaveLength(1);

    const largeBody = 'literal-body-'.padEnd(1024 * 1024 + 128, 'x');
    const largeRequest = { ...importedRequest, id: 'large-literal-e2e', method: 'POST' as const, url: 'http://127.0.0.1:' + server.port + '/large', headers: [{ key: 'Content-Type', value: 'text/plain', enabled: true }], body: { type: 'raw' as const, raw: { language: 'text' as const, content: largeBody } } };
    const largeResponse = await page.evaluate(({ request, environmentId }) => window.api.sendRequest({ operationId: 'large-literal-e2e', request, environmentId }), { request: largeRequest, environmentId: staging!.id });
    expect(largeResponse.kind).toBe('response');
    const largeObservation = server.observations.find(observation => observation.path === '/large');
    expect(largeObservation).toMatchObject({ bodyLength: largeBody.length, bodySha256: createHash('sha256').update(largeBody).digest('hex') });
    const largeCurl = await page.evaluate(({ request, environmentId }) => window.api.copyRequestAsCurl({ request, environmentId }), { request: largeRequest, environmentId: staging!.id });
    expect(largeCurl.copied).toBe(true);
    expect(largeCurl.command.length).toBeGreaterThan(1024 * 1024);

    const unusedCycle = { ...importedRequest, id: 'unused-cycle-e2e', url: 'http://127.0.0.1:' + server.port + '/unused', headers: [{ key: 'X-Cycle', value: '{{loop}}', enabled: false }], parameters: [{ key: ' ', value: '{{loop}}', enabled: true }], scripts: { preRequest: '{{loop}}' } };
    const beforeUnused = server.observations.length;
    const unusedResponse = await page.evaluate(({ request, environmentId }) => window.api.sendRequest({ operationId: 'unused-cycle-e2e', request, environmentId }), { request: unusedCycle, environmentId: staging!.id });
    expect(unusedResponse.kind).toBe('response');
    expect(server.observations.length).toBe(beforeUnused + 1);
    const unusedCurl = await page.evaluate(({ request, environmentId }) => window.api.copyRequestAsCurl({ request, environmentId }), { request: unusedCycle, environmentId: staging!.id });
    expect(unusedCurl.copied).toBe(true);
    const enabledCycle = { ...unusedCycle, headers: [{ key: 'X-Cycle', value: '{{loop}}', enabled: true }] };
    await expect(page.evaluate(({ request, environmentId }) => window.api.sendRequest({ operationId: 'enabled-cycle-e2e', request, environmentId }), { request: enabledCycle, environmentId: staging!.id })).resolves.toMatchObject({ kind: 'failed', error: { kind: 'interpolation' } });
    expect(server.observations.length).toBe(beforeUnused + 1);
  } finally {
    if (app) await app.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
