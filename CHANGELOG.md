# Changelog

## 0.1.11

- Preserve balanced top and bottom spacing for the first and last shared-plugin rows in the management modal.

## 0.1.10

- Hide the `assets/` folder from Obsidian's file explorer and search while preserving attachment synchronization.
- Align shared-plugin management rows so the first plugin no longer sits higher than the others.

All notable changes to Oldeng Team Core are documented in this file.

## 0.1.6 - 2026-08-28

- Reworked quick configuration import/export into one aligned responsive row.
- Widened and aligned settings inputs across Git, S3, and synchronization sections.

## 0.1.5 - 2026-08-28

- Fixed remote attachment restoration when a new Vault uses the same Git username as the original uploader.
- Retried unchanged manifest entries whose local attachment files are still missing without rehashing existing attachments.

## 0.1.4 - 2026-08-27

- Renamed the public and user-visible plugin name to Oldeng Team Core.
- Kept the stable `team-core` plugin ID and installation path so existing settings and installations continue to work.

## 0.1.3 - 2026-08-27

- Prepared metadata and source for Obsidian Community directory submission.
- Respected custom Obsidian configuration-directory names in all synchronization filters.
- Kept update checks reminder-only to comply with Community plugin policy.
- Updated and audited the public development toolchain.

## 0.1.2 - 2026-08-27

- Added cross-platform Git and S3 knowledge-base synchronization.
- Added incremental content-addressed attachments and full normalization.
- Added synchronization progress, file history, attachment audit, and diagnostics.
- Added the local-only `私人笔记/` folder.
- Added release-index update reminders without self-installation.
- Added guarded remote test cleanup for Git and Oldeng Team Core-managed S3 objects.
