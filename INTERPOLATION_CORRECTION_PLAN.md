# Interpolation correction plan

Status: implemented and verified. The plan is retained as the correction record; see the completion notes below.

Scope: correct inherited self-references, interpolation size limits, and errors from unused request fields. Preserve the existing editor and nested interpolation rollout. No compatibility mode, data migration, encrypted secret storage, or script execution is added.

## Completion notes

The layered resolver, substitution-triggered 1 MiB output limit, and consumed-field selector are implemented. Regression coverage includes the Insomnia v5 Staging self-reference, parent-secret provenance, literal bodies above 1 MiB, disabled and overwritten request fields, multipart fallback selection, inactive authentication, cURL, URL preview, and real Electron send paths. The full browser suite, strict Node-ABI engine suite, renderer build, and native Electron suite passed during the 2026-11-05 verification pass. Encrypted secret storage, script execution, and other items listed outside this correction remain deferred.


## 1. Preserve environment layers during resolution

### Required behavior

- Keep the selected environment's ordered ancestor chain instead of flattening its definitions before resolution.
- A request reference selects the closest definition in the active environment chain.
- When a definition directly references its own key, look for that key in its nearest defining ancestor. Repeat this rule for ancestors that also extend their own parent value.
- References to other keys still use the active environment's effective definitions. An inherited `base = https://{{host}}` must continue to use a child's `host` override.
- A self-reference without an ancestor definition remains an interpolation error. An indirect cycle such as `a -> b -> a` remains an error even if an ancestor defines `a`; parent fallback applies only to a definition's direct self-reference.
- Preserve built-in precedence, unknown-reference handling, shorthand, the 64-reference depth limit, and one generated built-in context per operation.

Example: parent `base_url = https://shop.test`, child `base_url = {{base_url}}/staging`, grandchild `base_url = {{base_url}}/v2` resolves to `https://shop.test/staging/v2` in the grandchild.

### Implementation

- Extend `src/shared/variableContext.ts` to accept ordered definitions with environment identity and secret metadata. Track resolution frames by definition identity (environment plus key), not key alone.
- Make memoization respect definition identity and active target context. Cached results must not bypass cycle or depth checks. Build a fresh context when the target or draft changes.
- Retain source identity in dependency results. A standard child value that extends a secret parent stays sensitive; a standard child literal that replaces that parent does not inherit sensitivity merely because the key matches.
- Replace flattening at engine and preview boundaries: `src/main/engine/requestEngine.ts`, `src/renderer/stores/index.ts`, `src/renderer/components/RequestEditor.tsx`, and `src/renderer/components/InterpolationEditor.tsx`.
- A flattened map may remain for listing effective keys, but must not supply resolution semantics. Preserve draft replacement at the correct environment layer and preview-target isolation.
- Keep imported expressions intact. Use the existing Insomnia fixture as an integration regression; do not hardcode or rewrite Staging's value to make it pass. This is the requested resolution contract, not a claim of complete Insomnia compatibility.

### Acceptance tests

- Import `tests/engine/fixtures/insomnia-v5-collection.yaml`, activate Staging, and resolve its existing request to the parent URL plus `/staging`.
- Cover two and three defining layers, an intermediate ancestor without that key, ordinary child overrides, inherited expressions using child dependencies, and built-in collisions.
- Cover missing-parent self-reference, indirect cycles, repeated references, and cache/depth interactions.
- Verify parent-secret propagation, replacement without secret dependency, draft edits, and target changes in previews.
- Assert preview, send, and cURL agree on deterministic environment values, while stored expressions remain unchanged.

## 2. Apply the size limit only to substituted strings

### Required behavior

- A string with no successful known-variable or built-in substitution is exempt from the interpolation size cap. A literal raw body larger than 1 MiB must remain sendable and exportable as cURL.
- Unknown or malformed references alone do not count as substitutions. Preserve existing token and shorthand behavior.
- Once a substitution occurs, limit the complete resulting string to 1 MiB of UTF-8 bytes, including literal text around the substitution. This is an output limit, not a limit on net growth or just replacement bytes.
- Consequently, a large literal body with one small successful substitution may still exceed the cap. Document and test this boundary explicitly.
- Apply the rule at each nested expansion and at the receiving request string. A large literal variable cannot bypass the limit when inserted into a request.
- Exactly 1,048,576 output bytes are allowed; one byte more fails. Keep cycle and depth protection independent of the size exemption.

### Implementation

- Track whether expansion performed a successful substitution in `variableContext.ts`.
- Allow unchanged strings to return without the unconditional size rejection. Once substitution is established, account for the literal prefix as well as subsequent fragments, and reject before joining an oversized result.
- Use bounded UTF-8 byte accounting so checking the cap does not require allocating a full encoded copy of oversized text.
- Keep the same rule in editor preview, request preview, send, and cURL. Never truncate output or send/copy a partial result.

### Acceptance tests

- Replace the test in `tests/engine/variableContext.spec.ts` that currently expects oversized plain text to fail.
- Test literal text above the cap, text containing only unresolved/malformed references, empty substitutions, built-ins, multibyte Unicode, exact boundaries, and a large prefix followed by a small substitution.
- Test repeated and nested expansion growth, including a large literal variable used through a reference.
- Verify a POST with a literal body above 1 MiB reaches a local server intact and that cURL export preserves it.
- Verify oversized substituted output produces an actionable interpolation error before network or clipboard mutation.

## 3. Resolve only fields consumed by the operation

### Required behavior

- Stop recursively interpolating the entire persisted request object.
- Select fields according to the same conditions used by URL composition, authentication, body serialization, and transport. Disabled rows, inactive body/auth branches, metadata, and stored scripts do not contribute interpolation errors or secret masking.
- Preserve excluded content in the saved request and editor draft. Enabling a row or activating a branch makes its referenced errors relevant again.
- URL preview resolves and masks only the URL, included query rows, and a selected query API key. An unrelated header, body, or header-auth error must not turn the URL preview into an error or a secret placeholder.
- Send and cURL share field-selection rules wherever they consume the same data. Preserve documented cURL differences, including cached OAuth tokens without a token exchange.

### Implementation

- Add a shared request-field selection/resolution helper, used by the engine and renderer. Keep generic string resolution separate from request semantics.
- Audit current consumers and encode their conditions explicitly:
  - URL and included query parameter keys/values.
  - Enabled headers with usable keys, respecting final header precedence.
  - Only the selected body representation, and no body for GET/HEAD or body type `none`.
  - Enabled form and multipart rows, preserving their existing empty-key rules; for multipart files, resolve the path actually selected by the existing path/value fallback. Do not interpolate file contents.
  - Only authentication fields consumed by the selected, supported auth mode. Include token-exchange inputs and OAuth cache identity where used; exclude unsupported grant fields and unused NTLM credentials when using the current authentication context.
  - Settings actually consumed as strings, such as the effective User-Agent. Do not begin resolving unused proxy configuration merely because it is stored.
- Resolve keys and discriminators in the order needed to determine whether dependent values are used. Avoid silently changing serialization or precedence while introducing selection.
- Preserve request immutability and reuse one variable context across all included fields in an operation.
- Report used-field failures with a useful field location and variable/source chain, without including secret values. Complete interpolation before request or token-exchange network activity, file reads, or clipboard writes.

### Acceptance tests

- Parameterize disabled headers, query parameters, form rows, and multipart rows containing cycles, depth failures, or oversized substitutions: the operation succeeds while they are unused and fails when activated and consumed.
- Cover stored scripts, request metadata, inactive body/auth branches, GET/HEAD bodies, unsupported OAuth fields, unused file-value fallbacks, and current-context NTLM credentials.
- Check fields excluded through existing empty-key and header-precedence rules; ensure selected keys and values still interpolate correctly.
- Assert excluded secret references neither mask the URL preview nor leak through diagnostics; included secret query values remain masked.
- Verify ignored fields remain intact in persisted data and drafts, and re-enabling a bad row shows the error without losing its text.
- Replace whole-object request interpolation assertions with active-field coverage across separate body/auth cases. Retain generic resolver tests only where they describe supported behavior.

## Execution order and completion gates

1. Reconcile `INTERPOLATION_EDITOR_SPEC.md` with the contracts above: parent fallback, substitution-triggered output limit, and consumed-field scope. Add focused failing regressions for each reported defect before changing behavior.
2. Implement layered resolution and its preview integrations, then size accounting, then shared request-field selection. Run the corresponding focused tests after each step.
3. Add integration coverage in `tests/engine/insomniaImport.spec.ts`, `tests/engine/requestEngine.variables.spec.ts`, cURL coverage, environment/request browser suites, and `tests/electron/environment-management.spec.ts` as appropriate. Use local servers and synthetic secrets.
4. Run typecheck and the strict Node-ABI engine suite; confirm its Electron binding restoration. Rebuild the renderer before browser E2E, then run the full browser and native Electron suites. Preserve real clipboard assertions. Investigate recurring TLS fixture or clipboard failures rather than counting historical passes as current evidence.
5. Before committing, follow the repository gate order: typecheck, browser E2E, native Electron smoke, full build. No commit or release is part of this planning request.
6. Update `HANDOFF.md` with actual changes, test results, and any unresolved failures. Mark these three bugs complete only when their regressions and relevant integration checks pass; leave unrelated interpolation-editor and secret-IPC work tracked separately.

Deliverable: the imported Staging environment works, unchanged large bodies work, and unused fields cannot block a send or cURL export, with matching scoped previews and no persisted-data rewrite.
