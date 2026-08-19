# Code Signing — Restiprocity

Decision doc for whether and how to sign Restiprocity releases. Last updated: 2026-08-15.

## Current Status

Nothing is signed. `package.json` has no `mac.sign`, `win.certificateFile`, or equivalent fields. The GitHub Actions workflow (`.github/workflows/build-release.yml`) has no signing steps and no secrets for certificates or credentials. Releases are unsigned DMG, EXE, and AppImage artifacts.

Users installing today will see:
- **macOS** — Gatekeeper "App Downloaded From Internet" warning (or full block if not notarized)
- **Windows** — SmartScreen "Unknown Publisher" warning
- **Linux** — no warning (AppImage signing is optional)

---

## macOS Signing

### What's needed

1. **Apple Developer Program** membership — $99/year
2. **Developer ID Application** certificate (created in Keychain Access after enrollment)
3. **Notarization** — Apple scans the packaged DMG/app and stamps it as OK

Notarization has no per-app fee. It's included with the developer account.

### How it works

electron-builder supports both signing and notarization via `package.json` `build.mac` config. The certificate lives in a macOS keychain (set up in CI via a `.p12` + password stored as a GitHub Actions secret). After signing, `xcrun notarytool submit` sends the artifact to Apple, which typically responds within minutes.

Notarization authentication should use an **App Store Connect API key** (preferred) rather than an Apple ID + app-specific password. API keys are scoped, don't expire, and are the recommended approach for CI. Apple ID with an app-specific password works as a fallback but is more fragile (passwords expire, broader scope).

### Where it plugs in

- `package.json` → `build.mac` block gets `sign`, `notarize`, and related fields
- `.github/workflows/build-release.yml` → macOS job gets a keychain setup step, the API key secrets (or Apple ID fallback), and a notarize step after `electron-builder`

### Rough cost

$99/year for the developer account. Certificate renewal is annual (same fee). Notarization is free.

### Links

- [Apple Developer Program](https://developer.apple.com/programs/)
- [electron-builder macOS code signing](https://www.electron.build/code-signing)
- [Apple Notarization docs](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)

---

## Windows Signing

### What's needed

A code-signing certificate from a trusted CA. Two main paths:

**Option A — OV (Organization Validation) certificate**
- Purchased from a CA (DigiCert, Sectigo, GlobalSign, etc.)
- Roughly $300-$600/year depending on provider and warranty
- Requires a hardware token (YubiKey, eToken) or Azure Key Vault for private key storage
- SmartScreen reputation builds over time (new cert = more warnings at first)

**Option B — EV (Extended Validation) certificate**
- More stringent vetting from the CA
- Roughly $500-$1000+/year
- Immediate SmartScreen reputation (fewer "Unknown Publisher" warnings from day one)
- Also requires hardware token or cloud key storage

**Option C — Azure Trusted Signing**
- Microsoft's managed service (no cert to buy or store yourself)
- Requires an Azure account + enrollment + identity verification
- No annual certificate fee, but Azure account overhead applies
- Good fit if you already use Azure for anything

### Self-signing (not an option for public releases)

Self-signed certificates work for internal testing but do nothing for public distribution. Gatekeeper and SmartScreen will still block or warn. They are not equivalent to proper signing.

### Where it plugs in

- `package.json` → `build.win` block gets `certificateFile`, `certificatePassword`, `sign` fields
- `.github/workflows/build-release.yml` → Windows job gets certificate import from secret (`.p12` or Trusted Signing profile), signing step before or during `electron-builder`

### Rough cost

$300-$1000+/year depending on OV vs EV vs Trusted Signing. Hardware token adds $50-$100 upfront if not using cloud storage.

### Links

- [electron-builder Windows code signing](https://www.electron.build/code-signing)
- [Microsoft Authenticode](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/authenticode)
- [Azure Trusted Signing](https://azure.microsoft.com/en-us/products/trusted-signing/)

---

## Linux Signing

AppImage supports GPG signing but it's optional. Most Linux desktop users don't verify signatures anyway. Low priority unless the project ships to enterprise environments that require it.

---

## GitHub Actions Secrets Needed (Future)

If signing is adopted, these secrets will be needed:

| Secret | Platform | Description |
|---|---|---|
| `MAC_CERT_P12` | macOS | Base64-encoded `.p12` of Developer ID Application cert |
| `MAC_CERT_PASSWORD` | macOS | Password for the `.p12` |
| `APPLE_API_KEY` | macOS | Base64-encoded App Store Connect API key (`.p8`) — **preferred** for notarization |
| `APPLE_API_KEY_ID` | macOS | Key ID from App Store Connect |
| `APPLE_API_ISSUER` | macOS | Issuer ID from App Store Connect |
| `APPLE_TEAM_ID` | macOS | Apple developer team ID |
| `APPLE_ID` | macOS | Apple ID email — **fallback** only if API key is not available |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS | App-specific password — **fallback** only if API key is not available |
| `WIN_CERT_P12` (or Trusted Signing config) | Windows | Certificate or Azure Trusted Signing profile |
| `WIN_CERT_PASSWORD` | Windows | Password for the `.p12` (if using cert path) |

---

## Recommended Next Steps

1. **Decide if signing is worth it now.** At v0.2.5 with a small user base, the warnings may not be a blocker. If downloads grow or the app targets professional users, signing becomes more important.
2. **macOS first.** $99/year is the cheapest path. Notarization alone (without signing) won't work for DMG distribution — both are needed.
3. **Windows later.** Higher cost and setup complexity. Can wait until macOS is proven.
4. **When ready:** Add secrets to the repo, update `package.json` `build` config, add signing steps to the workflow. Nothing needs to change in application code.
