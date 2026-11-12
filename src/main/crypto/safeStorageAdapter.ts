import type { SafeStorage } from 'electron';
import type { SafeStorageStatus } from '@shared/types';

export class SecretEncryptionError extends Error {
  constructor(message: string, public readonly code: string = 'SECRET_ENCRYPTION_FAILED') {
    super(message);
    this.name = 'SecretEncryptionError';
  }
}

export class SecretDecryptionError extends Error {
  constructor(message: string, public readonly code: string = 'SECRET_DECRYPTION_FAILED') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export interface SafeStorageAdapter {
  isAvailable(): boolean;
  getBackend(): string;
  getStatus(): SafeStorageStatus;
  encrypt(plainText: string): string;
  decrypt(cipherTextBase64: string): string;
}

export class ElectronSafeStorageAdapter implements SafeStorageAdapter {
  constructor(
    private readonly safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  isAvailable(): boolean {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) {
        return false;
      }
      if (this.platform === 'linux') {
        const backend = this.safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  getBackend(): string {
    if (this.platform === 'win32') return 'dpapi';
    if (this.platform === 'darwin') return 'keychain';
    if (this.platform === 'linux') {
      try {
        return this.safeStorage.getSelectedStorageBackend();
      } catch {
        return 'unknown';
      }
    }
    return 'unknown';
  }

  getStatus(): SafeStorageStatus {
    const available = this.isAvailable();
    const backend = this.getBackend();
    if (!available) {
      return {
        available: false,
        backend,
        warning: `OS secret encryption is unavailable (${backend}). Secrets stored in this mode cannot be encrypted or decrypted.`,
      };
    }
    return { available: true, backend };
  }

  encrypt(plainText: string): string {
    if (!this.isAvailable()) {
      throw new SecretEncryptionError(
        `OS secret encryption is unavailable (${this.getBackend()}). Fix the keyring and retry.`,
        'ENCRYPTION_UNAVAILABLE',
      );
    }
    try {
      const buffer = this.safeStorage.encryptString(plainText);
      return buffer.toString('base64');
    } catch (error) {
      throw new SecretEncryptionError(
        `Failed to encrypt secret with OS safeStorage: ${(error as Error).message}`,
        'ENCRYPTION_FAILED',
      );
    }
  }

  decrypt(cipherTextBase64: string): string {
    if (!this.isAvailable()) {
      throw new SecretDecryptionError(
        `OS secret encryption is unavailable (${this.getBackend()}). Fix the keyring and retry.`,
        'DECRYPTION_UNAVAILABLE',
      );
    }
    try {
      const buffer = Buffer.from(cipherTextBase64, 'base64');
      return this.safeStorage.decryptString(buffer);
    } catch (error) {
      throw new SecretDecryptionError(
        `Failed to decrypt secret: ${(error as Error).message}. The secret may have been encrypted on another machine or OS user account.`,
        'DECRYPTION_FAILED',
      );
    }
  }
}

/**
 * Deterministic in-memory safeStorage mock for testing environments where
 * Electron's safeStorage is not present or when injecting failures.
 */
export class MockSafeStorageAdapter implements SafeStorageAdapter {
  public available: boolean;
  public backend: string;
  public failDecryption: boolean = false;
  public failEncryption: boolean = false;

  constructor(options: { available?: boolean; backend?: string } = {}) {
    this.available = options.available ?? true;
    this.backend = options.backend ?? 'mock-dpapi';
  }

  isAvailable(): boolean {
    return this.available;
  }

  getBackend(): string {
    return this.backend;
  }

  getStatus(): SafeStorageStatus {
    if (!this.available) {
      return {
        available: false,
        backend: this.backend,
        warning: `OS secret encryption is unavailable (${this.backend}).`,
      };
    }
    return { available: true, backend: this.backend };
  }

  encrypt(plainText: string): string {
    if (!this.available || this.failEncryption) {
      throw new SecretEncryptionError('OS secret encryption is unavailable.', 'ENCRYPTION_UNAVAILABLE');
    }
    // Simple deterministic encoding for test mock
    return Buffer.from(`mock_enc:${plainText}`, 'utf-8').toString('base64');
  }

  decrypt(cipherTextBase64: string): string {
    if (!this.available || this.failDecryption) {
      throw new SecretDecryptionError('Failed to decrypt secret with OS safeStorage.', 'DECRYPTION_FAILED');
    }
    const decoded = Buffer.from(cipherTextBase64, 'base64').toString('utf-8');
    if (!decoded.startsWith('mock_enc:')) {
      throw new SecretDecryptionError('Invalid mock ciphertext.', 'DECRYPTION_FAILED');
    }
    return decoded.slice('mock_enc:'.length);
  }
}
