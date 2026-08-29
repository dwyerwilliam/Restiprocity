# Restiprocity — Agent Instructions

## What this is

Electron desktop REST API testing client (Insomnia alternative). Local-first, no cloud dependency.

## Task memory

- `HANDOFF.md` (repo root) — durable cross-session task memory for in-flight work. Read it before starting a new pass; update it as work progresses.

## Runtime

- Node.js 24.19.0 (`>=24.19.0 <25`) is pinned by [`.node-version`](./.node-version).
- The host Node runtime used for tooling/tests is not Electron's native ABI.

## Quick commands

| Command | What it does |
|---|---|
| `npm run dev` | Start Vite dev server + Electron (hot reload) — **single command, single terminal** |
| `npm run typecheck` | `tsc --noEmit` — run before any PR |
| `npm run test` | Run Playwright E2E tests against Vite preview server |
| `npm run test:ui` | Run Playwright tests in interactive UI mode |
| `npm run test:engine` | Playwright engine tests under host Node (3 historyStore tests skip unless binding is Node-ABI) |
| `npm run test:electron` | Native Electron smoke tests — real app launch via `_electron.launch`, real IPC (requires `npm run build:renderer` first) |
| `npm run test:update` | Vitest auto-updater service suite |
| `npm run rebuild:node` | Rebuild native modules (better-sqlite3) for host Node — unlocks the 3 historyStore tests |
| `npm run rebuild:electron` | Restore native modules to Electron ABI (app-working binding) — run after Node-ABI rebuilds |
| `npm run build` | Full pipeline: typecheck → vite build → electron-builder |
| `npm run build:renderer` | Vite build only (no Electron packaging) |
| `npm run build:electron` | Electron Builder only (assumes `dist/` exists) |
| `npm run preview` | Preview production build in browser |

**Gate order**: `typecheck` → `test` (E2E) → `test:electron` (native smoke) → `build`. Always run before committing.

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

**Playwright** E2E tests in `tests/e2e/` (11 specs) run against the Vite preview server (`npm run preview`), not the Electron app. `window.api` is mocked via `page.addInitScript()` in each test file. **Playwright** engine tests in `tests/engine/` (15 specs) exercise `RequestEngine`, stores, and response pipeline logic directly (`npm run test:engine`). **Playwright** native Electron smoke tests in `tests/electron/` (1 spec) launch the real Electron runtime via `_electron.launch` against the built app (`npm run test:electron`, requires `npm run build:renderer` first; isolated userData via `RESTIPROCITY_TEST_USER_DATA`). A separate **Vitest** suite in `tests/update/` (1 spec) covers the auto-updater service (`npm run test:update`).

| Test file | What it covers |
|---|---|
| `tests/e2e/main-page.spec.ts` | UI smoke tests — sidebar, tree, env search, version bar |
| `tests/e2e/httpbin-requests.spec.ts` | Request/response flow — GET/POST to httpbin, method switching, body editor, response viewer tabs |
| `tests/e2e/curl-import.spec.ts`, `updater.spec.ts`, `ntlm-auth.spec.ts` | cURL import, in-app updater UI, NTLM auth flows |
| `tests/engine/requestEngine.*.spec.ts` | Auth, variables, streaming, net, error, and characterization coverage for the request engine |
| `tests/electron/app-smoke.spec.ts` | Native Electron smoke — real app launch via `_electron.launch`, real IPC bridge, isolated userData |
| `tests/update/autoUpdater.spec.ts` | Auto-update version checks and rollout behavior |

**CI gate**: `test` (Playwright E2E), `updater-unit` (typecheck + Vitest), and `engine-node-abi` (strict Node-ABI engine suite) all run on every `v*` tag push; each OS `build` job also runs the native Electron smoke (`npm run test:electron`). The `release` job depends on all four plus `build` and is blocked if any fails.

### better-sqlite3 ABI note (engine tests)

`better-sqlite3` is a native module whose single binding is ABI-locked to one runtime. The desktop app needs it built for **Electron's** ABI, but `test:engine` runs under **plain Node** — a different ABI. So `tests/engine/historyStore.responses.spec.ts` is **ABI-aware**: it probes the binding at load and, if it can't load in the test runtime, **skips the 3 historyStore tests with an actionable reason** (not a red failure).

- Default after `npm install`: binding is **Electron-ABI** (via `postinstall`) → app works, the 3 historyStore tests **skip**.
- To actually run those 3 tests locally: `npm run rebuild:node`, then `npm run test:engine`; afterwards `npm run rebuild:electron` restores the app-working binding.
- **Do not "fix" a skip by reverting to a static `import Database from 'better-sqlite3'`** — that re-introduces the raw ABI failure. See `HANDOFF.md` (2026-08-24) for the full root cause.

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

- OAuth2 token exchange only supports the `client_credentials` grant (`RequestEngine.getOAuth2Token()` + `authTransport.ts`) — Authorization Code, Password, and PKCE exist as UI/type options but are not wired to a real token exchange
- Multipart body handling (`RequestEngine.buildMultipartBody()`) serializes text and file fields, but files are read as UTF-8 and always labeled `application/octet-stream` — binary file uploads are not robustly supported
- Request/response scripts (`RequestScripts.preRequest` / `afterResponse` in `@shared/types`) are persisted in the data model but have no execution path — no script editor UI, no IPC channel, and no sandboxed execution engine exist yet
- Granular response timings (DNS, TCP, TLS) are approximated — Electron doesn't expose them easily
- Import parser handles native format and cURL (`src/shared/curlImport.ts`); Postman/Insomnia/OpenAPI import are not implemented yet

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
- Linux target: AppImage (x64)
- `compression: "maximum"` enabled — macOS DMG ~92 MB, Windows EXE ~82 MB

## CI / Release workflow

- **Trigger**: `v*` tag push to `primary` branch (`.github/workflows/build-release.yml`)
- **Jobs**: `build` (macOS + Windows + Ubuntu matrix — packages dmg/nsis/AppImage; each OS job also runs the native Electron smoke via `npm run test:electron`) → `test` (Playwright E2E) + `updater-unit` (typecheck + Vitest updater suite) + `engine-node-abi` (strict Node-ABI engine suite) → `release` (depends on all four)
- **Release job**: downloads all platform artifacts, strips unpacked dirs/`.app` bundles, validates the Windows updater asset contract (installer + blockmap + `latest.yml`, versions matching `package.json`), then creates a GitHub release with `.exe`, `.dmg`, `.AppImage`, `.blockmap`, and `latest.yml` assets
- **Before tagging**: add `releases/vX.Y.Z.md` matching the tag; the workflow fails if the file is missing or the tag doesn't match `package.json` version
- Artifacts use null-delimited `find -print0` + `mapfile` to handle spaces in filenames
- **Updater QA**: `.github/workflows/update-qa.yml` is a separate, manually-dispatched workflow that builds disposable `updater-test` N→N+1 prereleases on Windows to validate packaged update behavior, then deletes them — it is not part of the production release pipeline
