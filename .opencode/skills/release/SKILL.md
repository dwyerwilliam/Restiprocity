---
name: release
description: Release Restiprocity with version metadata, release notes, validation, branch push, and version tag publication.
---

# Restiprocity Release Workflow

Use this skill whenever preparing a Restiprocity release or when the user asks to bump a version, publish a release, create a tag, or push a release.

## Required release sequence

1. Inspect the current branch, upstream, working tree, latest commit, and existing tags.
2. Read `package.json`, `package-lock.json`, `AGENTS.md`, and the latest files under `releases/`.
3. Choose the next release version. For a patch release, increment the patch component in `package.json`.
4. Keep the root version in `package-lock.json` and the empty-package version in its `packages[""]` entry aligned with `package.json`.
5. Add `releases/vX.Y.Z.md` before tagging. The filename must exactly match the tag and the file must summarize user-visible changes and relevant platform notes.
6. Run the project gates in order: `npm run typecheck`, `npm run test`, then `npm run build` when a full release build is requested or required by the release workflow.
7. Review `git diff`, stage only the intended release files, and create a conventional commit matching repository history.
8. Push the release commit to the release branch (normally `primary`) before creating the tag.
9. Create an annotated tag named `vX.Y.Z` at the release commit and push it with `git push origin vX.Y.Z`.
10. Verify the branch is clean and synchronized, and verify the pushed tag resolves to the release commit.

## Non-negotiable checks

- Never push a tag before its matching release-notes file is committed.
- The tag version must equal `package.json.version` without the leading `v`.
- Do not reuse an existing tag or move a published tag without explicit user approval.
- Do not commit unrelated working-tree changes.
- The GitHub Actions release workflow is triggered by `v*` tags and rejects missing `releases/${TAG}.md` files.

## Release-note format

Follow the existing style:

```markdown
# vX.Y.Z

## New Features

### Short feature name
- Describe the user-visible change.

## Fixes
- Describe important fixes.

## Platform Notes
- Include applicable Windows, macOS, Linux, installer, or updater notes.
```

Keep notes concise and omit empty sections. For this project, packaged Windows releases use the updater contract validated by `.github/workflows/build-release.yml`; macOS and Linux releases remain manual downloads unless the workflow changes.
