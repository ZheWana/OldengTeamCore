<h1 align="center">Oldeng Team Core</h1>

<div align="center">

Obsidian knowledge-base synchronization for small teams

[![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=Obsidian%20downloads&query=%24%5B%22team-core%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=team-core)
[![Latest Release](https://img.shields.io/github/v/release/ZheWana/OldengTeamCore?label=release)](https://github.com/ZheWana/OldengTeamCore/releases/latest)
[![CI](https://github.com/ZheWana/OldengTeamCore/actions/workflows/ci.yml/badge.svg)](https://github.com/ZheWana/OldengTeamCore/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/ZheWana/OldengTeamCore)](./LICENSE)

[中文](./README.md) | English

</div>

Oldeng Team Core synchronizes Markdown notes and shared plugin configuration through Git, stores attachments in S3-compatible object storage, and provides the same progress, history, conflict-resolution, and recovery workflow on desktop and mobile.

> [!IMPORTANT]
> **AI development disclosure**
>
> This plugin was developed entirely by AI, including its source code, tests, documentation, and automation workflows. Human participation is limited to requirements, product decisions, deployment authorization, and acceptance testing.

## Quick Start

### Installation

1. Open Obsidian **Settings → Community plugins → Browse**.
2. Search for **Oldeng Team Core**, then install and enable it.
3. Open **Settings → Oldeng Team Core → Quick Import / Export** and paste the configuration string supplied by an administrator.
4. Enter your Git `username`. The team convention is lowercase full-name pinyin, for example `wangxiaoming`.
5. For an existing remote vault, run **Oldeng Team Core: Import from remote knowledge base** from the command palette.

Normal use does not require the command palette. Select the Team Core status item in Obsidian's bottom-right status bar to start a bidirectional sync. Automatic synchronization is disabled by default and can be enabled in settings.

> [!WARNING]
> **Sync Now is bidirectional.** A local deletion is a valid change and will be pushed to the remote repository. If a file was deleted accidentally and has not been synchronized, do not run Sync Now; use **Reset local vault and resynchronize** instead.

If the Community Plugins directory is unavailable, download the matching `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/ZheWana/OldengTeamCore/releases) and place them in:

```text
<Vault>/.obsidian/plugins/team-core/
```

## Core Features

### Note synchronization

- Batches, commits, fetches, merges, and pushes Markdown files through standard Git Smart HTTP.
- Reconciles a non-fast-forward race with a bounded fetch/merge retry and never force-pushes automatically.
- Shows phase, current item, and numeric progress in the desktop status bar and a mobile progress modal.
- Provides explicit initialization, remote import, local reset, and destructive remote test-reset workflows.

### Attachment synchronization

- Keeps `assets/` outside Git and stores files as `tc-sha256-<sha256>.<extension>` in S3-compatible object storage.
- Tracks only `.team/assets-manifest.json` in Git and commits the manifest after every required object is available.
- Downloads files larger than 8 MiB in 8 MiB Range chunks, writing to a temporary file before atomic replacement and SHA-256 verification.
- Provides attachment auditing, orphan cleanup, and normalization of existing attachments.
- Hides `assets/` and `私人笔记/assets/` from Obsidian's file explorer and search.

### Dashboard and history

- Shows local article and attachment totals, a full-year contribution wall, and document author distribution.
- Lists recently saved Markdown files using local modification time, with `置顶-` pinning, pagination, and refresh.
- Provides a separate paginated commit-history view with file-path search.
- Decorates open note titles with file authors. Manual ownership takes precedence and falls back to complete Git history when absent.
- Maps Git author names to team display names without rewriting Git history.

### Shared plugins

- Selects trusted community plugin folders through an in-plugin allowlist editor.
- Synchronizes each selected plugin's `main.js`, `manifest.json`, `styles.css`, `data.json`, and other directory contents.
- Synchronizes enabled state for shared plugins while preserving every member's personal plugins and enabled state.
- Shows a persistent restart modal after shared plugin files or state change; desktop users can relaunch Obsidian directly.

### Conflicts and diagnostics

- Includes a three-way conflict editor for choosing local, remote, custom, or deleted results.
- Creates a standard two-parent merge commit after conflicts are resolved, then resumes normal synchronization.
- Retains the latest 800 redacted diagnostic entries with synchronization and attachment-transfer boundaries.
- Exports diagnostics as a JSON file under local-only `私人笔记/`; diagnostic data never enters Git or S3.

## Architecture

```text
Obsidian Vault
  └─ Oldeng Team Core
      ├─ Markdown / shared config ── Git Smart HTTP ── Git repository
      ├─ assets/ ────────────────── S3 API ────────── Object storage
      └─ 私人笔记/ ──────────────── Local only
```

Attachment changes follow a fixed order:

```text
Scan and calculate SHA-256
  → Ensure the object is uploaded
  → Update the attachment manifest
  → Commit Markdown and manifest
  → Push Git
```

This prevents a published Git commit from referencing an attachment that is not yet available. Normal synchronization is incremental; an attachment whose hash is already available is not uploaded again.

## Private Notes

The plugin creates the exact path `私人笔记/`. That folder and all descendants remain local, and its attachments are never uploaded to S3. A similarly named path such as `私人笔记备份/` is still public and will synchronize normally.

When Markdown files move between public and private areas, Team Core moves exclusively referenced attachments and rewrites their links. If another note still references an attachment, the shared copy is preserved.

> [!NOTE]
> `.gitignore` prevents future tracking but cannot erase an existing Git commit. If an older repository committed private material, an administrator must rewrite or rebuild the repository history.

## Synchronization and Recovery Boundaries

| Scenario | Action | Remote effect |
|---|---|---|
| Normal creation, editing, or intentional deletion | Select the bottom-right status item | Pushes local edits and deletions |
| Accidental deletion not yet synchronized | Reset local vault and resynchronize | None; remote public content replaces local content |
| Download the complete vault again | Reset local vault and resynchronize | None; remote Git and S3 are preserved |
| Ordinary content conflict | Use the built-in conflict editor | Creates a merge commit after resolution |
| Clear a test remote | Test: clear remote Git and S3 | Deletes remote Git `main` and managed S3 objects |

**Reset local vault and resynchronize** preserves `私人笔记/`, `.obsidian/`, and local trash, removes other local public content and Git metadata, then imports the remote repository again.

The destructive remote reset is a testing feature that requires explicit confirmation. Git and S3 deletion cannot be atomic and should be used only against test data with a verified backup.

## Configuration and Security

Requirements:

- Obsidian `1.12.3` or later;
- a standard Git Smart HTTP repository with Basic authentication;
- a private S3-compatible bucket;
- team members authorized for the same Git repository and S3 prefix.

The quick configuration string contains shared Git and S3 credentials plus author display mappings. It uses the compressed `tc1.` format but **is not encrypted**. Treat it as a password and distribute it only through a trusted private channel. Import never replaces the member's local username or automatic-sync preference.

The plugin makes network requests only to the configured Git and S3 services for synchronization. It contains no telemetry or advertising. Credentials are stored locally under `.obsidian/plugins/team-core/data.json` and are never committed by Team Core.

## Development

```bash
npm install
npm run dev
npm run check
```

Production output is written to `dist/`. `npm run check` runs the production build, TypeScript, Vitest, ESLint, Stylelint, and the Obsidian plugin validator.

Every release requires `.github/release-notes/<version>.md`. Pushing a tag that exactly matches `manifest.json`, without a `v` prefix, makes GitHub Actions verify and publish `main.js`, `manifest.json`, and `styles.css`.

See [CHANGELOG.md](./CHANGELOG.md) for release history, [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidance, and [SECURITY.md](./SECURITY.md) for security reporting.

## License

[MIT](./LICENSE) © 2026 ZheWana
