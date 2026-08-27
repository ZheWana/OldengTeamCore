# Oldeng Team Core

Oldeng Team Core is a cross-platform Obsidian plugin for synchronizing a small team's Markdown knowledge base through Git while storing attachments in S3-compatible object storage.

Oldeng Team Core 是一个跨平台 Obsidian 团队知识库插件。Markdown 笔记使用 Git 保留历史，附件使用兼容 S3 的对象存储，并在桌面端和移动端使用同一套插件代码。

## Features

- Automatically batches local changes, fetches remote commits, merges, and pushes through Git Smart HTTP.
- Records each member's Git author identity and provides file-level history inside Obsidian.
- Stores `assets/` outside Git with immutable SHA-256 object IDs and a Git-tracked attachment manifest.
- Renames managed attachments to `assets/tc-sha256-<sha256>.<extension>` and updates Markdown and Wiki links.
- Shows phase and numeric progress during synchronization.
- Creates `私人笔记/` as a local-only folder that is excluded from synchronization.
- Provides explicit initialization, remote import, attachment normalization, diagnostics, and conflict states.
- Checks the Oldeng Team Core release index and reminds users when a newer version is available. Obsidian remains responsible for installing updates.

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

The quick export string contains shared Git and S3 secrets. Treat it as a password and distribute it only through a secure private channel. The member username is intentionally kept local and is not replaced during import.

## Private notes

Oldeng Team Core automatically creates `私人笔记/`. That exact folder and all of its descendants remain local. A similarly named folder such as `私人笔记备份/` is not private and will be synchronized normally.

## Attachment model

Files under `assets/` are not committed to Git. Oldeng Team Core hashes changed or explicitly normalized attachments, uploads immutable objects to the configured S3 prefix, and commits `.team/assets-manifest.json` only after each required object is available. Ordinary synchronization is incremental; use **规范化全部附件** only for initial migration or recovery after external file changes.

## Network and privacy disclosure

Oldeng Team Core makes network requests only for its stated synchronization and update-check features:

- the user-configured Git Smart HTTP server receives Git authentication and Markdown repository traffic;
- the user-configured S3-compatible service receives attachment requests signed with the configured S3 credentials;
- `https://zhewana.cn/team-core-plugin/index.json` is requested at startup and every six hours to check the latest plugin version;
- the GitHub Releases page opens only when the user selects **查看发布页**.

Oldeng Team Core does not include client-side telemetry or advertising. Credentials are stored in Obsidian's local plugin data under `.obsidian/plugins/team-core/data.json` and are never committed by Oldeng Team Core. Server operators remain responsible for their Git and S3 privacy, retention, access-control, and logging policies.

## Destructive test command

During the current testing phase, **测试：清空远端 Git 与 S3** can delete the configured remote Git `main` ref and all Oldeng Team Core-managed objects under the configured S3 `prefix/sha256/`. It requires an explicit destructive confirmation. Git and S3 deletion cannot be atomic. Use it only against test data with a verified backup.

## Development

```bash
npm install
npm run dev
npm run check
```

Production output is written to `dist/`. Unit tests cover configuration, hashing, path boundaries, manifest behavior, Git adapter behavior, attachment names, links, and release-index validation.

## Releasing

1. Update the version with `npm version patch`, `npm version minor`, or `npm version major`.
2. Run `npm run check`.
3. Push the commit and a tag whose name exactly matches `manifest.json`, without a `v` prefix.
4. GitHub Actions verifies and publishes `main.js`, `manifest.json`, and `styles.css` as release assets.

The separate Oldeng Team Core server publisher retains only the latest and immediately previous static packages for manual recovery. The plugin never installs or overwrites itself.

## License

[MIT](LICENSE) © 2026 ZheWana.
