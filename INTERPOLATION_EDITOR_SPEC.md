# Functional specification: Nested interpolation and editor

Status: implemented; see HANDOFF.md for current verification and deferred secret-storage work  
Scope: Restiprocity desktop client, offline and local-first

## Outcome

Support environment variables that reference other variables, as in Insomnia. Provide an editor that shows the stored expression, its dependencies, and the result a request would use.

For example, with `host = api.example.test`, `base = https://{{host}}`, and `users = {{base}}/users`, a request containing `{{users}}` resolves to `https://api.example.test/users`.

This is a behavior change, not just a UI change. The implementation switches Restiprocity from its previous one-pass behavior to nested resolution; this can change existing requests.

## Resolution contract

- Collect the selected environment's ancestors from root to child, with the closest child overriding earlier values. Direct same-key references resolve against the nearest defining ancestor; a missing parent definition remains a cycle error. Other references resolve against the final effective environment, regardless of which ancestor defined the referring variable. Thus an inherited `base = https://{{host}}` uses a child's override of `host`.
- Built-ins `timestamp`, `randomInt`, and `uuid` take precedence over environment variables of the same name. Generate them once per send and reuse the same values in all request fields and at every dependency depth. Preview uses a separate sample context.
- Resolve valid `{{key}}` references recursively, including in variable values. Whitespace around the key is accepted; whitespace or braces inside a key are not valid. Keys remain case-sensitive. Empty values resolve to empty strings. Unknown references remain literal and generate a diagnostic, preserving the existing unknown-reference behavior; malformed tokens also remain literal.
- Apply the existing `_.key` shorthand and its delimiter rules at each level, including nested values. Preserve the original stored text; shorthand recognition during resolution must not rewrite files. Do not interpret substitution across boundaries formed by joining separate pieces of output.
- Use a per-resolution dependency stack to detect direct and indirect cycles, and memoize completed variable resolutions. Only dependencies reached from the request or preview count; an unused cycle does not block an unrelated request. A used cycle fails the send before any network operation with a clear, secret-free error identifying the variable-key chain; preview shows the same error and retains the draft. Copy as cURL must report the error rather than copying a partial command.
- Limit nesting to 64 variable references in a chain and expanded output to 1 MiB per string after a successful substitution (unchanged literal strings are exempt), checking limits incrementally before allocation. Exceeding either limit produces a clear diagnostic and prevents send or cURL export; no partial result is used. Limits apply consistently to URL preview, editor preview, send, and cURL export. These defaults are implementation requirements to test and may be adjusted before release based on measurements.
- Resolve only consumed request fields: final headers after precedence, included query rows, selected body and authentication fields, and used settings. Skip disabled rows, inactive branches, scripts and metadata. URL preview uses the same query selector and masks only consumed secret values. Multipart path fallback is selected after resolving the preferred path. cURL preserves its existing cached-token-only OAuth behavior. Preserve object keys, non-string types, existing query composition, and request data; do not evaluate code, template functions, or arbitrary expressions.

## Rollout

- Nested interpolation is the single behavior for all installations. No legacy mode, compatibility setting, migration or compatibility notice is required.
- When interpolation fails, show an actionable interpolation error. Users can fix or recreate the request or environment. Preserve unknown references as literal text as described above.
- Existing request and environment files remain in place; nested references can now resolve differently. Document this change. The 1 MiB per-string limit is accepted.
- Insomnia import preserves raw values. Do not claim complete Insomnia syntax compatibility.

## Editor

- Add an “Edit interpolation” action to each environment variable row. Show the environment, variable key, raw value, reference picker, preview environment, resolved result, and dependency diagnostics. 
- Initialize from the current unsaved environment draft. Apply changes to that row's draft only; environment Save persists them. Cancel or Escape requests confirmation when the nested draft is dirty and does not affect the parent draft. Protect the parent draft on navigation and restore focus to the originating row.
- Preserve multiline values, Unicode, selection, cursor position, and undo. Update the parent variable row to indicate and safely reopen multiline values without converting line breaks or truncating stored data.
- The picker filters effective keys and built-ins, labels the source and overrides, and inserts a valid `{{key}}` at the cursor or replaces the selection. A key that cannot be represented by the grammar is unavailable with an explanation. Never display secret values in the picker. Support keyboard and pointer use.
- New environment drafts appear as a selectable synthetic environment whose parent is the draft parent. For an existing draft, show it by ID. Default the preview to the draft environment.
- When a preview target is the draft environment, replace that environment's persisted variables with the full unsaved draft. When it is a descendant, substitute the draft at its place in the ancestor chain, then apply descendant overrides. When it is an ancestor or unrelated environment, use only that target's persisted chain: do not inject the draft. For a new unsaved environment, no existing target is its descendant; other targets use their persisted chains. Previewing another environment never switches the active environment.
- During editing, replace the selected row's draft value with the nested editor's current text for preview only. If the preview target has no effective definition for the edited key, show it as unresolved; if an override or built-in wins, identify the source. Do not synthesize a value for an unrelated target. If draft keys duplicate after trimming, show an ambiguous-draft diagnostic and withhold a request-result preview until corrected; saving continues to use existing validation.
- Render the raw expression and resolved result separately. Show dependency keys and sources, unknown references, malformed input, built-in collisions, cycles, and limit failures. Preview uses the same resolver as send, with one explicitly labeled sample built-in context per refresh. Editing text updates the result without silently regenerating the sample; an explicit Refresh sample action creates another.
- If the environment snapshot is unavailable, stale, or pending, retain the draft and show a retryable unavailable state instead of presenting stale values as current. Previewing never sends requests, changes active selection, or persists data.

## Secret handling

OS-encrypted secret storage, migration and related downgrade work in SECRET_STORAGE_SPEC.md are deferred. Existing secret values continue to be stored as plaintext locally and must be labeled accordingly. Mask secret values and transitive derivatives in the editor and request previews. Do not claim encryption or that all request, response, history, or clipboard surfaces are protected.
## Accessibility

- The editor has an accessible name, initial focus, keyboard operation, visible focus, focus containment, and focus restoration. A nested dialog must not conflict with the parent dialog's focus trap or Escape handler. Errors and preview state changes are announced without reading secret content.
- Controls and diagnostics remain usable at 390px width and increased text size. The user can select, insert, reveal, hide, apply, cancel, and confirm discard using only a keyboard.

## Verification and acceptance

1. Resolve a three-level chain, repeated references, Unicode, punctuation, shorthand, empty and missing keys, and multiple request fields. Verify raw stored values remain unchanged.
2. An inherited expression uses the selected child's override, including when the child changes a dependency but not the expression. Test preview-target ancestor, descendant, unrelated, new-draft, and duplicate-draft cases.
3. Direct and indirect cycles and depth/size limits stop affected sends and cURL export before network or clipboard mutation; unused cycles do not. Show a useful diagnostic without values.
4. Repeated built-ins, including nested uses across URL, headers, body and auth, share one context per send. Preview samples may differ from send but each sample remains stable until refreshed.
5. A direct secret and a standard variable referencing a secret through multiple levels are masked in all scoped preview surfaces, even after environment changes and refreshes. Revealing and hiding a multiline secret retains its draft without accidental disclosure.
6. Verify nested behavior for existing and new installations without a compatibility setting. Document the changed behavior.
7. Apply/cancel, unsaved-change handling, keyboard focus, multiline persistence, narrow layout, retry after save/load failure, and autocomplete have meaningful browser coverage.
8. Real Electron verification creates and persists environments through the UI, restarts and sends to a local test server. Assert the observed URL/header/body uses nested values and child overrides; test used cycles cause no server observation. Verify cURL follows the same resolver.
9. Run typecheck, full browser E2E, relevant engine suite including strict Node-ABI coverage with Electron ABI restored afterward, renderer build and native Electron suite. Before a commit, follow the repository gate order including the packaging build.

## Implementation sequence

1. Adopt nested interpolation as the only behavior and report actionable failures.
2. Add a shared, bounded recursive resolver and diagnostic/secret provenance model; remove the legacy one-pass behavior. Wire send, cURL and previews to the shared resolver.
3. Build the draft-aware editor, dependency display, and preview masking. Defer encrypted secret storage and migration.
4. Add import notice, documentation, browser and real Electron scenarios; complete gates and update HANDOFF.

## Outside this version

Expression languages, template functions, scripts, Insomnia vault compatibility, folder/global environment scopes, and encrypted secret storage and migration. Insomnia's exact cycle and nesting-limit behavior has not been established; the policies above are Restiprocity design decisions.
