# OAuth implementation plan

Status: implemented and verified 2026-11-08. Provider-registration and default-browser smoke remain documented as deferred manual evidence.

## 1. Outcome and scope

A user configures OAuth in a request, selects an environment, clicks **Sign in**, authenticates in the system browser, and sends with the acquired token. Expired tokens refresh when supported. Cancelling, changing credentials, switching environments or clearing a token cannot reuse another authorization.

Deliver:

- Authorization Code with mandatory PKCE S256, for public clients and clients with a configured secret.
- Client authentication: none, HTTP Basic (`client_secret_basic`), or form body (`client_secret_post`). Existing client credentials continues to work with its body-auth default.
- Explicit sign-in/get-token, cancellation, safe token status, local clearing and on-demand refresh before sending.
- Main-process-only acquired tokens, in memory for the app session.
- Consistent send, cURL, interpolation and supported import behavior.
- Real callback/token-exchange tests, including failures and resource cleanup.

Deferred: password/implicit grants, PKCE plain/off, device code, discovery, ID-token validation/user identity, JWT assertions, DPoP/mTLS, custom-protocol callbacks, remote callback relay, persistent token vault, server-side revocation, shared folder tokens and automatic API replay after a 401. This is API authorization, not a Restiprocity identity/login feature.

Existing password-grant files remain readable but cannot start or send; display a migration message and remove that choice from new configuration. Current OAuth security guidance prohibits this grant [R3].

## 2. Verified starting point

| Area | Current behavior | Required change |
|---|---|---|
| `src/shared/types/index.ts` | Four grant strings; no client-auth mode/status contracts | Compatible optional fields and typed operations/status |
| `src/main/engine/authTransport.ts` | Always builds client_credentials; raw newline-joined cache key | Explicit grant builders, structured binding identity; retain NTLM helpers |
| `requestEngine.ts` | Private token cache; assumed one-hour expiry if omitted; only client credentials attaches token | One injected OAuth service for acquisition/refresh/lookup |
| `requestInterpolation.ts` | Only client-credentials OAuth fields resolved | Grant/operation-specific projection retaining consumed-field rules |
| `curlExport.ts` | Cached client-credentials token only; no network | All supported cached grants, still strictly offline |
| `RequestEditor.tsx` | Active `AuthEditor` plus unused duplicate `ControlledAuthEditor`; no token actions | Extract one OAuth editor from the active editor; remove unused duplicate after checking references |
| Main/preload | No OAuth IPC/listener lifecycle | Sender-owned typed OAuth operations |
| Imports | Insomnia preserves settings with incomplete-flow warnings; Postman drops OAuth | Map a documented supported subset; warn on omissions |
| API transport | Cookie sessions and NetLog timing capture | Dedicated strict-TLS nonpersistent token session |

Preserve these existing boundaries: multipart preparation precedes automatic OAuth/network I/O; cURL never exchanges tokens; unused fields/cycles cannot block unrelated operations. Interactive sign-in must not reuse RequestEngine's mutable request abort controller.

The clipboard-test correction is currently uncommitted. Preserve it and its distinct validation boundary.

## 3. User experience and compatibility

Supported grant choices: **Authorization Code (PKCE)** and **Client Credentials**. Existing `pkce` and `authorization_code` values normalize to the first choice; browser flows always use S256.

Fields: authorization URL (browser only), token URL, client ID, scope, client-auth selector, secret for Basic/body only, callback loopback host/port and read-only **Redirect URI to register** with Copy. Optional expected issuer requires a matching callback `iss`. Advanced enabled key/value rows for authorization and token parameters support provider settings such as audience, resource, prompt and access_type; protocol-owned keys cannot be overridden.

Actions: Sign in / Get token, Cancel, Refresh token (when available), Clear token. Clear removes local tokens, not browser login or provider authorization. Explain session-only storage. No acquired-token reveal/copy widget in this release; Copy as cURL remains an explicit secret-bearing export and must say that the command includes authorization credentials.

States: Not authorized; Opening browser; Waiting for sign-in; Exchanging code; Ready (expiry or "expiry not supplied"); Refreshing; Expired/sign-in required; Cancelled; Failed. Safe field errors and protocol error codes only; no raw provider output.

Send rules:

- Browser grant without a usable token: authentication error before API traffic, with Sign in action. Send never launches a browser.
- Valid token: attach it. Expired token with refresh token: refresh once, then send; refresh failure prevents API send.
- Client credentials: retain automatic acquisition on Send and add explicit Get token.
- API 401: display the actual response and offer explicit refresh/sign-in. Never replay automatically, including POST/uploads; not every 401 proves expiry.
- Switching panels does not cancel. Closing the request tab cancels pending sign-in, not ready tokens. Switching its auth/environment or deleting its request cancels pending authorization. Stale events cannot update a different binding.

Keep old persisted fields/grant strings. Add optional `clientAuthentication: 'none' | 'basic' | 'body'`, `expectedIssuer`, `authorizationParameters`, `tokenParameters`. Keep `redirectUri` as the serialized full callback URI. Acquired tokens/state/verifier/status never enter Request JSON.

Defaults: new browser config uses none; existing client credentials uses body. Legacy browser config infers body for an authored nonempty secret, otherwise none, displaying that choice. Explicit none ignores stored secrets. Unsupported grants fail explicitly rather than sending unauthenticated. Existing remote or mismatched callback URIs remain visible until corrected, with the generated URI and registration guidance; no silent rewrite or PKCE downgrade.

```mermaid
sequenceDiagram
    participant U as User / OAuth panel
    participant M as Main OAuth service
    participant B as System browser
    participant P as OAuth provider
    participant A as Target API
    U->>M: Sign in with config/environment snapshot
    M->>M: Validate, bind callback, create PKCE/state
    M->>B: Open authorization URL
    B->>P: User signs in and consents
    P-->>B: Redirect with code and state
    B->>M: Loopback callback
    M->>M: Validate state/issuer; consume callback once
    M->>P: Code + verifier + exact redirect URI
    P-->>M: Access token and optional refresh token
    M-->>U: Ready metadata (no tokens)
    U->>M: Send request
    M->>P: Refresh only if needed
    M->>A: API request with Bearer token
```

## 4. Interpolation, binding and destination isolation

Add a shared pure OAuth projection helper for start/status/send/cURL. Use existing layered variable resolution without mutating drafts. Resolve only selected fields: client credentials ignores authorization/redirect fields; none auth ignores secret; disabled extras stay untouched. Validate extra keys after interpolation. OAuth actions resolve the request URL string to determine its destination origin; this makes that URL string a consumed field (including any inline path/query templates). They do not consume request headers, body, scripts, separate query-parameter rows or file paths. A URL interpolation error blocks authorization/status with a field error; changing a valid path/query without changing origin retains the binding.

Browser OAuth identity fields/parameters reject transitive nondeterministic built-ins (uuid/timestamp/randomInt) with field errors, preventing a new identity on every send. Client-credentials built-ins retain their existing per-send shared-context behavior.

Token binding = request ID + canonical effective environment ID + canonical resolved OAuth configuration + resource origin (scheme/host/port). Include consumed endpoints, scope, client ID, secret/mode, callback identity, issuer and enabled extras; exclude inactive fields, state/verifier and unrelated request details. Encode structurally and use an in-memory keyed digest for sensitive configuration, not newline concatenation or credentials in printable keys. No sharing between requests/environments in V1; duplicates/imports start unauthorized.

Snapshot environment ID before async work. Main resolves the current authored configuration and origin, then assigns opaque binding/operation IDs. Recheck identity before committing a token and before Send; changed environment/config/origin invalidates old state. Parent-environment edits invalidate affected child bindings. Old callbacks/exchanges cannot publish after cancellation, clearing or binding generation change. Changing only request path/body does not invalidate a token.

Do not leak a cached token through target redirects: native tests must prove net/fetch remove OAuth Authorization on origin changes; reject HTTPS-to-HTTP downgrade while using an acquired token. If a transport cannot provide this guarantee, fail the redirect before following it. The source Request still retains its authored values.

## 5. Browser/callback protocol

1. Validate sender/configuration. Only one interactive sign-in at a time across the app; another start returns OAUTH_BUSY without replacing the first.
2. Generate independent state and verifier with 32 cryptographically random bytes each, base64url without padding. The 43-character verifier yields base64url(SHA-256(verifier)); method S256 [R2].
3. Bind before opening the browser. Default `127.0.0.1:42813`; user can select literal `[::1]` and another port, 1024-65535. No wildcard/LAN/hostname bindings or silent fallback. Fixed port is a product decision for predictable registration; ephemeral-port support is deferred. Bind conflict returns a useful error and opens no browser.
4. Path is `/oauth/callback/<provider-id>`, first 32 hex characters of SHA-256 over the structured normalized authorization/token endpoint pair. Display the deterministic full URI before registration. Distinct callbacks provide a mix-up defense where issuer identification is unavailable [R3]; require exact expected `iss` when configured. Endpoint pair/client ID/URI/state belong to one immutable flow. Arbitrary callback paths and imported external callbacks are unsupported for this release.
5. Construct response_type=code, client_id, redirect_uri, scope if set, state, code_challenge, code_challenge_method plus allowed extras. Reject duplicates/overrides of these reserved keys in endpoint query or extras; also prohibit client_secret, access_token, refresh_token, code and code_verifier there. Require HTTPS except literal-loopback HTTP for development. Reject userinfo, fragments, control characters and non-web schemes. Browser URLs contain no client secret, verifier or tokens; reject enabled browser-parameter values marked secret by environment provenance. Respect the documented Windows openExternal URL length bound [R5].
6. Accept GET query callbacks only. Validate exact Host including port, path, loopback peer and state. When expectedIssuer is configured, require an exact iss match; otherwise use the distinct-redirect defense and never treat an unsolicited iss as verified provider identity. Require exactly one nonempty state and exactly one nonempty code OR one nonempty error; reject duplicate protocol parameters and code+error together. Require nonempty iss only when expectedIssuer is configured; reject its duplicates regardless. Reject mismatched required issuer, URLs over 16 KiB and unsupported response modes. Unknown paths or malformed/wrong-state calls never trigger token I/O and do not consume the valid pending flow. Matching-state provider denial terminates safely. Atomically claim one valid callback; replay/concurrent callbacks cannot exchange twice.
7. Return fixed HTML with no echoed callback data or remote assets, no-store, restrictive CSP and no-referrer. Say to return to Restiprocity; receiving a code is not yet successful exchange. Close after response flush and destroy remaining sockets within one second. No cookies, CORS API, or callback URL logging.
8. Exchange code using exact URI/verifier; validate tokens before storing and emitting Ready. Refocus the owning app window if it exists.

Five-minute total authorization timeout, with token HTTP additionally capped at 30 seconds. Cancel, timeout, browser-open failure, renderer destruction/navigation away, valid denial or app quit release listener/sockets/timers and references to secrets. Bound incomplete HTTP headers to five seconds so idle clients cannot prevent cleanup. Browser-tab closure is not reliably detectable; Cancel/deadline handles it. Bad unsolicited callbacks leave the valid operation pending until its deadline. Clear changes the binding generation so late exchange results cannot restore tokens.

Display authorization and token endpoint origins together. Manually configured endpoints are not verified provider identity; distinct callback paths do not prove endpoint ownership. Callback data never selects the token endpoint. Prefer expected-issuer matching when the provider supports it; discovery/automatic provider verification is deferred.

## 6. Token service, expiry and refresh

Create one `OAuthService` in main; inject it into RequestEngine and OAuth IPC and dispose it on quit. Injectable dependencies: clock, randomness, callback-listener factory, token transport and browser opener. Interactive operations and API sends have independent cancellation controllers.

Use a dedicated nonpersistent Electron session, strict certificate verification, cache disabled, cookies omitted, no ambient NTLM/SSO credentials and no API NetLog capture. Do not inherit target request headers, insecure-TLS flag, cookies or redirect policy. Token HTTP uses `redirect: 'error'`; redirects fail rather than forwarding credentials. Runtime tests must verify this in installed Electron, beyond mocked RequestInit [R6]. Allow plaintext HTTP only to literal-loopback development endpoints. This intentionally tightens older client-credentials configurations: a non-loopback HTTP token URL gets a configuration error and HTTPS migration guidance, never silently sends credentials.

Wire forms:

| Operation/mode | Fields |
|---|---|
| Code exchange | grant_type=authorization_code, code, exact redirect_uri, code_verifier |
| Client credentials | grant_type=client_credentials, optional scope |
| Refresh | grant_type=refresh_token, retained refresh_token; do not expand scope |
| None client auth | client_id; no secret/Authorization |
| Basic client auth | Form-encode ID and secret before constructing Basic credentials per RFC 6749; no redundant secret in form |
| Body client auth | client_id and client_secret in form |

Advanced token rows apply consistently to acquisition/refresh. Protocol grant/client-auth/code/verifier/redirect/scope/refresh_token keys are reserved. For both authorization and token extras, allow repeated `resource` rows; reject duplicate keys otherwise. Reject reserved or duplicate keys already in endpoint query after resolving names. Never send scope from stale renderer status.

Bound token responses while streaming to 1 MiB decoded bytes, including errors; cancel reads on overflow. Require success JSON object and nonempty access_token without control characters. Browser/refresh responses require Bearer token_type (case insensitive). For existing client-credentials compatibility only, absent token_type means Bearer with safe metadata notice; other explicit types fail. Validate optional refresh_token as a nonempty string without control characters before storing; reject malformed supplied values. Unknown response members are ignored.

expires_in accepts a nonnegative finite integer number or decimal digit string with safe arithmetic. Zero is expired and never sent. Use monotonic expiry internally with safety skew min(30 seconds, 10% lifetime); wall time only for display. Missing expiry is unknown, not an invented hour: usable until clear/replacement/app exit, without automatic expiry refresh. Do not infer JWT claims. Retain supplied scope as granted scope, without claiming it matches requested scope.

Refresh rules:

- Refresh before Send if expired/inside skew, or via explicit Refresh. Never refresh on status/preview/cURL; no background timer.
- One acquisition/refresh per binding at a time. Deduplicate callers; a cancelled caller stops waiting, and shared exchange aborts when all callers leave. Clear/new sign-in always invalidates and aborts that binding's exchange. A browser operation and automatic refresh for the same binding cannot race to store tokens.
- Replace rotated refresh tokens atomically. Retain previous refresh token only when a successful response omits replacement. No automatic retry after ambiguous network failure/timeout, since rotation might already have happened.
- invalid_grant clears tokens and requires sign-in. invalid_client requires configuration repair. Transient failures return a safe retryable result with zero target API traffic. A retry is user initiated.
- Each exchange has a 30-second cap plus any earlier caller/multipart deadline. Invalid multipart files still fail before automatic token I/O; explicit Sign in/Get token is independent of body preparation.
- Token endpoint responses are not target API responses/history. Use safe codes: OAUTH_NOT_AUTHORIZED, OAUTH_UNSUPPORTED_GRANT, OAUTH_BUSY, OAUTH_CALLBACK_PORT_IN_USE, OAUTH_ACCESS_DENIED, OAUTH_TIMEOUT, OAUTH_INVALID_RESPONSE, OAUTH_TOKEN_REQUEST_FAILED. Add authentication to RequestError kinds for send failures. No provider response body, secret-bearing URL or nested raw error in renderer rawMessage/logs.

Memory policy: no acquired tokens in request/environment JSON, SQLite, exports, renderer state/status or logs. Clear on exit, binding deletion or Clear. Cap at 100 bindings with LRU eviction of inactive entries; do not evict active exchanges, and return capacity error if all are active. Eviction requires reauthorization. References are removed on cleanup; do not claim guaranteed memory erasure in JavaScript.

Authored client secrets remain plaintext in local JSON, as today; encrypted credential storage is separate work. cURL output/clipboard is an intentional secret-bearing export exception. Target API bodies can echo credentials; general response-body secret scrubbing is not claimed by this feature.

## 7. IPC and integration

Add shared payload/result types and preload whitelist entries:

| Channel | Contract |
|---|---|
| oauth:start | Resolve/validate authored config, request ID, environment ID and origin; accept sign-in or explicit credentials acquisition; return operation/binding IDs and safe snapshot |
| oauth:status | Offline current binding status; no browser/token HTTP |
| oauth:refresh | Explicit refresh operation |
| oauth:cancel | Idempotent cancellation of operation owned by requesting renderer |
| oauth:clear | Delete tokens and cancel work for selected binding |
| oauth:progress | Safe updates to the owning sender only; operation/binding ID and revision |

Validate sizes/types/IDs and app main-frame sender before browser/network effects. Bind operations to actual event.sender and its BrowserWindow, not the potentially unset startup mainWindow dependency. No generic open-URL IPC. Subscribe before starting; return current snapshot/revision from start/status so fast terminal events cannot be missed. Cleanup subscriptions on renderer destroy/navigation. Reload cancels interactive work; the new renderer can query retained safe token status. Clearing request/environment records disposes associated bindings.

Both execute/executeV2 and all net/fetch paths use the same service. Resolve binding/request projection once per operation. Supported OAuth Send either supplies Bearer or fails, so the overridden authored Authorization value is unconsumed. Cached cURL takes one immutable token snapshot for both header selection and construction (avoid expiry races). Without a valid token, retain authored Authorization as today and warn appropriately; never browser/refresh/network/file-read on export. Include auth errors in response labels and console handling without leaking internals.

Move the active OAuth UI to `OAuthEditor.tsx`; remove stale duplicate only after reference audit. Keep native Request drafts/auto-save behavior, and a renderer metadata store for safe statuses only. Status updates for other binding/revision are ignored. Do not save a request merely because sign-in status changes.

Keep token traffic outside API timing capture/history. Verify redirects, cookies, cancellation, streaming and multipart ordering rather than assuming existing RequestEngine guarantees apply to token HTTP.

## 8. Import/export and documentation

- Native files retain compatible config/new optional fields, never acquired token state. Round-trip legacy files and inactive auth branches.
- Insomnia: map known client-auth/PKCE modes; revise incomplete-grant warnings. Warn for plain/off PKCE, callback registration changes and unsupported advanced settings.
- Postman: map supported OAuth attribute arrays directly before its existing Insomnia adapter (which cannot preserve new fields). Cover identifiable client_credentials, authorization_code and authorization_code_with_pkce; keep endpoints/ID/secret/scope/client-auth. Omit acquired access/refresh tokens and report omission. Unknown or ambiguous settings require review rather than guessed runnable config. Fixture tests cover real export shape.
- Imports never authorize or change active environment. Per-request token binding remains even with imported inherited auth.
- Update README, AGENTS.md, FUNCTIONAL_SPEC.md and HANDOFF.md. FUNCTIONAL_SPEC also has stale Postman implementation status; correct it during documentation work.

## 9. Milestones and file map

Each milestone ends with focused tests; feature acceptance requires all six.

1. **Contracts and baseline:** shared types, normalization/projection, binding and validation; characterize current client credentials/cURL; explicit unsupported-grant errors.
2. **Token service:** move client credentials/cache; add client-auth methods, expiry, refresh, bounded transport and cancellation; keep existing send/cURL working.
3. **Interactive authorization:** callback listener, PKCE/state, provider/issuer binding, browser adapter, lifecycle and negative protocol cases against a fake provider.
4. **IPC and UI:** whitelisted methods, sender ownership, safe events, one OAuth editor, action/status UX and environment/config switching.
5. **Import/integration:** native/Insomnia/Postman mappings, header precedence, origin isolation, transport redirects and multipart ordering; native acceptance/privacy checks.
6. **Acceptance/docs:** full checks, Windows packaged-browser smoke, cross-platform callback coverage and precise provider evidence; coherent commits when authorized.

Expected areas:

- New `src/main/oauth/{oauthService,oauthCallbackServer,oauthTokenTransport,oauthValidation}.ts`.
- New pure shared `src/shared/oauth.ts`, plus shared type definitions.
- Engine authTransport/requestEngine/requestErrors/runtime adapters; shared requestInterpolation/curlExport.
- New `src/main/ipc/oauthHandlers.ts`, handlers.ts, main/index.ts, preload/index.ts.
- New `src/renderer/components/OAuthEditor.tsx`, RequestEditor.tsx, metadata store, error display.
- Importers, tests and docs. File map is implementation guidance, not an instruction to delegate.

## 10. Acceptance evidence

| Layer | Required scenarios |
|---|---|
| Protocol/pure | RFC 7636 S256 vector; structured identity; deterministic provider path; Basic escaping; exact query/form encoding; reserved-key/duplicate rejection; callback/issuer/URL policy; legacy defaults; expiry extremes and invalid JSON |
| Service with fake clocks | Acquisition/cache/expiry/refresh/rotation; separate request/environment/origin; parent variable edits; concurrent starts/refresh; cancellation at every phase; clear versus late completion; missing/short/zero expiry; LRU cap; safe status/errors |
| Real local callback sockets | Bind before browser; occupied port opens no browser; IPv4/IPv6 where available; exact Host/path; denial; wrong/missing/duplicate state; forged/missing required issuer; replay exchanges once; oversized/slow/unsolicited requests; all terminal paths release resources |
| Engine | Credentials compatibility; browser token on both entry points/net/fetch; failed auth zero target/history; origin-change redirects don't leak; TLS downgrade blocked; body errors before automatic OAuth; no timing pollution; unused fields/cycles remain unconsumed |
| cURL/persistence | Valid cached token included; missing/expired token no side effects; one header/token snapshot; no acquired tokens in bundles/requests/environments/history metadata |
| Renderer E2E | Active editor fields/draft persistence; registered URI Copy; start/cancel/clear/refresh; slow/failing/double clicks; stale events; environment switch; keyboard/focus/status accessibility; restart unauthorized |
| Native Electron | Real preload/IPC/listener/token HTTP/target HTTP. Fake provider independently checks verifier/redirect/client auth, issues token, verifies protected request, rotates refresh, rejects invalid cases. Intercept browser opener only; drive captured URL through a separate browser context. This proves browser protocol, not OS default-browser dispatch |
| Packaged/manual | Actual default browser -> callback on installed Windows app; denial/cancel/restart/port conflict. macOS/Linux native CI callback coverage. No claim that one OS or fake provider proves every provider |

Use synthetic sentinel secrets and scan generated collection/environment/history/log artifacts and OAuth IPC payloads. Explicitly exclude intentional cURL output and fixture server observations; do not claim arbitrary API response-body scrubbing. Add a provider smoke checklist for a public PKCE client and a confidential client using registered callbacks, without putting real credentials in fixtures. Missing real registrations does not prevent implementation, but named-provider compatibility remains unverified until exercised.

Full gate order: typecheck -> fresh build:renderer -> browser test -> test:electron -> build. Also run focused OAuth suites, updater suite if lifecycle changes affect it, and strict Node-ABI engine suite with Electron ABI restored. Use a hash-matched isolated copy if a running app locks SQLite. Report the separate opt-in clipboard skip honestly. Do not weaken OAuth failure/security tests to make acceptance green.

Done means automated acceptance passes, token state stays private/in-memory, sign-in/send/refresh/clear have correct states, existing client credentials/import/multipart behavior remains covered, packaging passes, and actual OS/provider smoke limits are recorded. The implementation is verified by the automated gates recorded in HANDOFF.md; real provider registration and installed-app default-browser smoke remain outside the available test environment.

## 11. Sources and decision boundaries

Protocol requirements come from the sources below; callback port, timeouts, size/cache bounds, UI and scope are explicit product choices. The implementation is complete against this contract; automated gates passed, while provider-registration/default-browser smoke remains manual evidence.

- [R1: RFC 8252 — Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html): external browser, native PKCE and loopback callbacks.
- [R2: RFC 7636 — PKCE](https://www.rfc-editor.org/rfc/rfc7636.html): S256/verifier and test vector.
- [R3: RFC 9700 — OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html): password grant, refresh rotation and mix-up defenses; distinct callbacks are fallback when issuer identification is unavailable, not equivalent proof of provider ownership.
- [R4: RFC 6749 — OAuth Framework](https://www.rfc-editor.org/rfc/rfc6749.html): client authentication encoding, token fields and refresh semantics.
- [R5: Electron shell.openExternal](https://www.electronjs.org/docs/latest/api/shell#shellopenexternalurl-options): external dispatch and Windows URL limit.
- [R6: Electron Session API](https://www.electronjs.org/docs/latest/api/session): nonpersistent session/fetch. Verify behavior against installed Electron 39 with native tests rather than assuming current documentation alone proves it.
