# Oldeng Team Core

Oldeng Team Core is a cross-platform Obsidian plugin for synchronizing a small team's Markdown knowledge base through Git while storing attachments in S3-compatible object storage.

Oldeng Team Core 是一个跨平台 Obsidian 团队知识库插件。Markdown 笔记使用 Git 保留历史，附件使用兼容 S3 的对象存储，并在桌面端和移动端使用同一套插件代码。

> [!IMPORTANT]
> **AI development disclosure / AI 开发声明**
>
> This plugin was developed entirely by AI, including its source code, tests, documentation, and automation workflows. Human participation is limited to requirements, product decisions, deployment authorization, and acceptance testing.
>
> 本插件完全由 AI 开发，包括源代码、测试、文档和自动化工作流。人类仅负责提出需求、产品决策、部署授权和验收测试。

## Features

- Automatically batches local changes, fetches remote commits, merges, and pushes through Git Smart HTTP.
- Records each member's Git author identity and provides file-level history inside Obsidian.
- Stores `assets/` outside Git with immutable SHA-256 object IDs and a Git-tracked attachment manifest.
- Renames managed attachments to `assets/tc-sha256-<sha256>.<extension>` and updates Markdown and Wiki links.
- Shows phase and numeric progress during synchronization.
- Creates `私人笔记/` as a local-only folder that is excluded from synchronization.
- Provides explicit initialization, remote import, attachment normalization, diagnostics, and an in-app conflict editor.
- Retries a racing non-fast-forward push with a bounded fetch/merge cycle and never force-pushes.
- Lets the team choose trusted community plugin folders to share through a managed `.gitignore` whitelist. Obsidian remains responsible for installing and updating plugins.
- Synchronizes the enabled state of whitelisted community plugins while preserving each member's personal plugin choices.

## Requirements

- Obsidian 1.8.7 or later.
- A standard Git Smart HTTP repository with Basic authentication.
- An S3-compatible private bucket. The current implementation has been tested with Qiniu Kodo's S3-compatible endpoint.
- Team members who are authorized to access the same Git repository and S3 prefix.

## Installation

### Community plugins

After Oldeng Team Core is accepted into the Obsidian Community directory, install and update it from **Settings → Community plugins**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the matching [GitHub release](https://github.com/ZheWana/OldengTeamCore/releases), place them in:

```text
<Vault>/.obsidian/plugins/team-core/
```

Restart Obsidian, then enable **Oldeng Team Core** under Community plugins.

## Configuration

Open **Settings → Oldeng Team Core** and configure:

- the Git repository URL, member username, and shared Git password;
- S3 endpoint, region, bucket, prefix, Access Key, and Secret Key;
- save debounce and automatic synchronization intervals.

In **团队公共插件**, enable only trusted plugin folders. The selected folder is synchronized in full, including `main.js`, `manifest.json`, `styles.css`, `data.json`, and other files. The selection is stored in the managed block of `.gitignore`, so it travels with the repository. The enabled state of selected plugins is stored in `.team/shared-plugins.json` and applied to each member's local `community-plugins.json`. Unselected plugins and their enabled states remain local and are never removed, disabled, or overwritten. `team-core` itself and the local `community-plugins.json` file are never committed.

The quick export string contains shared Git and S3 secrets. Treat it as a password and distribute it only through a secure private channel. The member username is intentionally kept local and is not replaced during import.

## Private notes

Oldeng Team Core automatically creates `私人笔记/`. That exact folder and all of its descendants remain local. A similarly named folder such as `私人笔记备份/` is not private and will be synchronized normally.

## Attachment model

Files under `assets/` are not committed to Git. Oldeng Team Core hashes changed or explicitly normalized attachments, uploads immutable objects to the configured S3 prefix, and commits `.team/assets-manifest.json` only after each required object is available. Ordinary synchronization is incremental; use **规范化全部附件** only for initial migration or recovery after external file changes.

Concurrent changes to different attachment paths are merged semantically in the manifest rather than treated as a JSON text conflict. Competing content for the same logical path remains a real conflict.

## Conflict behavior

Oldeng Team Core automatically merges independent changes and retries a push race at most twice through fetch and merge. It never force-pushes. A true content conflict stops before push, keeps the pre-merge note content unchanged, records the conflicting paths under local `.git` metadata, and remains visible after plugin reload.

Select the conflict status or run **解决同步冲突** to open the built-in editor. Desktop layouts show the local version, editable result, and remote version side by side; narrow layouts provide the same views as tabs. Every file must be explicitly resolved by choosing a side, editing a custom result, or deleting the file. Saving creates a standard two-parent merge commit and resumes the normal synchronization flow.

## Network and privacy disclosure

Oldeng Team Core makes network requests only for its stated synchronization features:

- the user-configured Git Smart HTTP server receives Git authentication and Markdown repository traffic;
- the user-configured S3-compatible service receives attachment requests signed with the configured S3 credentials;
- GitHub Releases are used by Obsidian's own community-plugin update flow, outside the plugin runtime.

Oldeng Team Core does not include client-side telemetry or advertising. Credentials are stored in Obsidian's local plugin data under `.obsidian/plugins/team-core/data.json` and are never committed by Oldeng Team Core. Server operators remain responsible for their Git and S3 privacy, retention, access-control, and logging policies.

## Destructive test command

During the current testing phase, **测试：清空远端 Git 与 S3** can delete the configured remote Git `main` ref and all Oldeng Team Core-managed objects under the configured S3 `prefix/sha256/`. It requires an explicit destructive confirmation. Git and S3 deletion cannot be atomic. Use it only against test data with a verified backup.

## Development

```bash
npm install
npm run dev
npm run check
```

Production output is written to `dist/`. Unit tests cover configuration, hashing, path boundaries, shared-plugin ignore rules, manifest behavior, Git adapter behavior, attachment names, links, and conflict handling.

## Releasing

1. Update the version with `npm version patch`, `npm version minor`, or `npm version major`.
2. Run `npm run check`.
3. Push the commit and a tag whose name exactly matches `manifest.json`, without a `v` prefix.
4. GitHub Actions verifies and publishes `main.js`, `manifest.json`, and `styles.css` as release assets.

The separate Oldeng Team Core server publisher retains only the latest and immediately previous static packages for manual recovery. The plugin never installs or overwrites itself.

## License

[MIT](LICENSE) © 2026 ZheWana.
