import { expect, test } from '@playwright/test';
import {
  ElectronSafeStorageAdapter,
  MockSafeStorageAdapter,
  SecretDecryptionError,
  SecretEncryptionError,
} from '../../src/main/crypto/safeStorageAdapter';

test.describe('SafeStorageAdapter', () => {
  test.describe('ElectronSafeStorageAdapter', () => {
    test('reports available on win32 when isEncryptionAvailable is true', () => {
      const mockSafeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (text: string) => Buffer.from(`enc_${text}`),
        decryptString: (buf: Buffer) => buf.toString().replace(/^enc_/, ''),
        getSelectedStorageBackend: () => 'unknown' as const,
      };

      const adapter = new ElectronSafeStorageAdapter(mockSafeStorage, 'win32');
      expect(adapter.isAvailable()).toBe(true);
      expect(adapter.getBackend()).toBe('dpapi');
      expect(adapter.getStatus()).toEqual({ available: true, backend: 'dpapi' });

      const encrypted = adapter.encrypt('my_api_key');
      expect(adapter.decrypt(encrypted)).toBe('my_api_key');
    });

    test('reports available on darwin when isEncryptionAvailable is true', () => {
      const mockSafeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (text: string) => Buffer.from(`osx_${text}`),
        decryptString: (buf: Buffer) => buf.toString().replace(/^osx_/, ''),
        getSelectedStorageBackend: () => 'unknown' as const,
      };

      const adapter = new ElectronSafeStorageAdapter(mockSafeStorage, 'darwin');
      expect(adapter.isAvailable()).toBe(true);
      expect(adapter.getBackend()).toBe('keychain');
      expect(adapter.getStatus()).toEqual({ available: true, backend: 'keychain' });
    });

    test('on linux rejects basic_text and unknown storage backends', () => {
      const mockSafeStorageBasic = {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
        getSelectedStorageBackend: () => 'basic_text' as const,
      };
      const basicAdapter = new ElectronSafeStorageAdapter(mockSafeStorageBasic, 'linux');
      expect(basicAdapter.isAvailable()).toBe(false);
      expect(basicAdapter.getBackend()).toBe('basic_text');
      expect(basicAdapter.getStatus().available).toBe(false);

      const mockSafeStorageUnknown = {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
        getSelectedStorageBackend: () => 'unknown' as const,
      };
      const unknownAdapter = new ElectronSafeStorageAdapter(mockSafeStorageUnknown, 'linux');
      expect(unknownAdapter.isAvailable()).toBe(false);
    });

    test('on linux accepts recognized secure keyrings', () => {
      const mockSafeStorageGnome = {
        isEncryptionAvailable: () => true,
        encryptString: (t: string) => Buffer.from(t),
        decryptString: (b: Buffer) => b.toString(),
        getSelectedStorageBackend: () => 'gnome_libsecret' as const,
      };
      const gnomeAdapter = new ElectronSafeStorageAdapter(mockSafeStorageGnome, 'linux');
      expect(gnomeAdapter.isAvailable()).toBe(true);
      expect(gnomeAdapter.getBackend()).toBe('gnome_libsecret');

      const mockSafeStorageKwallet = {
        isEncryptionAvailable: () => true,
        encryptString: (t: string) => Buffer.from(t),
        decryptString: (b: Buffer) => b.toString(),
        getSelectedStorageBackend: () => 'kwallet6' as const,
      };
      const kwalletAdapter = new ElectronSafeStorageAdapter(mockSafeStorageKwallet, 'linux');
      expect(kwalletAdapter.isAvailable()).toBe(true);
      expect(kwalletAdapter.getBackend()).toBe('kwallet6');
    });

    test('throws SecretEncryptionError and SecretDecryptionError when unavailable', () => {
      const unavailableSafeStorage = {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
        getSelectedStorageBackend: () => 'unknown' as const,
      };
      const adapter = new ElectronSafeStorageAdapter(unavailableSafeStorage, 'win32');
      expect(adapter.isAvailable()).toBe(false);

      expect(() => adapter.encrypt('secret')).toThrow(SecretEncryptionError);
      expect(() => adapter.decrypt('dGVzdA==')).toThrow(SecretDecryptionError);
    });

    test('catches underlying decryption error and rethrows actionable SecretDecryptionError', () => {
      const failingSafeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (t: string) => Buffer.from(t),
        decryptString: () => {
          throw new Error('MAC verification failed or corrupted ciphertext');
        },
        getSelectedStorageBackend: () => 'unknown' as const,
      };
      const adapter = new ElectronSafeStorageAdapter(failingSafeStorage, 'win32');

      expect(() => adapter.decrypt(Buffer.from('corrupt_data').toString('base64')))
        .toThrow(/Failed to decrypt secret/);
    });
  });

  test.describe('MockSafeStorageAdapter', () => {
    test('encrypts and decrypts deterministically in test environments', () => {
      const mock = new MockSafeStorageAdapter({ available: true, backend: 'mock-keyring' });
      expect(mock.isAvailable()).toBe(true);
      expect(mock.getBackend()).toBe('mock-keyring');

      const cipher = mock.encrypt('plaintext_secret_123');
      expect(mock.decrypt(cipher)).toBe('plaintext_secret_123');
    });

    test('simulates decryption failure when failDecryption is enabled', () => {
      const mock = new MockSafeStorageAdapter({ available: true });
      const cipher = mock.encrypt('secret');

      mock.failDecryption = true;
      expect(() => mock.decrypt(cipher)).toThrow(SecretDecryptionError);
    });
  });
});
