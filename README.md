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
- **Rich Request Editor** — Headers, query parameters, raw body (JSON/XML/HTML), form-urlencoded, and multipart form fields (binary file uploads still in progress — see Roadmap)
- **Authentication** — Bearer token, API key, Basic auth, NTLM, OAuth2 Client Credentials (Authorization Code, Password, and PKCE are configurable in the UI but not yet wired to a real token exchange — see Roadmap)
- **NTLM Windows Auth Context** — On Windows, NTLM authentication defaults to using your current logged-in user's credentials. Toggle off to provide manual username/password instead
- **Environment Management** — Edit environments and variables, create nested environments, and resolve nested `{{variable}}` references with parent fallback. Cycles and substituted output over 1 MiB report actionable interpolation errors; unchanged literal strings remain valid. Built-ins (`{{timestamp}}`, `{{uuid}}`, `{{randomInt}}`) take precedence over user values and share one generated context per send. Secret values remain plaintext in local files, and preview samples are separate from send contexts.
- **Response Viewer** — Body, headers, timing breakdown (DNS/TCP/TLS measured from Chromium's network log, plus TTFB and download, with new versus reused connections labeled), and live cookie observations. Cookie jars are app-session only, and restored snapshots show redacted cookie data.
- **Request History** — SQLite-backed private history with request identity and filtering by status, URL, and date range. Existing requests reopen with their current definition and draft without sending. Deleted requests open as temporary, metadata-only views with Send disabled. Historical details are bounded and redacted where needed, and unavailable request or response data isn't reconstructed. Existing blank legacy rows aren't rewritten.
- **Collection Management** — Hierarchical request groups persisted as JSON files on disk. Export a request, a folder, or the whole collection to a `.restiprocity.json` file and import it back (imports get fresh IDs and never overwrite existing items). Insomnia exports (v4 JSON or v5 YAML) import the same way, with their environments; anything that can't be carried over is listed after the import. **Copy as cURL** puts a bash/zsh command for any request on the clipboard, with environment variables resolved. Invalid moves are rejected without mutating collection files and remain recoverable for retry.
- **Catppuccin Mocha Theme** — Dark-first UI built with Tailwind CSS
- **Local-First** — All data stored in `userData/`. No telemetry, no cloud sync, no account required

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
- **Preload** — `contextBridge` IPC whitelist (no `nodeIntegration`)
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

> **CI gate** — on every `v*` tag push: `test` (Playwright E2E), `updater-unit` (typecheck + Vitest), and `engine-node-abi` (strict Node-ABI engine suite) all run, and each OS `build` job runs the native Electron smoke (`npm run test:electron`) before packaging. The `release` job is blocked if any of them fails.

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

## Roadmap

- [ ] Postman / OpenAPI import (a Postman parser exists in `CollectionStore` but isn't wired up or tested)
- [ ] Robust multipart file upload (binary-safe — current multipart support is text-field only)
- [ ] OAuth2 Authorization Code, Password, and PKCE token exchange (Client Credentials is already implemented)
- [ ] Pre-request / post-response script execution engine (`RequestScripts` fields are persisted today but nothing runs them yet)
- [x] Environment management build-out: environment editing, nested interpolation, and the dedicated interpolation editor are implemented. Secret values remain plaintext in local files; encrypted secret storage remains deferred in [SECRET_STORAGE_SPEC.md](./SECRET_STORAGE_SPEC.md).
- [ ] Broader automated test coverage (Vitest is already used for the updater suite in `tests/update/`)
- [ ] Collaborative workspaces (optional cloud sync)

## Downloads

- [Latest release](https://github.com/dwyerwilliam/Restiprocity/releases/latest)
- [Release history](https://github.com/dwyerwilliam/Restiprocity/releases)
- Versioned release notes: [`releases/`](./releases/)

Download the release asset for your platform from the latest release page.

## Updates and platform limits

The in-app updater is deliberately **Windows-only**. Packaged Windows NSIS builds check the stable GitHub Release `latest` channel when the app starts, with prereleases excluded (`allowPrerelease=false`), download a newer installer in the background, and wait for you to choose **Restart to update**. With the current per-machine NSIS configuration, normal update application reuses the registered install directory; changing the install directory is still an installer choice. The first updater-capable release must be installed manually: an older build cannot update itself with updater code it does not contain.

Windows installers are currently unsigned. SmartScreen may therefore show **Unknown publisher**, and a per-machine update may request Windows UAC elevation. If UAC is cancelled, the app has already exited and remains on the old version; the exited app cannot observe or report that cancellation, so relaunch it and check again. The updater's SHA-512 metadata helps detect a changed or incomplete download, but a checksum is not code-signing and does not establish publisher identity or make an unsigned installer trusted.

macOS and Linux builds do not use the in-app updater. Download and install those releases manually from the latest release page.

Maintainers can manually dispatch the [Windows updater QA workflow](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/update-qa.yml) to exercise a disposable `updater-test` prerelease N-to-N+1 rollout. Those releases use test-only versions, are always prereleases with `latest=false`, and are deleted with their tags by the workflow; they are not a production update channel.

## License

MIT
