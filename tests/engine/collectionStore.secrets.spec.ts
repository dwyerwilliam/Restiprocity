import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { MockSafeStorageAdapter } from '../../src/main/crypto/safeStorageAdapter';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { OAuthService } from '../../src/main/oauth/oauthService';
import type { Environment, Request } from '../../src/shared/types';

async function withStore(
  run: (store: CollectionStore, userDataPath: string, adapter: MockSafeStorageAdapter) => Promise<void>,
  adapterOptions: { available?: boolean; backend?: string } = {},
) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-sec-'));
  const adapter = new MockSafeStorageAdapter(adapterOptions);

  try {
    const store = new CollectionStore(userDataPath, undefined, undefined, adapter);
    await run(store, userDataPath, adapter);
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

test.describe('CollectionStore OS-encrypted secret storage', () => {
  test('encrypts secret variables at rest while keeping confidential and standard in plaintext', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      const created = await store.createEnvironment({
        name: 'Staging',
        variables: [
          { key: 'baseUrl', value: 'https://api.example.com', type: 'standard' },
          { key: 'confToken', value: 'confidential_plain_123', type: 'confidential' },
          { key: 'apiKey', value: 'super_secret_456', type: 'secret' },
        ],
      });

      // listEnvironments returns masked values for confidential and secret
      expect(created.variables).toEqual([
        { key: 'baseUrl', value: 'https://api.example.com', type: 'standard' },
        { key: 'confToken', value: '••••••••', type: 'confidential' },
        { key: 'apiKey', value: '••••••••', type: 'secret' },
      ]);

      // Inspect disk file directly
      const envFilePath = path.join(userDataPath, 'environments', `${created.id}.json`);
      const diskContent = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));

      const standardOnDisk = diskContent.variables.find((v: any) => v.key === 'baseUrl');
      const confidentialOnDisk = diskContent.variables.find((v: any) => v.key === 'confToken');
      const secretOnDisk = diskContent.variables.find((v: any) => v.key === 'apiKey');

      expect(standardOnDisk.value).toBe('https://api.example.com');
      expect(confidentialOnDisk.value).toBe('confidential_plain_123');
      expect(confidentialOnDisk.type).toBe('confidential');

      // Secret must be masked and carry versioned ciphertext on disk
      expect(secretOnDisk.value).toBe('••••••••');
      expect(secretOnDisk.type).toBe('secret');
      expect(secretOnDisk.encrypted).toMatchObject({
        version: 1,
        cipher: expect.any(String),
      });

      // Decrypted internal representation for RequestEngine
      const internalEnv = await store.getEnvironment(created.id);
      expect(internalEnv?.variables.find(v => v.key === 'apiKey')?.value).toBe('super_secret_456');

      // Reveal secret via IPC method
      const revealedSecret = await store.revealSecret(created.id, 'apiKey');
      expect(revealedSecret).toBe('super_secret_456');
    });
  });

  test('preserves existing ciphertext when updating environment with masked placeholder', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      const created = await store.createEnvironment({
        name: 'Production',
        variables: [
          { key: 'dbPass', value: 'initial_secret_token', type: 'secret' },
        ],
      });

      const envFilePath = path.join(userDataPath, 'environments', `${created.id}.json`);
      const diskBefore = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));
      const originalCipher = diskBefore.variables[0].encrypted.cipher;

      // Update environment name and keep masked '••••••••' value
      await store.updateEnvironment(created.id, {
        name: 'Production Renamed',
        variables: [
          { key: 'dbPass', value: '••••••••', type: 'secret' },
        ],
      });

      const diskAfter = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));
      expect(diskAfter.name).toBe('Production Renamed');
      expect(diskAfter.variables[0].encrypted.cipher).toBe(originalCipher);

      // Decryption still produces the original secret
      const decrypted = await store.revealSecret(created.id, 'dbPass');
      expect(decrypted).toBe('initial_secret_token');
    });
  });

  test('re-encrypts when updating secret with a new plaintext value', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      const created = await store.createEnvironment({
        name: 'Staging',
        variables: [
          { key: 'apiKey', value: 'first_key', type: 'secret' },
        ],
      });

      const envFilePath = path.join(userDataPath, 'environments', `${created.id}.json`);
      const diskBefore = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));
      const originalCipher = diskBefore.variables[0].encrypted.cipher;

      // Update secret with a new plaintext string
      await store.updateEnvironment(created.id, {
        variables: [
          { key: 'apiKey', value: 'rotated_new_key', type: 'secret' },
        ],
      });

      const diskAfter = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));
      expect(diskAfter.variables[0].encrypted.cipher).not.toBe(originalCipher);

      const decrypted = await store.revealSecret(created.id, 'apiKey');
      expect(decrypted).toBe('rotated_new_key');
    });
  });

  test('converts secret to confidential or standard by decrypting to plaintext', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      const created = await store.createEnvironment({
        name: 'Staging',
        variables: [
          { key: 'tokenA', value: 'secret_value_A', type: 'secret' },
          { key: 'tokenB', value: 'secret_value_B', type: 'secret' },
        ],
      });

      // Convert tokenA to confidential and tokenB to standard, keeping masked placeholder in payload
      await store.updateEnvironment(created.id, {
        variables: [
          { key: 'tokenA', value: '••••••••', type: 'confidential' },
          { key: 'tokenB', value: '••••••••', type: 'standard' },
        ],
      });

      const envFilePath = path.join(userDataPath, 'environments', `${created.id}.json`);
      const diskContent = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));

      const varA = diskContent.variables.find((v: any) => v.key === 'tokenA');
      const varB = diskContent.variables.find((v: any) => v.key === 'tokenB');

      expect(varA).toEqual({ key: 'tokenA', value: 'secret_value_A', type: 'confidential' });
      expect(varB).toEqual({ key: 'tokenB', value: 'secret_value_B', type: 'standard' });
    });
  });

  test('handles legacy unencrypted secrets and migrates them to OS encryption', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();

      // Seed a legacy environment file with unencrypted secret (v0.2.18 / v0.3.0 pre-safeStorage format)
      const legacyEnv = {
        id: 'legacy-env',
        name: 'Legacy Environment',
        variables: [
          { key: 'legacySecret', value: 'legacy_plain_secret_999', type: 'secret' },
          { key: 'normalVar', value: 'hello', type: 'standard' },
        ],
        createdAt: 1000,
        updatedAt: 1000,
      };
      const envFilePath = path.join(userDataPath, 'environments', 'legacy-env.json');
      await fs.writeFile(envFilePath, JSON.stringify(legacyEnv, null, 2), 'utf-8');

      // listEnvironments recognizes legacy unencrypted secrets
      const envs = await store.listEnvironments();
      const loadedLegacy = envs.find(e => e.id === 'legacy-env');
      // Plaintext on disk, so it reads as Confidential until a migration encrypts it.
      expect(loadedLegacy?.variables.find(v => v.key === 'legacySecret')).toMatchObject({
        key: 'legacySecret',
        value: '••••••••',
        type: 'confidential',
        legacyUnencrypted: true,
      });

      // Migration encrypts the legacy secret
      const migrationResult = await store.migrateSecrets('legacy-env');
      expect(migrationResult).toEqual({
        migratedCount: 1,
        failedCount: 0,
        errors: [],
      });

      // Disk file is now encrypted with version 1 envelope
      const migratedDisk = JSON.parse(await fs.readFile(envFilePath, 'utf-8'));
      const migratedVar = migratedDisk.variables.find((v: any) => v.key === 'legacySecret');
      expect(migratedVar.value).toBe('••••••••');
      expect(migratedVar.legacyUnencrypted).toBeUndefined();
      expect(migratedVar.encrypted).toMatchObject({
        version: 1,
        cipher: expect.any(String),
      });

      // Reveal decrypts the migrated secret accurately
      const revealed = await store.revealSecret('legacy-env', 'legacySecret');
      expect(revealed).toBe('legacy_plain_secret_999');
    });
  });

  test('throws actionable error when OS encryption is unavailable', async () => {
    await withStore(async (store) => {
      await store.init();

      await expect(store.createEnvironment({
        name: 'UnavailableEnv',
        variables: [
          { key: 'secretKey', value: 'my_secret', type: 'secret' },
        ],
      })).rejects.toThrow(/OS secret encryption is unavailable/);
    }, { available: false, backend: 'mock-unavailable' });
  });

  test('undecryptable secret fails only when referenced by the request, not when unused', async () => {
    await withStore(async (store, _userDataPath, adapter) => {
      await store.init();

      const env = await store.createEnvironment({
        name: 'MixedEnv',
        variables: [
          { key: 'goodVar', value: 'good_value', type: 'standard' },
          { key: 'brokenSecret', value: 'broken_secret', type: 'secret' },
        ],
      });

      // Simulate safeStorage decryption failure (e.g. copied from another OS machine or corrupt key)
      adapter.failDecryption = true;

      const dummySession: any = {
        webRequest: { onBeforeSendHeaders: () => {} },
      };
      const oauthService = new OAuthService();
      const engine = new RequestEngine(dummySession, store, {}, {}, oauthService);

      // Request that does NOT reference the broken secret succeeds in variable resolution
      const reqWithoutSecret: Request = {
        id: 'req-1',
        name: 'Unrelated Send',
        method: 'GET',
        url: 'https://example.com/api?param={{goodVar}}',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000 },
        scripts: {},
        createdAt: 1,
        updatedAt: 1,
      };

      // Export cURL verifies interpolation without performing network I/O
      const curlWithoutSecret = await engine.exportCurl({ request: reqWithoutSecret, environmentId: env.id });
      expect(curlWithoutSecret.command).toContain('param=good_value');

      // Request that DOES reference the broken secret fails before network I/O
      const reqWithSecret: Request = {
        id: 'req-2',
        name: 'Secret Send',
        method: 'GET',
        url: 'https://example.com/api?secret={{brokenSecret}}',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000 },
        scripts: {},
        createdAt: 1,
        updatedAt: 1,
      };

      await expect(engine.exportCurl({ request: reqWithSecret, environmentId: env.id }))
        .rejects.toThrow(/secret "brokenSecret" cannot be decrypted/);
    });
  });
});

test.describe('confidential values survive an edit without reveal', () => {
  test('saving an environment whose confidential value was never revealed keeps the stored value', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const created = await store.createEnvironment({
        name: 'Conf',
        variables: [{ key: 'confToken', value: 'confidential_plain_123', type: 'confidential' }],
      });
      // The renderer receives masked values from listEnvironments and saves them back unchanged.
      const listed = (await store.listEnvironments()).find(env => env.id === created.id)!;
      expect(listed.variables[0].value).toBe('••••••••');
      await store.updateEnvironment(created.id, { name: 'Conf renamed', variables: listed.variables });

      const onDisk = JSON.parse(await fs.readFile(path.join(userDataPath, 'environments', `${created.id}.json`), 'utf-8')) as Environment;
      expect(onDisk.variables[0].value).toBe('confidential_plain_123');
    });
  });
});

test.describe('secret storage boundaries', () => {
  test('without an injected OS adapter a secret is refused and nothing is written', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-sec-none-'));
    try {
      const store = new CollectionStore(userDataPath);
      await store.init();
      await expect(store.createEnvironment({ name: 'NoKeyring', variables: [{ key: 'k', value: 'plain', type: 'secret' }] }))
        .rejects.toThrow('not configured');
      const files = await fs.readdir(path.join(userDataPath, 'environments'));
      expect(files.filter(name => name.endsWith('.json') && name !== 'core.json')).toEqual([]);
      expect(await store.getStorageStatus()).toMatchObject({ available: false });
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  test('migrating one legacy value leaves the others plaintext and usable', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const envFile = path.join(userDataPath, 'environments', 'two-legacy.json');
      await fs.writeFile(envFile, JSON.stringify({
        id: 'two-legacy', name: 'Two', createdAt: 1, updatedAt: 1,
        variables: [
          { key: 'first', value: 'one', type: 'secret' },
          { key: 'second', value: 'two', type: 'secret' },
        ],
      }), 'utf-8');

      await expect(store.migrateSecrets('two-legacy', 'missing')).rejects.toThrow('not an unencrypted legacy value');
      expect(await store.migrateSecrets('two-legacy', 'first')).toEqual({ migratedCount: 1, failedCount: 0, errors: [] });

      const disk = JSON.parse(await fs.readFile(envFile, 'utf-8'));
      expect(disk.variables[0].encrypted).toMatchObject({ version: 1 });
      // Still plaintext on disk, so it is rewritten as a legacy Confidential value until its own migration.
      expect(disk.variables[1]).toMatchObject({ key: 'second', value: 'two', type: 'confidential', legacyUnencrypted: true });
      expect(disk.variables[1].encrypted).toBeUndefined();
      expect(await store.revealSecret('two-legacy', 'first')).toBe('one');
      expect(await store.revealSecret('two-legacy', 'second')).toBe('two');
    });
  });

  test('saving a legacy confidential value that was never revealed keeps its plaintext and legacy marker', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const envFile = path.join(userDataPath, 'environments', 'legacy-conf.json');
      await fs.writeFile(envFile, JSON.stringify({
        id: 'legacy-conf', name: 'Legacy', createdAt: 1, updatedAt: 1,
        variables: [{ key: 'token', value: 'legacy_plain', type: 'secret' }],
      }), 'utf-8');
      const listed = (await store.listEnvironments()).find(env => env.id === 'legacy-conf')!;
      await store.updateEnvironment('legacy-conf', { variables: listed.variables });

      const disk = JSON.parse(await fs.readFile(envFile, 'utf-8'));
      expect(disk.variables[0]).toMatchObject({ key: 'token', value: 'legacy_plain', type: 'confidential', legacyUnencrypted: true });
    });
  });

  test('a masked value with nothing stored behind it saves as empty, never as the mask', async () => {
    await withStore(async (store, userDataPath) => {
      await store.init();
      const created = await store.createEnvironment({ name: 'Override', variables: [
        { key: 'token', value: '••••••••', type: 'confidential' },
        { key: 'other', value: '••••••••', type: 'secret' },
      ] });
      const disk = JSON.parse(await fs.readFile(path.join(userDataPath, 'environments', `${created.id}.json`), 'utf-8'));
      expect(disk.variables[0]).toMatchObject({ key: 'token', value: '', type: 'confidential' });
      expect(await store.revealSecret(created.id, 'other')).toBe('');
    });
  });

  test('cURL export reports when the command carries a confidential or secret value', async () => {
    await withStore(async (store, _userDataPath, adapter) => {
      await store.init();
      const env = await store.createEnvironment({ name: 'Curl', variables: [
        { key: 'plain', value: 'plain_value', type: 'standard' },
        { key: 'conf', value: 'conf_value', type: 'confidential' },
        { key: 'sec', value: 'sec_value', type: 'secret' },
      ] });
      const engine = new RequestEngine({ webRequest: { onBeforeSendHeaders: () => {} } } as any, store, {}, {}, new OAuthService());
      const base: Request = {
        id: 'curl-flags', name: 'Curl flags', method: 'GET', url: 'https://example.com/a?x={{plain}}', headers: [], parameters: [],
        body: { type: 'none' }, auth: { type: 'none' }, settings: { followRedirect: true, timeout: 30000 }, scripts: {}, createdAt: 1, updatedAt: 1,
      };
      expect(await engine.exportCurl({ request: base, environmentId: env.id })).toMatchObject({ sensitive: false });
      const withConf = { ...base, url: 'https://example.com/a?x={{conf}}' };
      expect(await engine.exportCurl({ request: withConf, environmentId: env.id })).toMatchObject({ sensitive: true });
      const withSecret = { ...base, headers: [{ key: 'X-Key', value: '{{sec}}', enabled: true }] };
      const secretCurl = await engine.exportCurl({ request: withSecret, environmentId: env.id });
      expect(secretCurl).toMatchObject({ sensitive: true });
      expect(secretCurl.command).toContain('sec_value');
      // Undecryptable values stop the export before any command exists.
      adapter.failDecryption = true;
      await expect(engine.exportCurl({ request: withSecret, environmentId: env.id })).rejects.toThrow();
    });
  });
});
