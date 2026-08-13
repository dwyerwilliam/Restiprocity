# Restiprocity

> A local-first desktop REST API testing client. No cloud dependency. Your data stays yours.

[![Electron](https://img.shields.io/badge/Electron-39.x-blue.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.x-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Build & Release](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/build-release.yml/badge.svg)](https://github.com/dwyerwilliam/Restiprocity/actions/workflows/build-release.yml)
[![Latest Release](https://img.shields.io/github/v/release/dwyerwilliam/Restiprocity?label=latest)](https://github.com/dwyerwilliam/Restiprocity/releases/latest)

## Features

- **Full HTTP Method Support** — GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- **Rich Request Editor** — Headers, query parameters, raw body (JSON/XML/HTML), form-urlencoded, and multipart
- **Authentication** — Bearer token, API key, Basic auth, NTLM, OAuth2 (Authorization Code, Client Credentials, Password, PKCE)
- **NTLM Windows Auth Context** — On Windows, NTLM authentication defaults to using your current logged-in user's credentials. Toggle off to provide manual username/password instead
- **Environment Management** — `{{variable}}` interpolation with inheritance chains and built-in variables (`{{timestamp}}`, `{{uuid}}`, `{{randomInt}}`)
- **Request Scripts** — Pre-request and post-response JavaScript hooks via CodeMirror
- **Response Viewer** — Body, headers, timing breakdown (DNS/TCP/TLS/TTFB), and cookies tabs
- **Request History** — SQLite-backed history with filtering by status, URL, and date range
- **Collection Management** — Hierarchical request groups persisted as JSON files on disk
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

## Roadmap

- [ ] Postman / Insomnia / OpenAPI import
- [ ] Multipart file upload support
- [ ] OAuth2 token exchange flow
- [ ] Granular response timings (native DNS/TCP/TLS)
- [ ] Environment management build-out (multiple environments, edit UI, interpolation editor)
- [ ] Test framework integration (Vitest)
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
