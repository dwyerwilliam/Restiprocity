# Restiprocity

> A local-first desktop REST API testing client. No cloud dependency. Your data stays yours.

[![Electron](https://img.shields.io/badge/Electron-39.x-blue.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.x-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Build & Release](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/build-release.yml/badge.svg)](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/build-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/dwyerwilliam/Restiprocity?label=latest)](https://github.com/dwyerwilliam/Restiprocity/releases/latest)

## Requirements

- **Node.js 26.13.0** (`>=26.13.0 <27`), pinned by [`.node-version`](./.node-version)
- From the repo root, run `nvm use` or `fnm use` (or an equivalent version manager) to load the exact version from `.node-version`
- The host Node runtime is used for tooling and tests; it is not the same ABI as Electron's native runtime, so native modules like `better-sqlite3` are ABI-locked to the runtime they are built against

## Features

- **Full HTTP Method Support** — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- **Rich Request Editor** — Headers, query parameters, raw body (JSON/XML/HTML), form-urlencoded, and binary-safe multipart files (32 MiB maximum encoded form)
- **Authentication** — Bearer token, API key, Basic auth, NTLM, and OAuth2 Client Credentials or Authorization Code with mandatory PKCE. Browser OAuth uses an external system browser and a loopback callback; tokens stay in memory and are never persisted. Password grant remains visible for migration but is blocked.
- **Tokens from another request** — A login or token request can provide values from its response (a JSON field, a response header, or the whole body) that every request uses as `{{api_token}}`, for example as its Bearer token. The token request runs when a request needs the value and none is fresh, again after the refresh time (default 3600 s, sooner when the response's `expires_in` is shorter), and once more when a cached token gets HTTP 401. Values stay in memory; see [Tokens from another request](#tokens-from-another-request).
- **NTLM Windows Auth Context** — On Windows, NTLM authentication defaults to using your current logged-in user's credentials. Toggle off to provide manual username/password instead
- **Environment Management** — Edit environments and variables, create nested environments, and resolve nested `{{variable}}` references with parent fallback. Cycles and substituted output over 1 MiB report actionable interpolation errors; unchanged literal strings remain valid. Built-ins (`{{timestamp}}`, `{{uuid}}`, `{{randomInt}}`) take precedence over user values and share one generated context per send. Secret values are encrypted at rest (see [Secret variables](#secret-variables)), and preview samples are separate from send contexts.
- **Response Viewer** — Body, headers, timing breakdown (DNS/TCP/TLS measured from Chromium's network log, plus TTFB and download, with new versus reused connections labeled), and live cookie observations. Cookie jars are app-session only, and restored snapshots show redacted cookie data.
- **Request History** — SQLite-backed private history with request identity and filtering by status, URL, and date range. Existing requests reopen with their current definition and draft without sending. Deleted requests open as temporary, metadata-only views with Send disabled. Historical details are bounded and redacted where needed, and unavailable request or response data isn't reconstructed. Existing blank legacy rows aren't rewritten.
- **Collection Management** — Hierarchical request groups persisted as JSON files on disk. Export a request, a folder, or the whole collection to a `.restiprocity.json` file and import it back (imports get fresh IDs and never overwrite existing items). Insomnia exports (v4 JSON or v5 YAML), OpenAPI 3.0/3.1 JSON or YAML documents, and Postman v2.1 collections or separately exported environments import the same way; anything that can't be carried over is listed after the import. **Copy as cURL** puts a bash/zsh command for any request on the clipboard, with environment variables resolved. Invalid moves are rejected without mutating collection files and remain recoverable for retry.
- **Catppuccin Mocha Theme** — Dark-first UI built with Tailwind CSS
- **Local-First** — All data stored in `userData/`. No telemetry, no cloud sync, no account required. The app sends the requests you send and starts no others, apart from the Windows update check and your system's proxy detection; the spellchecker is off because it would download its dictionary from Google

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Renderer (React)                │
│  ┌──────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ Sidebar  │  │ Request    │  │ Response    │  │
│  │ (tree)   │  │ Editor     │  │ Viewer      │  │
│  └──────────┘  └────────────┘  └─────────────┘  │
│  Zustand stores · CodeMirror · Tailwind CSS     │
├─────────────────────────────────────────────────┤
│              Preload (contextBridge)             │
│         IPC whitelist · window.api.*             │
├─────────────────────────────────────────────────┤
│                 Main Process                     │
│  RequestEngine · CollectionStore · HistoryStore  │
│         Electron fetch · better-sqlite3          │
└─────────────────────────────────────────────────┘
```

Four-tier architecture with strict security boundaries:
- **Renderer** — React 19 UI with Zustand state management
- **Preload** — `contextBridge` IPC whitelist (no `nodeIntegration`; the window is sandboxed, its page runs under a Content-Security-Policy and holds no browser permissions, and the main process answers only the app's own page)
- **Main** — Electron main process handling HTTP engine, file stores, and SQLite
- **Shared** — TypeScript types shared across all tiers via `@shared/` alias

## Quick Start

```bash
npm install
npm run dev        # Start Vite dev server + Electron (hot reload)
npm run typecheck  # TypeScript validation
npm run build      # Full pipeline: typecheck → build → package
```

### Build Commands

| Command | Description |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run typecheck` | `tsc --noEmit` type checking |
| `npm run build` | Full production build + Electron packaging |
| `npm run build:renderer` | Vite build only (no packaging) |
| `npm run build:electron` | Electron Builder only (requires `dist/`) |
| `npm run preview` | Preview production build in browser |

### Testing

| Command | Description |
|---|---|
| `npm run test` | Playwright E2E tests against the Vite preview server (mocked `window.api`) |
| `npm run test:engine` | Playwright engine tests under host Node (3 `better-sqlite3` history tests skip unless the binding is Node-ABI — see note below) |
| `npm run test:electron` | Native Electron smoke tests — launches the real app via Playwright's `_electron.launch` with real IPC (run after `npm run build:renderer`) |
| `npm run test:update` | Vitest auto-updater service suite |
| `npm run rebuild:node` / `npm run rebuild:electron` | Flip the `better-sqlite3` native binding between host-Node and Electron ABIs (default after install: Electron ABI — app-working; run `rebuild:node` to unlock the 3 history tests, then `rebuild:electron` to restore) |

> **CI gate** — on every `v*` tag push, and on a manual run of the workflow from any branch (which never publishes): `test` (Playwright E2E), `updater-unit` (typecheck + Vitest), and `engine-node-abi` (strict Node-ABI engine suite) all run, and each OS `build` job runs the native Electron smoke (`npm run test:electron`) before packaging. The `release` job is blocked if any of them fails.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | Electron 39 |
| UI framework | React 19 + TypeScript 5.7 |
| State management | Zustand 5 |
| Code editor | CodeMirror 6 |
| Styling | Tailwind CSS 3 + Catppuccin Mocha |
| HTTP engine | Electron native `fetch` |
| Persistence | Filesystem (JSON) + SQLite (better-sqlite3) |
| Build | Vite 6 + electron-builder 26 |

## Data Storage

All user data lives in the Electron `userData` directory:

| Data | Location | Format |
|---|---|---|
| Collections & requests | `userData/collections/*.req.json`, `*.grp.json` | JSON |
| Environments | `userData/environments/*.json` | JSON |
| App settings | `userData/settings.json` | JSON |
| Response history | `userData/history.db` | SQLite (WAL mode) |

Active environment selection is persisted canonically in app settings. Startup restores a valid saved environment, while a missing or invalid selection falls back to Core. Cookie jars remain in memory for the app session and aren't persisted or imported from legacy default-session data. New response snapshots omit raw cookie values, but this doesn't purge legacy data or promise general response-body secret scrubbing. Strict and insecure transport jars are separate. History reopening uses the current request definition when available; deleted requests remain temporary metadata-only views, and bounded history data doesn't reconstruct unavailable request bodies or raw response bytes.

## Secret variables

Environment variables have three types:

- **Standard** values are visible and stored as plain text in the environment file.
- **Confidential** values are masked in the editor, previews and derived output, but stored as plain text on disk. Masking does not protect the file.
- **Secret** values are masked and encrypted at rest with the operating system's secret store: DPAPI on Windows, Keychain on macOS, or a recognized secure keyring on Linux. No account or application password is needed.

**Limits**

- Encryption depends on your OS account. Other applications running as your user can usually read a decrypted value, so Secret protects the file at rest, not against malware running as you.
- Ciphertext is bound to this computer and OS account. Copying the data folder to another machine or account, or restoring a backup there, can leave Secrets unreadable. Restiprocity never overwrites or discards unreadable ciphertext; you can replace or delete a value explicitly. Keep the original source for every Secret.
- There is no portable encrypted export and no app passphrase in this version.
- Without a usable secret store (for example a Linux desktop with no keyring, which reports `basic_text`), Secret values cannot be saved and the editor says why. Standard and Confidential values still save.
- Copy as cURL stops first when the command contains a Secret or Confidential value and copies only after you choose **Copy with secrets**. The clipboard can be read by other applications.
- A send that uses an unreadable Secret fails before any network activity. A request that doesn't use it is unaffected.
- **Show** reveals a masked value only while its environment is open in the editor.
- Changing a saved Secret or Confidential value to a less protected type asks for confirmation when you save, and says what changes: a Secret becomes plain text on disk, and a Standard value is shown unmasked.
- A Secret is encrypted together with its environment and variable name. If the stored value turns up under another name or in another environment, for example because something edited the files, Restiprocity refuses it there instead of using it, and says so. This does not stop a program that can decrypt as you, and a copy of your data folder from 0.3.1 or earlier still holds values without this tie. On macOS and Linux the operating system's encryption may not detect deliberate changes to a stored value, so treat this as protection against a value being copied, not against skilled tampering.

**Migrating older environments**

Environment files written by v0.3.0 and earlier store their secret values as plain text. Restiprocity reads them as Confidential and marks them **Unencrypted**. Use **Encrypt as Secret** on one value, or **Encrypt N value(s) as Secret** for the whole environment. A value that can't be encrypted stays as it was. Converting a Secret to Standard or Confidential writes it as plain text.

Old backups, exports, logs and copies of the data folder can still contain the plaintext. Restiprocity does not erase them.

**Backups and downgrades**

Restiprocity writes each environment file through a temporary file and a rename, so an interrupted save should leave the previous file in place. This is not a durability guarantee. Before you install an older version, back up `userData/environments`. An older build that doesn't know the encrypted field can show a Secret as masked and, if you save that environment, overwrite its ciphertext. Don't edit an environment with Secrets in a downgraded build.

Versions after 0.3.1 store Secrets in a newer format and convert existing ones the first time they start. If you go back to 0.3.1, it shows those Secrets as unreadable, refuses to send or reveal them, and keeps them as they are; they work again when you update.

**Imports**

Insomnia `confidentialKeys` and Postman secret values import as Confidential, so they are stored as plain text. The import report says so. Those files already held the values in plain text; change a value to Secret to encrypt it here.

## Tokens from another request

Many APIs want a login or token call first, then the returned token as `Authorization: Bearer …` on every other call.

1. Create the token request, for example `POST {{auth_base}}/oauth/token` with your credentials in the body (use Secret variables for them).
2. On its **Outputs** tab, turn on **Use this request's response as variables**. The defaults take `api_token` from the JSON field `/access_token`, refresh after 3600 seconds, read the lifetime from `/expires_in`, and resend once after HTTP 401. Fields are [JSON Pointers](https://www.rfc-editor.org/rfc/rfc6901): `/data/access_token`, `/items/0/id`. A value can also come from a response header or the whole body.
3. In any other request, use `{{api_token}}`: Auth → Bearer Token → `{{api_token}}`, or in a header, the URL or the body.

Sending a request that uses `{{api_token}}` runs the saved token request first when there is no fresh value for the selected environment, then sends the request with it. Later requests reuse the value until the refresh time, or until the response's `expires_in` less 10% (at most 30 seconds) if that is sooner; the next request after that fetches a new one. Nothing runs on a timer, so an idle app sends nothing. If a request sent with a cached value gets HTTP 401, the token request runs again and the request is sent once more with the new value (and the same `{{uuid}}` and `{{timestamp}}`); the response says so. A value fetched for that very send that still gets 401 is the answer, and NTLM requests are never resent. Sending the token request yourself also fills the cache.

Rules worth knowing:

- **Memory only.** Fetched values are never written to disk. A restart, **Clear cached values** on the Outputs tab, or editing the token request, its outputs, or any variable it uses (a password, say) means the next request fetches again. The response body of a request that provides outputs is not saved to history or to the request file either; the viewer shows it until you send something else.
- **Per environment.** Staging and Production each get their own value from the same token request.
- **Names are shared.** An output name can be provided by one request only, and it wins over an environment variable with the same name (the Outputs tab warns about that). Built-in names (`timestamp`, `uuid`, `randomInt`) can't be used. If the token request is deleted, `{{api_token}}` becomes an ordinary unknown variable and is sent as written.
- **One step.** A token request can't use another request's outputs.
- **Failures stop the send.** If the token request fails, returns a status outside 200–299, or the field is missing, the request is not sent and the error names the token request and the field. Nothing falls back to an older token.
- **Redirects.** A request that uses an output follows redirects only within the same origin, and never from HTTPS to HTTP.
- **Copy as cURL** includes a fresh cached value after the usual confirmation and never runs the token request; with no fresh value it explains how to get one.
- **Imports and older versions.** Collection exports include the output definitions (never values). An import turns off outputs whose name another request already provides, and says so. Versions up to 0.3.1 ignore outputs.
- **Insomnia response tags.** An Insomnia `{% response %}` tag that reads a request in the same export becomes an output of that request (named after it, such as `get_session_token_token`), and the tag becomes `{{get_session_token_token}}`. Simple JSONPath (`$.data.token`, `$['a'][0]`) becomes a JSON Pointer; header and raw-body tags become header and whole-body outputs. `when-expired` keeps its age as the refresh time, `always` becomes one second, and `never`/`no-history` fetch once per app session (shorter if the response's `expires_in` says so). Tags that read another request's outputs from a request that itself provides outputs, JSONPath beyond plain fields and indexes, XPath, the URL attribute, and requests missing from the export stay as written and are reported.

## Multipart uploads

Multipart file rows read regular files on the computer running Restiprocity; use absolute paths. File bytes are preserved, including empty and binary files. The complete encoded form is limited to **32 MiB**, including boundaries, part headers and text. Preparation buffers one complete body; this is not a streaming uploader, and the network runtime may make additional copies. Files use `application/octet-stream`.

Restiprocity generates multipart Content-Type, Content-Length and Transfer-Encoding behavior; authored values for these headers are ignored for multipart sends. File errors stop the request before OAuth or target-network activity. The timeout covers preparation, OAuth and waiting for response headers; the response keeps its existing idle timeout. Cancel stops further work, although a pending OS file read may finish before its handle can close. GET/HEAD do not read body files.

Copy as cURL keeps file paths rather than embedding bytes: cURL reads those files later and does not enforce this application's size limit. Commands target bash/zsh (including Git Bash). Export rejects NUL text/path arguments and field names containing `=`; the request editor can still send NUL text and `=` field names. Collections store paths, not copies of uploaded files.

OpenAPI import accepts only 3.0.x and 3.1.x JSON/YAML documents. Same-document JSON Pointer references are supported; external/file references are rejected without network or filesystem access. Relative servers use the editable https://example.invalid placeholder, and generated samples/parameters are drafts: review encoding, unsupported styles, auth configuration, and multipart file paths before sending. The importer maps JSON/text, URL-encoded form, and multipart bodies plus basic, bearer, API-key, and authorization-code/client-credentials OAuth settings; complex serialization, scripts, callbacks, and OpenAPI export remain deferred. Multipart file fields arrive disabled with no file selected. Import notes are grouped by kind, each naming up to five affected requests. Documents with more than 100,000 JSON values or 10,000 operations, request examples over 1 MiB, or converted collections over 16 MiB are rejected before anything is written. Every object, array, string, number, boolean, and null counts as a value, so the value limit is reached at roughly 2 MB of JSON and large API descriptions may be rejected. Postman collection variables and OpenAPI server values are imported as separate environments, which must be selected for those requests. Separately imported Postman environments are independent; combine or reparent variables in the environment editor when both are needed. Postman scripts and unsupported authentication or body types do not execute and are reported in the import results. Review imported file paths before sending multipart requests. Confidential values are stored as plaintext in local JSON; Secret values are encrypted at rest (see [Secret variables](#secret-variables)).

The Electron suite checks Copy as cURL through real IPC with the clipboard write instrumented. To additionally check the real system clipboard, run `$env:RESTIPROCITY_TEST_SYSTEM_CLIPBOARD="1"; npm run test:electron` in an interactive PowerShell desktop session. This overwrites the system clipboard; the separate round-trip test is skipped by default.

## Roadmap

- [x] OpenAPI 3.0/3.1 import with local references, request samples, supported auth, and transactional persistence
- [x] Binary-safe multipart file upload with bounded preparation, generated headers, cancellation, and a 32 MiB encoded-form limit
- [x] OAuth2 Client Credentials and Authorization Code with PKCE, loopback callback, refresh, binding-aware in-memory tokens, strict token transport, and cURL cache reuse
- [x] Tokens from another request: response outputs feed `{{variables}}`, refreshed lazily per environment, resent once after 401, kept in memory only
- [ ] Pre-request / post-response script execution engine (`RequestScripts` fields are persisted today but nothing runs them yet)
- [x] Environment management build-out: environment editing, nested interpolation, and the dedicated interpolation editor are implemented. Secret values are encrypted at rest with the operating system's secret store, as specified in [SECRET_STORAGE_SPEC.md](./SECRET_STORAGE_SPEC.md).
- [ ] Broader automated test coverage (Vitest is already used for the updater suite in `tests/update/`)
- [ ] Collaborative workspaces (optional cloud sync)

## Downloads

- [Latest release](https://github.com/dwyerwilliam/Restiprocity/releases/latest)
- [Release history](https://github.com/dwyerwilliam/Restiprocity/releases)
- Versioned release notes: [`releases/`](./releases/)

Download the release asset for your platform from the latest release page.

Releases after 0.3.1 can be checked before you run them. Each one carries a `SHA256SUMS.txt`, and GitHub holds a signed record that the files were built from this repository by its release workflow:

```
sha256sum -c --ignore-missing SHA256SUMS.txt
gh attestation verify Restiprocity-Setup-<version>.exe --repo dwyerwilliam/Restiprocity
```

The first command (run in the folder with your download and `SHA256SUMS.txt`) detects a damaged or altered download. The second, with the [GitHub CLI](https://cli.github.com/), confirms where the file was built. Neither is code signing: Windows and macOS still show their unknown-publisher warnings.

A response you save to a file is marked as downloaded from the internet (Windows and macOS), so the system warns before running it. When a server suggests a file name that would run when opened, such as `report.pdf.exe`, the save dialog offers it with a harmless extension added; you can still type any name.

## Updates and platform limits

The in-app updater is deliberately **Windows-only**. Packaged Windows NSIS builds check the stable GitHub Release `latest` channel when the app starts, with prereleases excluded (`allowPrerelease=false`), download a newer installer in the background, and wait for you to choose **Restart to update**. With the current per-machine NSIS configuration, normal update application reuses the registered install directory; changing the install directory is still an installer choice. The first updater-capable release must be installed manually: an older build cannot update itself with updater code it does not contain.

Windows installers are currently unsigned. SmartScreen may therefore show **Unknown publisher**, and a per-machine update may request Windows UAC elevation. If UAC is cancelled, the app has already exited and remains on the old version; the exited app cannot observe or report that cancellation, so relaunch it and check again. The updater's SHA-512 metadata helps detect a changed or incomplete download, but a checksum is not code-signing and does not establish publisher identity or make an unsigned installer trusted.

macOS and Linux builds do not use the in-app updater. Download and install those releases manually from the latest release page.

Maintainers can manually dispatch the [Windows updater QA workflow](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/update-qa.yml) to exercise a disposable `updater-test` prerelease N-to-N+1 rollout. Those releases use test-only versions, are always prereleases with `latest=false`, and are deleted with their tags by the workflow; they are not a production update channel.

## License

MIT
