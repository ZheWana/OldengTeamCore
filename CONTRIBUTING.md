# Contributing

## Development setup

Use Node.js 20 or later.

```bash
npm install
npm run check
```

Use `npm run dev` for a development bundle with an inline source map. Install the generated `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` in a test Vault.

## Pull requests

- Keep changes focused and cross-platform. Runtime code must not depend on Node.js, Electron, or a system Git executable.
- Add or update tests for behavior changes.
- Do not commit credentials, exported Oldeng Team Core configuration strings, Vault data, or generated `dist/` files.
- Run `npm run check` before opening a pull request.
- Document user-visible changes in `CHANGELOG.md`.

## Releases

Release tags must exactly match the semantic version in `manifest.json`, `package.json`, and `versions.json`. Do not prefix tags with `v`.

### Small fix release path

Use this path for a focused, low-risk bug fix with a clear reproduction or diagnostic result:

1. Inspect only the affected module and its direct tests, then make the focused implementation and regression test.
2. Update the version and changelog.
3. Run exactly one final `npm run check` and `npm run verify-release -- <version>` after the final code edit.
4. Commit, push, create the exact version tag, and use `gh run watch` or `gh run view` to confirm CI and Release.

Do not add review agents, browser automation, or a second complete local gate by default. Escalate only for a failed gate, destructive behavior, a security boundary, a cross-module contract, or a material desktop/mobile uncertainty. Once the final local gate passes, do not edit code again; return to step 3 if any edit is required. If no command output or concrete analysis result is produced for 60 seconds, report the status instead of continuing open-ended investigation. The target is completion, including release confirmation, within 15 minutes.
