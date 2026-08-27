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
