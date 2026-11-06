# Secret variables: proposed design

Status: proposed — not implemented. Scope: local environments and nested interpolation.

## Comparable clients and decision

Insomnia distinguishes confidential values, masked but stored as plaintext, from encrypted vault secrets. Postman offers an encrypted Local Vault. Masking and encryption are separate protections.

- Insomnia: https://developer.konghq.com/insomnia/environments/
- Postman: https://learning.postman.com/latest-v-12/docs/use/postman-vault/postman-vault-secrets
- Electron: https://www.electronjs.org/docs/latest/api/safe-storage/

Offer three variable types:

1. **Standard**: visible, stored as ordinary local environment JSON.
2. **Confidential**: masked in the interface and previews, stored as plaintext in local JSON; label this in the type selector.
3. **Secret**: masked and encrypted at rest using OS-backed local encryption. No cloud account or separate application vault password is required. Preserve normal variable references and environment inheritance.

This is a Restiprocity design, not a claim of identical security to Insomnia's password-protected vault. Explain OS-account dependence, portability, and protection limits in the app and documentation.

## Local encryption

- Use Electron main-process safeStorage behind an injectable adapter. The installed Electron 39 type definitions expose synchronous encryptString, decryptString, isEncryptionAvailable and Linux getSelectedStorageBackend; do not depend on newer asynchronous APIs without confirming a supported Electron upgrade. Initialize after Electron is ready.
- Use the OS-backed provider: DPAPI on Windows, Keychain on macOS, and a recognized secure key provider on Linux. Reject basic_text, unknown, and any backend whose security cannot be established. Never silently fall back to plaintext while calling data encrypted. Show an actionable unavailable or locked error, retain the unsaved draft, and allow retry.
- Store versioned per-value ciphertext with explicit encoding. Keep names and environment metadata in the environment file. OS account protection on Windows does not protect usable secrets from all applications running as the same user.
- Explain that copying userData or restoring a backup on another machine or account may leave ciphertext unreadable. Never overwrite or discard unreadable ciphertext; allow explicit replacement or deletion. There is no portable encrypted export or application passphrase in this version. Advise users to retain their original secret source.
- Stage and validate ciphertext before committing updates. Use recoverable file replacement; a failed encryption or write retains the prior usable record and permits retry. Do not promise secure erasure, removal from backups or filesystem history, or power-loss durability without evidence.

## Legacy data and imports

- Existing records marked secret are plaintext today. Read them losslessly as legacy confidential values, visibly mark them “stored unencrypted,” and preserve interpolation and editing. Do not call them encrypted until migration succeeds.
- Offer explicit per-value and bulk conversion to Secret. Preview the affected count and OS portability limitations without displaying values. Replace plaintext in the current environment file only after successful encryption. Report per-environment progress and keep failed items usable and marked unconverted. No secret is deleted or regenerated. Warn that old backups, exports, logs, and snapshots may retain plaintext.
- Map Insomnia confidentialKeys to Confidential, not encrypted Secret. Insomnia exports containing confidential values are plaintext input; flag this and preserve the data. Do not invent unreadable vault values. Native collection export currently does not export environments; keep that boundary until an environment-export feature is designed.
- When converting Secret to Confidential or Standard, explicitly explain that saving writes plaintext. If decryption is unavailable, prevent replacement or conversion that would discard ciphertext. Never treat an unavailable value as empty.
- Version and validate the on-disk format. Establish a downgrade and backup strategy so older versions cannot silently misinterpret or overwrite ciphertext. Verify behavior before release.

## IPC, editing and request execution

- Ordinary environment-list and change-notification APIs return keys, types, inheritance, and masked state without decrypted values. A separate explicit reveal/edit operation supplies values transiently. Clear renderer secret state on close or lock. An unchanged masked secret means “keep existing ciphertext,” not “replace with blank”: create, replace, clear and keep are distinct operations.
- Encrypt in the main process before persistence. Decrypt only for a send, explicit reveal/edit, or explicitly requested Copy as cURL. A used missing, locked, or undecryptable secret fails before network or clipboard mutation; an unused unavailable secret does not block unrelated requests.
- Mask by default, with explicit Reveal and Hide. A multiline textarea cannot mask its contents, so show a masked non-editable placeholder until Reveal and edit; hiding retains the in-memory draft. Re-mask on close, app lock or loss of focus, and context changes.
- A result is sensitive when a confidential or secret variable contributes directly or transitively. Mask the entire derived output in the interpolation editor, request URL preview, and other preview surfaces changed by this work. Dependency names and sources may remain visible; diagnostics must never include values.
- Send uses real resolved values. Copy as cURL may place credentials on the system clipboard: show an explicit warning before copying a command known to contain sensitive values, and do not log the command. This does not protect the clipboard, receiving server, request logs, response bodies, old history, OS or third-party applications.
- Avoid writing secrets to logs, telemetry, crash details, preview titles, accessible announcements, test artifacts or automatic clipboard actions. Audit request and response history, request drafts, NetLog and response storage for new exposure paths. Describe remaining exposure; do not claim general response-body scrubbing.

## Validation and rollout

- Test injected provider failures, insecure Linux fallback, encryption/decryption errors, corrupted data, interrupted writes, replace without reveal, keep, clear, conversion, migration retry, and restart. After migration, inspect the current environment file for plaintext; do not claim old copies are erased.
- Real Electron tests cover encrypted-at-rest creation, restart, local-server send, and unavailable-provider behavior where testable. Platform CI verifies supported Windows, macOS and Linux providers or records when no usable keyring is available. Test that imported Insomnia confidential values stay plaintext confidential.
- Browser and native tests cover direct and transitive masking, explicit reveal/hide, secret-bearing cURL confirmation, unsaved drafts and unavailable secrets. Use fixture-only secrets; prevent automatic traces and screenshots while deliberately revealing.
- Document the provider, migration, account/device portability, backups, downgrade limits and distinction between Confidential and Secret. External vaults, cloud sync, shared secrets, app-managed passphrases, portable secret export, and script access are outside this version.
