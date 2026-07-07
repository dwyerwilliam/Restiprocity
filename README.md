# Restiprocity

> A local-first desktop REST API testing client. No cloud dependency. Your data stays yours.

[![Electron](https://img.shields.io/badge/Electron-33.x-blue.svg)](https://www.electronjs.org/)
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
| Desktop runtime | Electron 33 |
| UI framework | React 19 + TypeScript 5.7 |
| State management | Zustand 5 |
| Code editor | CodeMirror 6 |
| Styling | Tailwind CSS 3 + Catppuccin Mocha |
| HTTP engine | Electron native `fetch` |
| Persistence | Filesystem (JSON) + SQLite (better-sqlite3) |
| Build | Vite 6 + electron-builder 25 |

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

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | [Restiprocity-0.1.10-arm64.dmg](https://github.com/dwyerwilliam/Restiprocity/releases/download/v0.1.10/Restiprocity-0.1.10-arm64.dmg) |
| Windows | [Restiprocity.Setup.0.1.10.exe](https://github.com/dwyerwilliam/Restiprocity/releases/download/v0.1.10/Restiprocity.Setup.0.1.10.exe) |
| Linux | [Restiprocity-0.1.10-x86_64.AppImage](https://github.com/dwyerwilliam/Restiprocity/releases/download/v0.1.10/Restiprocity-0.1.10-x86_64.AppImage) |

Full changelog: [Releases](https://github.com/dwyerwilliam/Restiprocity/releases)

## License

MIT
