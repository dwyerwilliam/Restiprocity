# HANDOFF — Documentation Audit & License Fix

> Task memory for the Restiprocity documentation pass. Read this to pick up where we left off.
> Last updated: 2026-08-14

## Objective

Review Restiprocity documentation (README, AGENTS.md, FUNCTIONAL_SPEC.md, TODO.md, codesigning.md, release skill) against actual git history, GitHub setup, CI workflow, source, and tests. Implement approved fixes. License was the first approved item; broader P1/P2 doc cleanup is pending approval.

## Status

- **P0 (missing LICENSE)** — DONE, approved, committed `d85798c`, pushed to `origin/primary`.
- **P1 (stale AGENTS.md, codesigning anchor, README feature claims)** — PENDING user approval.
- **P2 (FUNCTIONAL_SPEC status framing, TODO/README duplication)** — PENDING user approval.

## Completed (this pass)

- Audited all docs vs git history, GitHub (25 tags `v0.1.0`–`v0.2.5`, no open issues, releases published via CI), `.github/workflows/build-release.yml`, source, and tests.
- Created `LICENSE` (MIT, `Copyright (c) 2026 dwyerwilliam`) — README license badge now resolves.
- Committed `d85798c` `docs: add MIT license file`; pushed to `origin/primary`.

## Verified facts (ground truth for any doc edits)

- Repo: `C:\Users\xylem\Documents\vsCode\Restiprocity`; remote `https://github.com/dwyerwilliam/Restiprocity.git`; default branch `primary`.
- Project: local-first Electron REST API testing client (React 19, TypeScript, Tailwind, better-sqlite3).
- First commit `2026-06-25` → copyright year 2026 is correct. No `author` field in `package.json`.
- CI reality (`.github/workflows/build-release.yml`): 3-platform matrix (macOS + Windows + Ubuntu); jobs `build`, `test`, `updater-unit`, `release`; Windows updater assets = installer + blockmap + `latest.yml`.
- Tests: `tests/e2e` (11 specs), `tests/engine` (15), `tests/update` (1 Vitest updater suite).
- Implementation status (verified in `src/`):
  - cURL import: **implemented** (`src/shared/curlImport.ts` + e2e coverage).
  - Env var resolution: **implemented**, with parent-chain inheritance (`src/main/engine/requestEngine.ts`).
  - Request scripts: **no execution path found** in `src/main` (spec/README claim otherwise).
  - OAuth2 token exchange: **still a stub**.
  - Multipart file upload: **still a stub** (returns null).
- `.omo/` and `.opencode-session-state.json` are gitignored (`.gitignore`). `.opencode/skills/release/SKILL.md` is tracked and accurate.

## Pending (awaiting user approval)

**P1 — stale/misleading docs:**
1. `AGENTS.md` CI section describes an older 2-platform artifact-upload flow; does not match current 3-platform matrix + `updater-unit` + `release` job.
2. `AGENTS.md` test section: missing `updater-unit` Vitest suite and accurate spec counts.
3. `AGENTS.md` "Known TODOs": lists env var resolution as a stub — it is now implemented; only OAuth2 + multipart remain stubbed.
4. `codesigning.md`: anchored to an older version; needs current-version anchor or version-agnostic framing.
5. `README.md`: reconcile feature claims (request scripts, OAuth2, multipart) with verified implementation status.

**P2 — structure/framing:**
6. `FUNCTIONAL_SPEC.md`: frame as V1 target; mark per-feature current status (implemented vs stub).
7. `TODO.md`: overlaps README roadmap; consolidate into one source of truth.

## Next moves

1. Get approval on the P1 list above (user has approved only the LICENSE fix so far).
2. On approval: edit `AGENTS.md` (CI, test, known-TODO sections), `codesigning.md`, `README.md` to match verified facts.
3. Optionally do P2 (spec framing + TODO consolidation).
4. Docs-only change — no typecheck needed, but verify no broken links/badges afterward.
5. Commit + push only after explicit approval (established session pattern).

## Relevant files

- `LICENSE` — created this pass (commit `d85798c`, pushed).
- `README.md`, `AGENTS.md`, `FUNCTIONAL_SPEC.md`, `TODO.md`, `codesigning.md` — pending P1/P2 edits.
- `.opencode/skills/release/SKILL.md` — accurate; do not touch unless release process changes.
- `.github/workflows/build-release.yml` — source of truth for CI behavior.
- `tests/e2e`, `tests/engine`, `tests/update` — source of truth for test counts.
- `package.json` — scripts; no author field.
- `src/shared/curlImport.ts`, `src/main/engine/requestEngine.ts` — implementation ground truth.

## Conventions / guardrails

- Wait for explicit user approval before committing or pushing (established this session).
- `.omo/` is gitignored — local-only state; `.omo/notepads/` is append-only (managed), do not overwrite.
- This `HANDOFF.md` is the durable cross-session task memory for this work.
