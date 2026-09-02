<h1 align="center">Oldeng Team Core</h1>

<div align="center">

面向小型团队的 Obsidian 知识库同步插件

[![Obsidian 下载量](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=Obsidian%20下载量&query=%24%5B%22team-core%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=team-core)
[![最新版本](https://img.shields.io/github/v/release/ZheWana/OldengTeamCore?label=最新版本)](https://github.com/ZheWana/OldengTeamCore/releases/latest)
[![CI](https://github.com/ZheWana/OldengTeamCore/actions/workflows/ci.yml/badge.svg)](https://github.com/ZheWana/OldengTeamCore/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/github/license/ZheWana/OldengTeamCore)](./LICENSE)

中文 | [English](./README_EN.md)

</div>

Oldeng Team Core 使用 Git 同步 Markdown 笔记与团队插件配置，使用兼容 S3 的对象存储同步附件，并在桌面端和移动端提供一致的同步、历史、冲突处理和恢复体验。

> [!IMPORTANT]
> **AI 开发声明**
>
> 本插件完全由 AI 开发，包括源代码、测试、文档和自动化工作流。人类负责提出需求、产品决策、部署授权和验收测试。

## 快速开始

### 安装

1. 打开 Obsidian 的 **设置 → 第三方插件 → 浏览**。
2. 搜索 **Oldeng Team Core**，安装并启用。
3. 打开 **设置 → Oldeng Team Core → 快速导入 / 导出**，粘贴管理员提供的配置字符串。
4. 填写自己的 Git `username`。团队约定使用姓名的全小写拼音，例如 `wangxiaoming`。
5. 对已有远端知识库，执行命令 **Oldeng Team Core：从远端知识库导入**。

日常使用不需要反复打开命令面板。点击 Obsidian 右下角的 Team Core 状态栏即可执行双向同步；自动同步默认关闭，可以在设置中自行启用。

> [!WARNING]
> **立即同步是双向同步。** 本地删除会作为有效修改推送到远端。误删文件且尚未同步时，不要点击立即同步，请使用 **重置本地并重新同步** 从远端恢复。

无法通过社区插件安装时，也可以从 [GitHub Releases](https://github.com/ZheWana/OldengTeamCore/releases) 下载同一版本的 `main.js`、`manifest.json` 和 `styles.css`，放入：

```text
<Vault>/.obsidian/plugins/team-core/
```

## 核心能力

### 笔记同步

- 通过标准 Git Smart HTTP 批量提交、拉取、合并和推送 Markdown 文件。
- 遇到非快进推送时执行有限次数的重新拉取与合并，绝不自动强制推送。
- 桌面端状态栏和移动端弹窗显示同步阶段、当前项和数值进度。
- 提供明确的初始化、远端导入、本地重置和远端测试清理入口。

### 附件同步

- `assets/` 不进入 Git，附件以 `tc-sha256-<sha256>.<扩展名>` 保存到兼容 S3 的对象存储。
- Git 只追踪 `.team/assets-manifest.json`，并且仅在对象上传成功后提交清单。
- 大于 8 MiB 的附件使用 8 MiB Range 分片下载，写入临时文件并在 SHA-256 校验通过后原子替换。
- 提供附件审计、孤立附件清理和既有附件规范化工具。
- `assets/` 和 `私人笔记/assets/` 会从 Obsidian 文件列表与搜索中隐藏。

### 团队看板与历史

- 团队看板展示本地文章数、本地附件数、年度提交墙和文档作者分布。
- “本周最新更新”按本地 Markdown 保存时间展示，支持 `置顶-` 文章、分页和刷新。
- 独立提交历史页支持按文件路径搜索和分页加载。
- 打开笔记时，可在标题旁显示该文件的作者；手动作者归属优先，无记录时回退到完整 Git 历史。
- Git 作者显示名称可以映射为团队常用名称，不会改写 Git 历史。

### 公共插件

- 通过插件内的白名单界面选择需要共享的社区插件目录。
- 同步所选插件的 `main.js`、`manifest.json`、`styles.css`、`data.json` 和其他目录内容。
- 同步公共插件的启用状态，同时保留每位成员自己的插件与启用状态。
- 公共插件发生变化后显示必须确认的重启弹窗，桌面端可直接重启 Obsidian。

### 冲突与诊断

- 内置三方冲突编辑器，可选择本地版本、远端版本、自定义结果或删除文件。
- 冲突解决后生成标准双父提交，再继续正常同步。
- 诊断系统保留最近 800 条脱敏日志，记录同步阶段和附件传输边界。
- 诊断报告以 JSON 文件导出到本地 `私人笔记/`，不会进入 Git 或 S3。

## 工作原理

```text
Obsidian Vault
  └─ Oldeng Team Core
      ├─ Markdown / 团队配置 ── Git Smart HTTP ── Git 仓库
      ├─ assets/ ───────────── S3 API ────────── 对象存储
      └─ 私人笔记/ ─────────── 仅保留在本机
```

附件变更遵循固定顺序：

```text
扫描并计算 SHA-256
  → 确认附件对象已上传
  → 更新附件清单
  → 提交 Markdown 与清单
  → 推送 Git
```

这样可以避免 Git 提交引用尚未上传的附件对象。普通同步是增量同步，已存在且哈希一致的附件不会重复上传。

## 私人笔记

插件会创建精确路径 `私人笔记/`。该目录及其子目录不进入 Git，内部附件也不会上传 S3。名称相似但路径不同的目录，例如 `私人笔记备份/`，仍属于公共同步范围。

在公共区域与私人笔记之间移动 Markdown 时，插件会迁移该笔记独占引用的附件并重写链接。如果附件仍被其他笔记引用，则保留共享副本，避免破坏其他文档。

> [!NOTE]
> `.gitignore` 只能阻止未来追踪，不能清除历史提交。如果旧仓库曾提交私人内容，需要由管理员重写或重建仓库历史。

## 同步与恢复边界

| 场景 | 应使用的操作 | 对远端的影响 |
|---|---|---|
| 正常新增、编辑或主动删除文章 | 点击右下角状态栏立即同步 | 推送本地修改与删除 |
| 误删文件且尚未同步 | 重置本地并重新同步 | 无，远端覆盖本地公共内容 |
| 希望完整重新下载知识库 | 重置本地并重新同步 | 无，保留远端 Git 与 S3 |
| 普通内容冲突 | 使用内置冲突编辑器 | 解决后新增合并提交 |
| 测试环境需要清空远端 | 测试：清空远端 Git 与 S3 | 删除远端 Git `main` 和托管 S3 对象 |

**重置本地并重新同步** 会保留 `私人笔记/`、`.obsidian/` 和本地回收站，清除其余本地公共内容与 Git 元数据后重新导入远端。

远端清理属于测试期破坏性功能，需要显式确认。Git 与 S3 删除无法组成原子事务，只应在已验证备份的测试环境中使用。

## 配置与安全

运行插件需要：

- Obsidian `1.12.3` 或更高版本；
- 支持 Basic Auth 的标准 Git Smart HTTP 仓库；
- 私有的 S3 兼容 Bucket；
- 对同一 Git 仓库和 S3 前缀具有权限的团队成员。

快速配置字符串包含共享 Git 和 S3 凭据以及作者显示映射。它使用 `tc1.` 压缩格式，但**不是加密数据**，应当像密码一样通过可信私密渠道发送。本机用户名和自动同步选择不会被配置导入覆盖。

插件仅为同步功能访问用户配置的 Git 与 S3 服务，不包含遥测或广告。凭据保存在本机 `.obsidian/plugins/team-core/data.json`，不会被 Team Core 提交到 Git。

## 开发

```bash
npm install
npm run dev
npm run check
```

生产构建位于 `dist/`。`npm run check` 包含构建、TypeScript 类型检查、Vitest、ESLint、Stylelint 和 Obsidian 插件校验。

发布版本必须提供 `.github/release-notes/<版本>.md`。推送与 `manifest.json` 完全一致且不带 `v` 前缀的标签后，GitHub Actions 会验证并发布 `main.js`、`manifest.json` 和 `styles.css`。

完整更新记录见 [CHANGELOG.md](./CHANGELOG.md)。参与开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全问题请参阅 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © 2026 ZheWana
