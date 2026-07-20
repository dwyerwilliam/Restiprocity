# Restiprocity — Functional Specification

## 1. Overview

**Restiprocity** is an Electron-based desktop REST API testing client targeting feature parity with Insomnia. This document defines the functional scope, architecture, data model, and user workflows for V1.

---

## 2. Goals & Non-Goals

### Goals (V1)
- Full-featured REST/HTTP client with request composition, execution, and response inspection.
- Collection management with nested folders, environments, and variable templating.
- Authentication support for the most common schemes (Bearer, API Key, Basic, OAuth 2.0).
- Local-first data storage with import/export interoperability.
- Clean, modern desktop UI built with Electron + React + TypeScript.

### Non-Goals (V1)
- GraphQL, WebSocket, SSE, gRPC support (defer to V2).
- Cloud sync, collaboration, or multi-user features.
- Plugin ecosystem.
- Mock servers.
- AI/MCP integration.

---

## 3. Architecture

### 3.1 Tech Stack
| Layer | Technology |
|---|---|
| Desktop framework | Electron (latest LTS) |
| Renderer UI | React 19 + TypeScript |
| Styling | Tailwind CSS |
| State management | Zustand (renderer UI) + custom store (domain) |
| Persistence | Filesystem (JSON) for collections/requests + SQLite for history/metadata |
| Network engine | Electron native `fetch` in the main process (not renderer) |
| Build/Packaging | Vite (renderer) + Electron Builder |
| Code editing | CodeMirror 6 (for request body, headers, scripts) |

### 3.2 Process Model
```
┌─────────────────────────────────────────────┐
│  Main Process                               │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ Preload     │  │ Request Engine       │  │
│  │ (IPC Bridge)│  │ (HTTP client, auth,  │  │
│  └─────┬───────┘  │  cookies, proxy, TLS)│  │
│        │          └──────────┬───────────┘  │
│        │                    │               │
├────────┼────────────────────┼───────────────┤
│        │         IPC        │               │
├────────┼────────────────────┼───────────────┤
│        ▼                    ▲               │
│  Renderer Process           │               │
│  ┌──────────────────────────┴────────────┐  │
│  │  React UI: Request Editor,            │  │
│  │  Response Viewer, Collection Tree,    │  │
│  │  Environment Manager, Settings        │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- **Renderer**: UI only. No direct network access for user requests.
- **Main Process**: Owns all HTTP execution, auth flows, cookie jars, TLS/cert handling.
- **Preload**: Exposes narrow IPC methods via `contextBridge`. No raw API exposure.

### 3.3 Security
- `nodeIntegration: false`, `contextIsolation: true` in all BrowserWindows.
- Sandboxed preload with explicit method whitelist.
- User data stored in `app.getPath('userData')`.

---

## 4. Data Model

### 4.1 Core Entities

```
Workspace
├── RequestGroup (folder)
│   ├── Request
│   ├── RequestGroup (nested)
│   └── [environment, auth, scripts inherited]
├── Request
└── [environment, auth, scripts]

Environment
├── Base Environment
└── Sub-Environment (overrides base)

Request
├── url
├── method
├── headers[]
├── parameters[] (query)
├── body (raw / form-urlencoded / multipart / none)
├── authentication
├── scripts (pre-request, after-response)
└── settings (redirect, timeout, proxy, cookies)

Response
├── requestId
├── status
├── statusText
├── headers[]
├── body
├── timings
├── timestamp
└── size
```

### 4.2 Storage Strategy
| Data | Storage | Format |
|---|---|---|
| Collections, Requests, Environments | Filesystem (`userData/collections/`) | JSON files |
| Response history | SQLite (`userData/history.db`) | Structured rows |
| App settings, UI state | `electron-store` (JSON) | Key-value |
| Session cache (active env, selections) | In-memory (Zustand) | Reactive state |

### 4.3 Current v2 Request/Response State

- **Canonical flow**: requests are composed in the renderer, sent through IPC to the main process, executed there, and returned as v2 responses for preview, history, and download handling.
- **v2 data model**: request and response state is versioned around `Request`, `ResponseV2`, and persisted v2 snapshots, with preview data carrying the bounded text, image, or download representation used by the UI.
- **Request send**: covered by E2E request send flows and engine transport tests, including success, failure, redirect, and cancellation paths.
- **Response preview**: covered by preview rendering tests for JSON, XML, HTML, SVG, text copy states, image rendering, and download states.
- **Lifecycle**: covered by IPC response lifecycle tests, engine response operation tests, and response download coordinator coverage for ownership, cancel, progress, completion, and disposal behavior.
- **Persistence**: covered by request editor persistence, collection response persistence, history persistence, and v2 response contract tests.
- **Test coverage matrix**:

| Area | Coverage | Current status |
|---|---|---|
| Request send | `tests/e2e/httpbin-requests.spec.ts`, `tests/e2e/request-send-error.spec.ts`, `tests/engine/requestEngine.characterization.spec.ts`, `tests/engine/requestEngine.errors.spec.ts` | Covered |
| Response preview | `tests/e2e/response-previewer.spec.ts`, `tests/engine/responsePreview.spec.ts`, `tests/engine/responseBodyCollector.spec.ts`, `tests/engine/responseDownloadCoordinator.spec.ts` | Covered |
| Response lifecycle | `tests/engine/ipcResponseLifecycle.spec.ts`, `tests/e2e/response-operation.spec.ts`, `tests/engine/responseDownloadCoordinator.spec.ts` | Covered |
| IPC lifecycle | `tests/engine/ipcResponseLifecycle.spec.ts` | Covered |
| Persistence | `tests/e2e/request-editor-persistence.spec.ts`, `tests/engine/collectionStore.responses.spec.ts`, `tests/engine/historyStore.responses.spec.ts`, `tests/engine/responseContracts.spec.ts` | Covered |

---

## 5. Feature Specifications

### 5.1 Request Workbench

#### 5.1.1 Request Editor
- **URL bar**: Protocol, host, port, path input with autocomplete.
- **Method selector**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
- **Headers editor**: Key-value table with add/remove/clear.
- **Query parameters**: Key-value table, auto-merged into URL on send.
- **Body editor** (tabbed):
  - None
  - Raw (JSON, XML, Text, HTML, JavaScript) — syntax-highlighted via CodeMirror
  - Form URL-encoded (key-value)
  - Multipart form-data (key-value with file upload support)
- **Authentication selector**: Per-request auth with inline configuration.
- **Send button**: Triggers request execution via IPC → main process.

#### 5.1.2 Request Settings (per-request)
- Redirect: Follow / Do not follow
- Timeout: Configurable in ms (default: 30000)
- Proxy: Manual proxy configuration (host, port, auth)
- Cookies: Enable/disable cookie jar for request
- User-Agent: Override default user agent
- Certificate: Client certificate selection (future)

### 5.2 Response Viewer

- **Status bar**: HTTP status code, status text, duration, content size.
- **Tabs**:
  - **Body**: Syntax-highlighted rendering (JSON tree, XML, HTML preview, plain text, image rendering).
  - **Headers**: Response headers as key-value table.
  - **Timings**: DNS, TCP, TLS, TTFB, download breakdown.
  - **Cookies**: Cookies set by the response.
- **Save response**: Persist to history (auto-saved to SQLite).
- **Copy response**: Copy body/headers to clipboard.
- **Download response**: Save body to disk.

### 5.3 Collections & Folders

- **Tree navigation**: Left sidebar with collapsible folder tree.
- **CRUD operations**: Create, rename, duplicate, delete requests and folders.
- **Drag-and-drop**: Reorder and nest folders/requests.
- **Folder-level inheritance**: Environment, auth, and scripts cascade to child requests.
- **Export/Import**:
  - Export: Single request, folder, or entire collection as JSON.
  - Import: Insomnia `.yaml`/`.json`, Postman collection v2.1, cURL command, OpenAPI spec.

### 5.4 Environments & Variables

- **Environment manager**: Create, edit, switch environments from dropdown.
- **Base + sub-environments**: Sub-env overrides base values.
- **Variable types**:
  - Standard key-value
  - Secret values (masked in UI, not logged)
- **Template tags**: `{{ variable_name }}` interpolation in URLs, headers, bodies, and parameters.
- **Built-in variables**: `{{timestamp}}`, `{{randomInt}}`, `{{uuid}}`, `{{baseURL}}`.

### 5.5 Authentication

| Type | V1 Support | Notes |
|---|---|---|
| None | ✅ | — |
| Bearer Token | ✅ | Token input, optional prefix |
| API Key | ✅ | Key + value in header or query |
| Basic Auth | ✅ | Username + password |
| OAuth 2.0 | ✅ | Authorization Code, Client Credentials, Password, PKCE |
| Digest | V2 | — |
| NTLM | V2 | — |
| AWS IAM v4 | V2 | — |
| OAuth 1.0 | V2 | — |

### 5.6 Response History

- Persistent history of all sent requests and received responses.
- Filterable by date, status code, request URL.
- Click-to-reopen: Re-load a past request/response pair into the workbench.
- Clear history (all or filtered).

### 5.7 Code Generation

- Generate client-side code snippets from any request.
- Supported languages (V1): JavaScript (fetch), cURL, Python (requests), Node.js (axios).
- Copy-to-clipboard button.

### 5.8 Pre-Request & After-Response Scripts

- **Pre-request script**: JavaScript executed before sending. Can modify URL, headers, body, auth.
- **After-response script**: JavaScript executed after receiving. Can assert response, extract values, set variables.
- **Script scope**: Per-request or inherited from parent folder.
- **Sandboxed execution**: Scripts run in isolated VM context with limited API access.
- **Console output**: Script logs visible in a dedicated console panel.

---

## 6. UI Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  Menu Bar: File | Edit | View | Tools | Help                    │
├──────────────┬───────────────────────────────────────────────────┤
│              │                                                   │
│  ┌──────────┐│  ┌─────────────────────────────────────────────┐ │
│  │ Sidebar  ││  │  Request Editor                             │ │
│  │          ││  │  [Method] [URL]  [Send]                     │ │
│  │ ● Coll   ││  ├─────────────────────────────────────────────┤ │
│  │   ├ Req1 ││  │  Headers  │ Params  │ Body  │ Auth         │ │
│  │   ├ Req2 ││  ├─────────────────────────────────────────────┤ │
│  │   └ Fold ││  │  [Editor area]                              │ │
│  │   ├ Req3 ││  │                                              │ │
│  └──────────┘│  └─────────────────────────────────────────────┘ │
│              │                                                   │
│  ┌──────────┐│  ┌─────────────────────────────────────────────┐ │
│  │ Envs     ││  │  Response Viewer                             │ │
│  │ ● Dev    ││  │  200 OK  |  142ms  |  2.4 KB               │ │
│  │ ● Prod   ││  ├─────────────────────────────────────────────┤ │
│  └──────────┘│  │  Body  │ Headers │ Timings │ Cookies       │ │
│              │  │  [Response content]                         │ │
│              │  └─────────────────────────────────────────────┘ │
├──────────────┴───────────────────────────────────────────────────┤
│  Status Bar: SQLite OK  |  Env: Dev  |  v0.1.0                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Request send latency < 100ms (IPC overhead). UI renders at 60fps. |
| Memory | Idle memory < 200MB. Response bodies > 10MB stream to disk. |
| Offline | Fully functional offline. No cloud dependency. |
| Platforms | Windows 10+, macOS 12+, Linux (Ubuntu 22.04+). |
| Accessibility | Keyboard navigation for all primary actions. ARIA labels on interactive elements. |
| i18n | Architecture ready for localization (strings externalized). English-only for V1. |

---

## 8. Import/Export Formats

| Format | Import | Export | Notes |
|---|---|---|---|
| Restiprocity native (JSON) | ✅ | ✅ | Canonical format |
| Insomnia (YAML/JSON) | ✅ | | — |
| Postman Collection v2.1 | ✅ | ✅ | Most common interchange |
| cURL command | ✅ | ✅ | Paste or drag-drop |
| OpenAPI 3.x (YAML/JSON) | ✅ | ✅ | Generates collection from spec |
| HAR | | ✅ | Export response history |

---

## 9. Settings

| Category | Options |
|---|---|
| General | Theme (light/dark/system), language, font size |
| Network | Default timeout, redirect behavior, proxy settings, TLS version |
| Editor | Tab size, word wrap, minimap, font family |
| Storage | Data directory path, auto-save history toggle, max history size |
| About | Version, changelog, keyboard shortcuts reference |

---

## 10. Future Considerations (Post-V1)

- GraphQL, WebSocket, SSE, gRPC protocol support
- Collection runner (sequential execution with data-driven iterations)
- Unit test framework with CI integration
- Cloud sync and collaboration
- Plugin system
- Mock server generation
- AI-assisted request generation
- MCP client support

---

## Appendix A: Insomnia Feature Parity Checklist

| Feature | Covered | Notes |
|---|---|---|
| HTTP request workbench | ✅ | Core V1 |
| Collections + folders | ✅ | Core V1 |
| Environments + templating | ✅ | Core V1 |
| Bearer / API Key / Basic / OAuth 2.0 | ✅ | Core V1 |
| Response viewer (body/headers/timings) | ✅ | Core V1 |
| Request/response scripts | ✅ | Core V1 |
| Import/export (Postman, Insomnia, cURL, OpenAPI) | ✅ | Core V1 |
| Response history | ✅ | Core V1 |
| Code generation | ✅ | Core V1 |
| Proxy support | ✅ | Core V1 |
| Cookie jar | ✅ | Via request engine |
| GraphQL | ❌ | V2 |
| WebSocket / SSE | ❌ | V2 |
| gRPC | ❌ | V2 |
| OAuth 1.0 / Digest / NTLM / AWS IAM | ❌ | V2 |
| Mock servers | ❌ | Post-V1 |
| Plugin system | ❌ | Post-V1 |
| Cloud sync / collaboration | ❌ | Post-V1 |
| MCP / AI features | ❌ | Post-V1 |
