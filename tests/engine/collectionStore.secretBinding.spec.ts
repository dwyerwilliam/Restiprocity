import { expect, test } from '@playwright/test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CollectionStore } from '../../src/main/stores/collectionStore';
import { ElectronSafeStorageAdapter, MockSafeStorageAdapter } from '../../src/main/crypto/safeStorageAdapter';
import { openSecret, sealSecret } from '../../src/main/crypto/secretEnvelope';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { OAuthService } from '../../src/main/oauth/oauthService';
import type { Environment, EnvironmentVariable, Request } from '../../src/shared/types';

const MASK = '•'.repeat(8);

async function withStore(run: (store: CollectionStore, dir: string, adapter: MockSafeStorageAdapter) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-bound-'));
  const adapter = new MockSafeStorageAdapter();
  try {
    await run(new CollectionStore(dir, undefined, undefined, adapter), dir, adapter);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const envFile = (dir: string, id: string) => path.join(dir, 'environments', `${id}.json`);
const readEnv = async (dir: string, id: string): Promise<Environment> => JSON.parse(await fs.readFile(envFile(dir, id), 'utf-8'));
const writeEnv = (dir: string, environment: Environment) => fs.writeFile(envFile(dir, environment.id), JSON.stringify(environment, null, 2), 'utf-8');
const variable = (environment: Environment, key: string) => environment.variables.find(item => item.key === key)!;

function requestUsing(reference: string): Request {
  return {
    id: 'bound-request', name: 'Bound', method: 'GET', url: 'http://127.0.0.1:9/never', headers: [{ key: 'Authorization', value: reference, enabled: true }],
    parameters: [], body: { type: 'none' }, auth: { type: 'none' },
    settings: { followRedirect: true, timeout: 1000, cookiesEnabled: false }, scripts: {}, createdAt: 1, updatedAt: 1,
  } as unknown as Request;
}

test.describe('a Secret is read only where it was saved', () => {
  test('a stored value copied under another key is refused there, and the original keeps working', async () => {
    await withStore(async (store, dir) => {
      await store.init();
      const created = await store.createEnvironment({ name: 'Prod', variables: [
        { key: 'token', value: 'prod-token-value', type: 'secret' },
        { key: 'callback', value: 'https://example.test', type: 'standard' },
      ] });
      const disk = await readEnv(dir, created.id);
      // Someone who can write the file, but not decrypt it, moves the token under a key a request sends elsewhere.
      await writeEnv(dir, { ...disk, variables: [...disk.variables, { key: 'leak', value: MASK, type: 'secret', encrypted: variable(disk, 'token').encrypted }] });

      await expect(store.revealSecret(created.id, 'leak')).rejects.toThrow(/encrypted for a different variable or environment/);
      expect(await store.revealSecret(created.id, 'token')).toBe('prod-token-value');
      const internal = await store.getEnvironment(created.id);
      expect(variable(internal!, 'leak')).toMatchObject({ value: '', undecryptable: true });
      expect(variable(internal!, 'token').value).toBe('prod-token-value');
      expect(JSON.stringify(internal)).not.toContain('"leak","value":"prod-token-value"');

      // A send that uses the moved value stops before any network use; one that uses the original resolves.
      const engine = new RequestEngine({ webRequest: { onBeforeSendHeaders: () => {} } } as any, store, {}, {}, new OAuthService());
      await expect(engine.exportCurl({ request: requestUsing('Bearer {{leak}}'), environmentId: created.id }))
        .rejects.toThrow(/secret "leak" cannot be decrypted\. This secret was encrypted for a different variable/);
      const exported = await engine.exportCurl({ request: requestUsing('Bearer {{token}}'), environmentId: created.id });
      expect(exported.command).toContain('Bearer prod-token-value');

      // It cannot be turned into a readable type either: the save fails and the file is unchanged.
      const before = await fs.readFile(envFile(dir, created.id), 'utf-8');
      await expect(store.updateEnvironment(created.id, { variables: [
        { key: 'token', value: MASK, type: 'secret' }, { key: 'callback', value: 'https://example.test', type: 'standard' },
        { key: 'leak', value: MASK, type: 'standard', lowerProtection: true },
      ] })).rejects.toThrow(/encrypted for a different variable or environment/);
      expect(await fs.readFile(envFile(dir, created.id), 'utf-8')).toBe(before);
    });
  });

  test('a stored value copied into another environment under the same key is refused there', async () => {
    await withStore(async (store, dir) => {
      await store.init();
      const prod = await store.createEnvironment({ name: 'Prod', variables: [{ key: 'token', value: 'prod-token-value', type: 'secret' }] });
      const scratch = await store.createEnvironment({ name: 'Scratch', variables: [{ key: 'token', value: 'scratch-value', type: 'secret' }] });
      const scratchDisk = await readEnv(dir, scratch.id);
      await writeEnv(dir, { ...scratchDisk, variables: [{ ...variable(scratchDisk, 'token'), encrypted: variable(await readEnv(dir, prod.id), 'token').encrypted }] });

      await expect(store.revealSecret(scratch.id, 'token')).rejects.toThrow(/encrypted for a different variable or environment/);
      expect(await store.revealSecret(prod.id, 'token')).toBe('prod-token-value');
    });
  });

  test('a bound value relabelled as the older unbound format is refused, not returned with its wrapper', async () => {
    await withStore(async (store, dir) => {
      await store.init();
      const created = await store.createEnvironment({ name: 'Prod', variables: [{ key: 'token', value: 'prod-token-value', type: 'secret' }] });
      const disk = await readEnv(dir, created.id);
      const bound = (variable(disk, 'token').encrypted as { version: 2; bound: string }).bound;
      await writeEnv(dir, { ...disk, variables: [...disk.variables, { key: 'leak', value: MASK, type: 'secret', encrypted: { version: 1, cipher: bound } }] });

      await expect(store.revealSecret(created.id, 'leak')).rejects.toThrow(/encrypted for a different variable or environment/);
      expect(variable((await store.getEnvironment(created.id))!, 'leak')).toMatchObject({ value: '', undecryptable: true });
      // The same relabelled value is not adopted at the next start either.
      await new CollectionStore(dir, undefined, undefined, new MockSafeStorageAdapter()).init();
      expect(variable(await readEnv(dir, created.id), 'leak').encrypted).toEqual({ version: 1, cipher: bound });
    });
  });

  test('a rename that cannot read the value is refused and leaves the file as it was', async () => {
    await withStore(async (store, dir, adapter) => {
      await store.init();
      const created = await store.createEnvironment({ name: 'Prod', variables: [{ key: 'token', value: 'prod-token-value', type: 'secret' }] });
      const before = await fs.readFile(envFile(dir, created.id), 'utf-8');
      adapter.failDecryption = true;
      await expect(store.updateEnvironment(created.id, { variables: [{ key: 'renamed', originalKey: 'token', value: MASK, type: 'secret' }] }))
        .rejects.toThrow(/"token" cannot be renamed while its value cannot be read/);
      expect(await fs.readFile(envFile(dir, created.id), 'utf-8')).toBe(before);
      // Saving it under its own key needs no decryption, so that still works.
      await store.updateEnvironment(created.id, { name: 'Prod 2', variables: [{ key: 'token', value: MASK, type: 'secret' }] });
      expect(variable(await readEnv(dir, created.id), 'token').encrypted).toEqual(variable(JSON.parse(before), 'token').encrypted);
      adapter.failDecryption = false;
      expect(await store.revealSecret(created.id, 'token')).toBe('prod-token-value');
    });
  });
});

test.describe('values saved before binding existed', () => {
  const legacyFile = (adapter: MockSafeStorageAdapter): Environment => ({
    id: 'older', name: 'Older', parentId: 'core', createdAt: 1, updatedAt: 1,
    variables: [
      { key: 'token', value: MASK, type: 'secret', encrypted: { version: 1, cipher: adapter.encrypt('older-token-value') } },
      { key: 'plain', value: 'visible', type: 'standard' },
    ],
  });

  test('are bound at the next start, keep their value, and are then refused anywhere else', async () => {
    await withStore(async (store, dir, adapter) => {
      await fs.mkdir(path.join(dir, 'environments'), { recursive: true });
      await writeEnv(dir, legacyFile(adapter));
      await store.init();

      const disk = await readEnv(dir, 'older');
      expect(variable(disk, 'token').encrypted).toEqual({ version: 2, bound: expect.any(String) });
      expect(disk).toMatchObject({ id: 'older', name: 'Older', parentId: 'core', createdAt: 1, updatedAt: 1 });
      expect(variable(disk, 'plain')).toEqual({ key: 'plain', value: 'visible', type: 'standard' });
      expect(await store.revealSecret('older', 'token')).toBe('older-token-value');

      await writeEnv(dir, { ...disk, variables: [...disk.variables, { key: 'leak', value: MASK, type: 'secret', encrypted: variable(disk, 'token').encrypted }] });
      await expect(store.revealSecret('older', 'leak')).rejects.toThrow(/encrypted for a different variable or environment/);
    });
  });

  test('stay exactly as they are when they cannot be read, and are bound once they can', async () => {
    await withStore(async (store, dir, adapter) => {
      await fs.mkdir(path.join(dir, 'environments'), { recursive: true });
      await writeEnv(dir, legacyFile(adapter));
      const before = await fs.readFile(envFile(dir, 'older'), 'utf-8');

      adapter.failDecryption = true;
      await store.init();
      expect(await fs.readFile(envFile(dir, 'older'), 'utf-8')).toBe(before);
      // A save from the mask keeps the unreadable value too.
      await store.updateEnvironment('older', { variables: [{ key: 'token', value: MASK, type: 'secret' }, { key: 'plain', value: 'visible', type: 'standard' }] });
      expect(variable(await readEnv(dir, 'older'), 'token').encrypted).toEqual(variable(JSON.parse(before), 'token').encrypted);

      adapter.available = false;
      adapter.failDecryption = false;
      await new CollectionStore(dir, undefined, undefined, adapter).init();
      expect(variable(await readEnv(dir, 'older'), 'token').encrypted).toMatchObject({ version: 1 });

      adapter.available = true;
      await new CollectionStore(dir, undefined, undefined, adapter).init();
      expect(variable(await readEnv(dir, 'older'), 'token').encrypted).toMatchObject({ version: 2 });
      expect(await store.revealSecret('older', 'token')).toBe('older-token-value');
    });
  });

  test('are bound by a save from the mask, including under a new key', async () => {
    await withStore(async (store, dir, adapter) => {
      await store.init();
      await writeEnv(dir, legacyFile(adapter));
      await store.updateEnvironment('older', { variables: [
        { key: 'renamed', originalKey: 'token', value: MASK, type: 'secret' }, { key: 'plain', value: 'visible', type: 'standard' },
      ] });
      const disk = await readEnv(dir, 'older');
      expect(variable(disk, 'renamed').encrypted).toEqual({ version: 2, bound: expect.any(String) });
      expect(await store.revealSecret('older', 'renamed')).toBe('older-token-value');
    });
  });

  test('a file whose id is not its file name is not rewritten at start', async () => {
    await withStore(async (store, dir, adapter) => {
      await fs.mkdir(path.join(dir, 'environments'), { recursive: true });
      const misnamed = { ...legacyFile(adapter), id: 'someone-else' };
      await fs.writeFile(envFile(dir, 'older'), JSON.stringify(misnamed, null, 2), 'utf-8');
      const before = await fs.readFile(envFile(dir, 'older'), 'utf-8');
      await store.init();
      expect(await fs.readFile(envFile(dir, 'older'), 'utf-8')).toBe(before);
    });
  });
});

test.describe('formats this version does not write', () => {
  test('a value in a newer format is reported unreadable and kept through a save', async () => {
    await withStore(async (store, dir) => {
      await store.init();
      const created = await store.createEnvironment({ name: 'Future', variables: [{ key: 'token', value: 'value', type: 'secret' }] });
      const disk = await readEnv(dir, created.id);
      const future = { version: 3, sealed: 'opaque' } as unknown as EnvironmentVariable['encrypted'];
      await writeEnv(dir, { ...disk, variables: [{ key: 'token', value: MASK, type: 'secret', encrypted: future }] });

      await expect(store.revealSecret(created.id, 'token')).rejects.toThrow(/format this version does not read/);
      expect(variable((await store.getEnvironment(created.id))!, 'token')).toMatchObject({ value: '', undecryptable: true });
      await store.updateEnvironment(created.id, { name: 'Future 2', variables: [{ key: 'token', value: MASK, type: 'secret' }] });
      expect(variable(await readEnv(dir, created.id), 'token').encrypted).toEqual(future);
      await new CollectionStore(dir, undefined, undefined, new MockSafeStorageAdapter()).init();
      expect(variable(await readEnv(dir, created.id), 'token').encrypted).toEqual(future);
    });
  });

  test('0.3.1 reads only a `cipher` field, which a bound value does not have, so it reports the value unreadable', () => {
    const adapter = new MockSafeStorageAdapter();
    const envelope = sealSecret(adapter, { environmentId: 'env', key: 'token' }, 'value') as { version: number; cipher?: string; bound?: string };
    expect(Object.keys(envelope).sort()).toEqual(['bound', 'version']);
    expect(openSecret(adapter, envelope as any, { environmentId: 'env', key: 'token' })).toBe('value');
    // What 0.3.1 does with it: `adapter.decrypt(envelope.cipher)`, with both the mock and the OS adapter.
    expect(() => adapter.decrypt(envelope.cipher as unknown as string)).toThrow();
    const osAdapter = new ElectronSafeStorageAdapter({
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (text: string) => Buffer.from(text), decryptString: (buffer: Buffer) => buffer.toString(),
    } as any, 'win32');
    expect(() => osAdapter.decrypt(envelope.cipher as unknown as string)).toThrow(/Failed to decrypt secret/);
  });
});
