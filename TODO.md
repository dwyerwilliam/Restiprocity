# Project TODO

## Environment management

- [x] Edit environment names and standard or secret variables.
- [x] Create nested environments from the sidebar or editor.
- [x] Switch and delete environments from the editor; environments with children must be emptied first.
- [x] Persist the active environment, restore it at startup, and fall back to Core for an invalid selection.

Secret values are masked in the editor but stored as plain text in local environment files.

- [x] Implement nested interpolation and the dedicated editor described in [INTERPOLATION_EDITOR_SPEC.md](./INTERPOLATION_EDITOR_SPEC.md).
  Nested references use layered parent fallback, bounded recursive resolution, scoped request-field interpolation, and actionable cycle/size errors.

- [ ] Deferred: implement confidential and OS-encrypted secret variables per [SECRET_STORAGE_SPEC.md](./SECRET_STORAGE_SPEC.md).
