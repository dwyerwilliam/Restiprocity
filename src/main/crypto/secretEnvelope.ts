import type { EncryptedSecretEnvelope } from '@shared/types';
import { SecretDecryptionError, type SafeStorageAdapter } from './safeStorageAdapter';

/** The environment and key a secret is stored under. */
export interface SecretLocation {
  environmentId: string;
  key: string;
}

/** Marks the encrypted text of a bound value, so it can never be read back as an unbound one. */
const BOUND_FORMAT = 'restiprocity-secret/2';

interface BoundPayload {
  format: typeof BOUND_FORMAT;
  environment: string;
  key: string;
  value: string;
}

function parseBoundPayload(plainText: string): BoundPayload | null {
  if (!plainText.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(plainText) as Partial<BoundPayload> | null;
    return parsed && parsed.format === BOUND_FORMAT && typeof parsed.environment === 'string'
      && typeof parsed.key === 'string' && typeof parsed.value === 'string'
      ? parsed as BoundPayload : null;
  } catch {
    return null;
  }
}

/** True for a value that already decrypts only where it is stored. */
export function isBoundEnvelope(envelope: EncryptedSecretEnvelope): boolean {
  return envelope.version === 2;
}

/**
 * Encrypts a value together with the environment and key it belongs to. The OS encryption has no way to tie a
 * value to a name, so the name travels inside the encrypted text and is checked when the value is read.
 *
 * The field is named `bound`, not `cipher`: 0.3.1 decrypts whatever `cipher` holds and would use the whole
 * encrypted document as the secret. With no `cipher` it reports the value as unreadable and keeps it.
 */
export function sealSecret(adapter: SafeStorageAdapter, location: SecretLocation, value: string): EncryptedSecretEnvelope {
  const payload: BoundPayload = { format: BOUND_FORMAT, environment: location.environmentId, key: location.key, value };
  return { version: 2, bound: adapter.encrypt(JSON.stringify(payload)) };
}

/**
 * Decrypts a stored value for the place it is stored in. A bound value found under another environment or key is
 * refused, as is a bound value relabelled as the older unbound format.
 */
export function openSecret(adapter: SafeStorageAdapter, envelope: EncryptedSecretEnvelope, location: SecretLocation): string {
  const stored = envelope as { version?: unknown; cipher?: unknown; bound?: unknown } | null;
  if (stored?.version === 2 && typeof stored.bound === 'string') {
    const payload = parseBoundPayload(adapter.decrypt(stored.bound));
    if (!payload) throw new SecretDecryptionError('The stored secret is damaged. Enter the value again.', 'DECRYPTION_FAILED');
    if (payload.environment !== location.environmentId || payload.key !== location.key) {
      throw new SecretDecryptionError(
        'This secret was encrypted for a different variable or environment, so it is not used here. Enter the value again.',
        'SECRET_MOVED',
      );
    }
    return payload.value;
  }
  if (stored?.version === 1 && typeof stored.cipher === 'string') {
    const plainText = adapter.decrypt(stored.cipher);
    if (parseBoundPayload(plainText)) {
      throw new SecretDecryptionError(
        'This secret was encrypted for a different variable or environment, so it is not used here. Enter the value again.',
        'SECRET_MOVED',
      );
    }
    return plainText;
  }
  throw new SecretDecryptionError(
    'This secret was saved in a format this version does not read. It is kept as it is; update Restiprocity to use it.',
    'UNSUPPORTED_FORMAT',
  );
}
