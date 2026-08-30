# Changelog

## 0.1.12 - 2026-08-30

- Centralize file-author resolution in `FileAuthorService`, including manual assignments, complete Git-history fallback, caching, batch progress, and document-level counting.
- Make the history page's author distribution use the same source and precedence rules as note-title author metadata.
- Add full-year contribution-wall history through a time-bounded Git log query instead of the history table's 200-commit display limit.
- Keep the contribution wall in place while its complete-year history loads and avoid hover geometry changes that create horizontal overflow.
- Reuse an existing hidden `.team` directory when saving the file-author registry and immediately mark the registry as a managed local change.
