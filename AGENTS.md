# Restiprocity — Agent Instructions

## What this is

Electron desktop REST API testing client (Insomnia alternative). Local-first, no cloud dependency.

## Quick commands

| Command | What it does |
|---|---|
| `npm run dev` | Start Vite dev server + Electron (hot reload) — **single command, single terminal** |
| `npm run typecheck` | `tsc --noEmit` — run before any PR |
| `npm run test` | Run Playwright E2E tests against Vite preview server |
| `npm run test:ui` | Run Playwright tests in interactive UI mode |
| `npm run build` | Full pipeline: typecheck → vite build → electron-builder |
| `npm run build:renderer` | Vite build only (no Electron packaging) |
| `npm run build:electron` | Electron Builder only (assumes `dist/` exists) |
| `npm run preview` | Preview production build in browser |

**Gate order**: `typecheck` → `test` → `build`. Always run both before committing.

## Architecture — 4 tiers

```
src/
  main/          ← Electron main process (HTTP engine, stores, IPC handlers)
  preload/       ← contextBridge IPC whitelist (exposes window.api)
  renderer/      ← React 19 UI (Zustand stores, components)
  shared/        ← TypeScript types (Request, Response, Environment, etc.)
```

**Entry points:**
- Main: `src/main/index.ts` — creates BrowserWindow, initializes stores/engine, sets up IPC
- Preload: `src/preload/index.ts` — exposes `window.api` via `contextBridge`
- Renderer: `src/renderer/main.tsx` → `App.tsx` — mounts React tree

**Security**: `nodeIntegration: false`, `contextIsolation: true`. Renderer has zero direct network access — all HTTP goes through main process via IPC.

## Path aliases (configured in tsconfig + vite)

| Alias | Resolves to |
|---|---|
| `@/` | `src/` |
| `@main/` | `src/main/` |
| `@preload/` | `src/preload/` |
| `@renderer/` | `src/renderer/` |
| `@shared/` | `src/shared/` |

Always use aliases for cross-tier imports. The `@shared` alias is the only way main/preload can import types from `src/shared/`.

## Data persistence

| Data | Where | Format |
|---|---|---|
| Collections, requests, groups | `userData/collections/*.req.json`, `*.grp.json` | JSON files |
| Environments | `userData/environments/*.json` | JSON files |
| App settings | `userData/settings.json` | JSON |
| Response history | `userData/history.db` | SQLite (better-sqlite3, WAL mode) |

User data lives in `app.getPath('userData')`. Never hardcode paths.

## IPC channel convention

Channels use `module:action` naming (e.g. `request:send`, `collection:list`, `env:switch`). See `src/preload/index.ts` `Channels` object for the full list. All renderer→main communication goes through `window.api.*` methods exposed by the preload script.

## Renderer state

Zustand stores in `src/renderer/stores/index.ts`:
- `useUiStore` — UI state (selected node, active tabs, sidebar)
- `useRequestStore` — current request/response, sending state
- `useEnvironmentStore` — environments, variable resolution (`{{var}}` interpolation)
- `useSettingsStore` — app settings
- `useConsoleStore` — console log messages from main process

## Main process stores

- `CollectionStore` (`src/main/stores/collectionStore.ts`) — filesystem-based CRUD for requests, groups, environments, settings
- `HistoryStore` (`src/main/stores/historyStore.ts`) — SQLite-backed response history
- `RequestEngine` (`src/main/engine/requestEngine.ts`) — executes HTTP requests via Electron's `fetch`

## Testing

**Playwright** E2E tests in `tests/e2e/`. Tests run against the Vite preview server (`npm run preview`), not the Electron app. `window.api` is mocked via `page.addInitScript()` in each test file.

| Test file | What it covers |
|---|---|
| `tests/e2e/main-page.spec.ts` | UI smoke tests — sidebar, tree, env search, version bar |
| `tests/e2e/httpbin-requests.spec.ts` | Request/response flow — GET/POST to httpbin, method switching, body editor, response viewer tabs |

**CI gate**: Tests run on every `v*` tag push. Release is blocked if tests fail.

### Key UI selectors (for writing new tests)

| Element | Selector | Notes |
|---|---|---|
| Method dropdown | `select` | Native `<select>` with GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| URL bar | `input[placeholder="Enter request URL"]` | Native `<input>` |
| Send button | `button:has-text("Send")` | Shows "Sending..." while disabled |
| Body textarea | `textarea` | Appears only when "Raw" body type selected |
| Response status | `text="200 OK"` etc. | Color-coded by status range |
| Response tabs | `button:has-text("Body")`, `"Headers"`, `"Timings"`, `"Cookies"` | In response viewer |
| Sidebar | `[data-testid="sidebar"]` | Only element with explicit test ID |

## Known TODOs (in code)

- Environment variable resolution in `RequestEngine.resolveVariables()` is a stub — returns request as-is
- OAuth2 token exchange in `RequestEngine.applyAuthHeaders()` is a stub
- Granular response timings (DNS, TCP, TLS) are approximated — Electron doesn't expose them easily
- Import parser only handles native format — Postman/Insomnia/OpenAPI/cURL not implemented yet
- Multipart body handling returns `null` — not implemented

## Styling

- **Tailwind CSS** with Catppuccin Mocha dark palette
- CSS variables in `src/renderer/styles/globals.css` (`--color-*`)
- Custom Tailwind colors in `tailwind.config.js` (`primary.*`, `sidebar.*`, `editor.*`)
- Tailwind scans `./src/renderer/**/*.{js,ts,jsx,tsx}` only — adding components elsewhere won't work
- Custom utility class: `.flex-1-min` (`flex: 1 1 0`) used throughout layout

## Electron build notes

- `vite-plugin-electron` builds main/preload to `dist-electron/`
- `electron-builder` packages from `dist/` (renderer) + `dist-electron/` (main)
- Output goes to `releases/artifacts/` directory
- `better-sqlite3` and `electron-store` are externalized in Rollup (native modules)
- Windows target: NSIS installer
- macOS target: DMG (arm64), maximum compression, ASAR packaging
- `compression: "maximum"` enabled — macOS DMG ~92 MB, Windows EXE ~82 MB

## CI / Release workflow

- **Trigger**: `v*` tag push to `primary` branch
- **Pipeline**: matrix build (macOS + Windows) → test → release
- **Test job**: runs Playwright E2E against Vite preview, blocks release on failure
- **Build job**: parallel macOS/Windows runners, uploads artifacts
- **Release job**: downloads artifacts, creates GitHub release with `.exe` + `.dmg` only
- Artifacts use null-delimited `find -print0` + `mapfile` to handle spaces in filenames
