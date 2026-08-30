import { ButtonComponent, MarkdownView, Modal, Notice, Platform, Plugin, TFile, TFolder, type App } from "obsidian";
import { DEFAULT_SETTINGS, type SyncSnapshot, type TeamCoreSettings } from "./types";
import { mergeSettings } from "./config";
import { PluginLogger } from "./logger";
import { SyncCoordinator } from "./sync";
import { HISTORY_VIEW_TYPE, TeamCoreHistoryView, TeamCoreSettingTab } from "./ui";
import { ConflictEditorModal } from "./conflict-ui";
import { requestConfirmation } from "./confirm";
import { createVaultAdapter, isHiddenAssetsFolderPath } from "./vault";
import { GitRepository } from "./git";
import { FileAuthorService } from "./file-authors";
import { FILE_AUTHORS_PATH } from "./constants";

export default class TeamCorePlugin extends Plugin {
  teamCoreSettings: TeamCoreSettings = { ...DEFAULT_SETTINGS };
  coordinator!: SyncCoordinator;
  private statusBar!: HTMLElement;
  private statusText!: HTMLElement;
  private statusProgress!: HTMLProgressElement;
  private latestSnapshot: SyncSnapshot = { state: "uninitialized", pendingFiles: [] };
  private logger!: PluginLogger;
  private conflictEditor: ConflictEditorModal | undefined;
  private mobileSyncProgress: MobileSyncProgressModal | undefined;
  private openingConflictEditor = false;
  private authorService!: FileAuthorService;
  private lastAuthorRefreshAt: number | undefined;

  async onload(): Promise<void> {
    this.teamCoreSettings = mergeSettings(await this.loadData());
    this.logger = new PluginLogger(() => false);
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("team-core-status");
    this.statusBar.addEventListener("click", () => void this.handleSyncAction());
    this.statusText = this.statusBar.createSpan("team-core-status-text");
    this.statusProgress = this.statusBar.createEl("progress", { cls: "team-core-status-progress" });
    this.statusProgress.hidden = true;
    this.coordinator = new SyncCoordinator(this.app, () => this.teamCoreSettings, {
      onSnapshot: (snapshot) => this.updateSnapshot(snapshot),
      onNotice: (message) => new Notice(message)
    }, this.logger);
    this.authorService = this.createFileAuthorService();
    this.addSettingTab(new TeamCoreSettingTab(this.app, this));
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new TeamCoreHistoryView(
      leaf,
      () => this.teamCoreSettings,
      () => this.coordinator,
      () => this.authorService
    ));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.handleSyncAction() });
    this.addCommand({ id: "resolve-conflicts", name: "解决同步冲突", callback: () => void this.openConflictEditor() });
    this.addCommand({ id: "normalize-attachments", name: "规范化全部附件", callback: () => void this.coordinator.normalizeAllAttachments() });
    this.addCommand({ id: "open-history", name: "打开历史窗口", callback: () => void this.openHistory() });
    this.addCommand({ id: "initialize-remote", name: "初始化并同步当前知识库", callback: () => void this.confirmInitialize() });
    this.addCommand({ id: "clone-remote", name: "从远端知识库导入", callback: () => void this.confirmClone() });
    this.addCommand({ id: "overwrite-from-remote", name: "重置本地并重新同步", callback: () => void this.confirmRemoteOverwrite() });
    this.addCommand({ id: "clear-remote-test-data", name: "测试：清空远端 Git 与 S3", callback: () => this.confirmClearRemote() });
    this.addCommand({ id: "copy-diagnostics", name: "复制诊断信息", callback: () => void this.copyDiagnostics() });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile)) return;
      if (file.path === FILE_AUTHORS_PATH) this.invalidateFileAuthors();
      this.coordinator.markFileChanged(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) {
        this.authorService.invalidate();
        this.coordinator.markFileRenamed(file, oldPath);
        void this.refreshNoteAuthors();
      }
      else if (file instanceof TFolder) this.coordinator.markFolderRenamed(file, oldPath);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) {
        if (file.path === FILE_AUTHORS_PATH) this.invalidateFileAuthors();
        this.coordinator.markFileDeleted(file);
      }
      else if (file instanceof TFolder) this.coordinator.markFolderDeleted(file.path);
    }));
    this.registerEvent(this.app.workspace.on("editor-paste", (event, editor, info) => {
      if (event.defaultPrevented) return;
      if (this.coordinator.handleEditorPaste(event, editor, info.file)) event.preventDefault();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.refreshNoteAuthors()));
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.refreshNoteAuthors()));
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile) this.coordinator.markFileChanged(file);
      }));
      void this.coordinator.prepareLocalVault()
        .then(() => this.coordinator.refreshState())
        .catch((error) => new Notice(`无法创建“私人笔记”文件夹：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.coordinator.start());
      void this.refreshNoteAuthors();
    });
    this.register(() => this.removeNoteAuthorDecorations());
    this.hideAssetsInFileExplorer();
    this.updateSnapshot(this.latestSnapshot);
  }

  onunload(): void {
    this.conflictEditor?.close();
    this.conflictEditor = undefined;
    this.mobileSyncProgress?.close();
    this.mobileSyncProgress = undefined;
    this.coordinator?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.teamCoreSettings);
    this.authorService = this.createFileAuthorService();
    void this.refreshNoteAuthors();
    this.coordinator?.start();
  }

  private hideAssetsInFileExplorer(): void {
    const apply = (): void => {
      const titles = document.body?.findAll(".nav-files-container .nav-folder-title") ?? [];
      for (const title of titles) {
        const folder = title.matchParent(".tree-item.nav-folder");
        if (!folder) continue;
        folder.toggleClass("team-core-assets-hidden", isHiddenAssetsFolderPath(title.getAttr("data-path") ?? ""));
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { attributes: true, attributeFilter: ["data-path"], childList: true, subtree: true });
    this.register(() => observer.disconnect());
  }

  private async refreshNoteAuthors(): Promise<void> {
    const views = this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
    await Promise.all(views.map((view) => this.decorateNoteAuthors(view)));
  }

  private invalidateFileAuthors(): void {
    this.authorService.invalidate();
    void this.refreshNoteAuthors();
  }

  private createFileAuthorService(): FileAuthorService {
    const vault = createVaultAdapter(this.app.vault.adapter);
    const repository = new GitRepository(vault, this.teamCoreSettings, this.logger, this.app.vault.configDir);
    return new FileAuthorService(vault, repository, () => {
      this.coordinator.markManagedPathChanged(FILE_AUTHORS_PATH);
      void this.refreshNoteAuthors();
    });
  }

  private async decorateNoteAuthors(view: MarkdownView): Promise<void> {
    const file = view.file;
    const title = view.containerEl.querySelector<HTMLElement>(".inline-title");
    if (!file || !title) return;
    const authors = await this.authorService.getAuthors(file.path).catch((error: unknown) => {
      this.logger.warn("Unable to load note authors", { filepath: file.path, error });
      return [];
    });
    if (view.file?.path !== file.path || !title.isConnected) return;
    if (!authors.length) {
      title.removeClass("team-core-inline-title-decorated");
      title.removeAttribute("data-team-core-authors");
      return;
    }
    title.addClass("team-core-inline-title-decorated");
    title.setAttr("data-team-core-authors", ` - ${authors.join(", ")}`);
    title.setAttr("aria-description", `作者：${authors.join("、")}`);
  }

  private removeNoteAuthorDecorations(): void {
    document.querySelectorAll<HTMLElement>(".team-core-inline-title-decorated").forEach((title) => {
      title.removeClass("team-core-inline-title-decorated");
      title.removeAttribute("data-team-core-authors");
      title.removeAttribute("aria-description");
    });
  }

  private updateSnapshot(snapshot: SyncSnapshot): void {
    this.latestSnapshot = snapshot;
    this.updateMobileSyncProgress(snapshot);
    if (snapshot.state === "synced" && snapshot.lastSyncAt !== undefined && snapshot.lastSyncAt !== this.lastAuthorRefreshAt) {
      this.lastAuthorRefreshAt = snapshot.lastSyncAt;
      this.authorService.invalidate();
      void this.refreshNoteAuthors();
    }
    if (!this.statusBar) return;
    const state = { uninitialized: "未初始化", synced: "已同步", "local-changes": "有本地修改", syncing: "同步中", conflict: "有冲突", offline: "离线", error: "同步错误" }[snapshot.state];
    const author = snapshot.currentAuthor ? ` · 作者：${snapshot.currentAuthor}` : "";
    const progress = snapshot.progress;
    const progressLabel = progress && progress.total > 0 ? `${progress.phase} ${progress.current}/${progress.total}` : progress?.phase;
    const progressText = progressLabel ? ` · ${progressLabel}` : "";
    this.statusText.setText(`Oldeng Team Core：${state}${progressText}${author}`);
    if (progress && progress.total > 0) {
      this.statusProgress.max = progress.total;
      this.statusProgress.value = progress.current;
      this.statusProgress.hidden = false;
      this.statusProgress.setAttr("aria-label", `${progress.phase} ${progress.current}/${progress.total}`);
    } else {
      this.statusProgress.hidden = true;
      this.statusProgress.removeAttribute("aria-label");
    }
    const actionLabel = snapshot.state === "conflict" ? "点击解决同步冲突" : "点击立即同步";
    this.statusBar.setAttr("aria-label", progressLabel ? `${actionLabel}，${progressLabel}` : actionLabel);
    this.statusBar.setAttr("title", progress?.item ? `${progressLabel ?? progress.phase}：${progress.item}` : actionLabel);
  }

  private updateMobileSyncProgress(snapshot: SyncSnapshot): void {
    if (!Platform.isMobile) return;
    if (snapshot.state === "syncing") {
      if (!this.mobileSyncProgress) {
        this.mobileSyncProgress = new MobileSyncProgressModal(this.app, snapshot, () => {
          this.mobileSyncProgress = undefined;
        });
        this.mobileSyncProgress.open();
      } else {
        this.mobileSyncProgress.setSnapshot(snapshot);
      }
      return;
    }
    if (this.mobileSyncProgress) {
      this.mobileSyncProgress.close();
      this.mobileSyncProgress = undefined;
    }
  }

  private async handleSyncAction(): Promise<void> {
    if (this.latestSnapshot.state === "conflict") {
      await this.openConflictEditor();
      return;
    }
    await this.coordinator.runManual();
  }

  private async openConflictEditor(): Promise<void> {
    if (this.conflictEditor || this.openingConflictEditor) return;
    this.openingConflictEditor = true;
    try {
      const session = await this.coordinator.getConflictEditorSession();
      if (!session.files.length) {
        new Notice("当前没有待解决的同步冲突");
        return;
      }
      const modal = new ConflictEditorModal(this.app, session, async (resolutions) => {
        const snapshot = await this.coordinator.resolveConflicts(resolutions);
        if (snapshot.state === "synced") new Notice("冲突已解决并完成同步");
        else if (snapshot.state === "conflict") new Notice("合并提交已保存，但远端又产生了新冲突，请重新打开冲突编辑器", 10_000);
        else if (snapshot.state === "error" || snapshot.state === "offline") new Notice(`合并提交已保存，后续同步未完成：${snapshot.lastError ?? "请稍后重试"}`, 10_000);
        else new Notice("冲突已解决，合并提交将在下次同步时推送");
      }, () => {
        if (this.conflictEditor === modal) this.conflictEditor = undefined;
      });
      this.conflictEditor = modal;
      modal.open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 10_000);
    } finally {
      this.openingConflictEditor = false;
    }
  }

  private async openHistory(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async confirmInitialize(): Promise<void> {
    if (!this.teamCoreSettings.gitUrl) { new Notice("请先配置 Git 远端 URL"); return; }
    try {
      const info = await this.coordinator.inspectConnection();
      if (info.remoteHasCommits) {
        const configuredRemote = this.teamCoreSettings.gitUrl.replace(/\/+$/, "");
        const localRemote = info.localRemoteUrl?.replace(/\/+$/, "");
        if (!info.localRepository || localRemote !== configuredRemote) {
          new Notice("远端仓库已有内容。请使用“从远端知识库导入”，不要重复初始化当前知识库。");
          return;
        }
        if (!await requestConfirmation(this.app, {
          title: "继续同步现有仓库",
          message: "远端仓库已有内容，将按普通同步流程合并本地与远端更改。是否继续？",
          confirmText: "继续同步"
        })) return;
        await this.coordinator.runManual();
        new Notice("已执行同步；请查看状态栏确认结果");
        return;
      }
      if (!await requestConfirmation(this.app, {
        title: "初始化知识库",
        message: "检测到你要初始化当前知识库并推送到远端，是否继续？",
        confirmText: "初始化并同步"
      })) return;
      await this.coordinator.initializeEmptyRemote();
      new Notice("知识库已初始化并同步");
    }
    catch (error) { new Notice(`初始化失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  private async confirmClone(): Promise<void> {
    if (!this.teamCoreSettings.gitUrl) { new Notice("请先配置 Git 远端 URL"); return; }
    try {
      const info = await this.coordinator.inspectConnection();
      if (!info.remoteHasCommits) {
        new Notice("远端仓库为空，请使用“初始化并同步当前知识库”。");
        return;
      }
      const configuredRemote = this.teamCoreSettings.gitUrl.replace(/\/+$/, "");
      const localRemote = info.localRemoteUrl?.replace(/\/+$/, "");
      if (info.localRepository && localRemote === configuredRemote) {
        new Notice("当前知识库已连接该远端。“从远端知识库导入”不会覆盖本地；需要完整重新下载时，请使用“重置本地并重新同步”。", 10_000);
        return;
      }
      if (!info.localHasManagedFiles) {
        if (!await requestConfirmation(this.app, {
          title: "导入远端知识库",
          message: "本地知识库为空，将从远端导入，是否继续？",
          confirmText: "开始导入"
        })) return;
        await this.coordinator.cloneRemote();
      } else {
        const path = this.coordinator.getVaultBasePath();
        const location = path ? `\n\n备份目录：${path}` : "";
        if (!await requestConfirmation(this.app, {
          title: "确认重置本地知识库",
          message: `远端 Git 与 S3 不会修改。本地已有内容，请先备份。${location}\n\n确定后将清空本地公共知识库和 Git 元数据，保留 Obsidian 配置、私人笔记和本地回收站，再从远端完整下载。`,
          confirmText: "清空并重新同步",
          destructive: true
        })) return;
        await this.coordinator.cloneRemote(true);
      }
      new Notice("远端知识库已导入");
    }
    catch (error) { new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  async confirmRemoteOverwrite(): Promise<void> {
    if (!this.teamCoreSettings.gitUrl) { new Notice("请先配置 Git 远端 URL"); return; }
    try {
      const info = await this.coordinator.inspectConnection();
      if (!info.remoteHasCommits) {
        new Notice("远端仓库为空，无法重新同步。请使用“初始化并同步当前知识库”。");
        return;
      }
      const path = this.coordinator.getVaultBasePath();
      const location = path ? `\n\n备份目录：${path}` : "";
      if (!await requestConfirmation(this.app, {
        title: "重置本地知识库并重新同步",
        message: `远端 Git 与 S3 不会修改。将清空本地公共知识库和 Git 元数据，保留 Obsidian 配置、私人笔记和本地回收站，再从远端完整下载。请确认已备份本地知识库。${location}`,
        confirmText: "清空并重新同步",
        destructive: true
      })) return;
      await this.coordinator.cloneRemote(true);
      new Notice("已重置本地知识库并从远端重新同步");
    } catch (error) { new Notice(`重新同步失败：${error instanceof Error ? error.message : String(error)}`, 10_000); }
  }

  private confirmClearRemote(): void {
    new ClearRemoteConfirmationModal(this.app, this.teamCoreSettings, async () => {
      const result = await this.coordinator.clearRemoteData();
      const git = result.deletedGitBranch ? "远端 Git main 已删除" : "远端 Git main 原本为空";
      new Notice(`测试数据已清空：${git}，删除 ${result.deletedS3Objects} 个 Oldeng Team Core 附件对象。本地笔记和附件已保留。`, 10_000);
    }).open();
  }

  private async copyDiagnostics(): Promise<void> {
    const diagnostics = JSON.stringify({ state: this.latestSnapshot.state, progress: this.latestSnapshot.progress, pendingFiles: this.latestSnapshot.pendingFiles, pendingAssets: this.latestSnapshot.pendingAssets, lastSyncAt: this.latestSnapshot.lastSyncAt, lastError: this.latestSnapshot.lastError, pluginVersion: this.manifest.version }, null, 2);
    await navigator.clipboard.writeText(diagnostics);
    new Notice("已复制脱敏诊断信息");
  }
}

class ClearRemoteConfirmationModal extends Modal {
  constructor(private readonly hostApp: App, private readonly settings: TeamCoreSettings, private readonly onConfirm: () => Promise<void>) {
    super(hostApp);
  }

  onOpen(): void {
    this.titleEl.setText("确认清空远端测试数据");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "此操作不可撤销。将删除远端 Git main，并删除当前 S3 前缀下由本插件管理的全部附件对象。" });
    const targets = this.contentEl.createEl("ul", { cls: "team-core-clear-targets" });
    targets.createEl("li", { text: `Git：${safeRemoteLabel(this.settings.gitUrl)}` });
    targets.createEl("li", { text: `S3：${this.settings.s3Bucket || "未配置"}/${[this.settings.s3Prefix.replace(/^\/+|\/+$/g, ""), "sha256/"].filter(Boolean).join("/")}` });
    this.contentEl.createEl("p", { text: "“私人笔记”文件夹、知识库中的本地笔记和本地附件不会删除；本地 Git 元数据会重置，避免自动同步把测试内容立即推回远端。", cls: "team-core-clear-note" });
    const status = this.contentEl.createEl("p", { cls: "team-core-clear-status" });
    const actions = this.contentEl.createDiv("team-core-clear-actions");
    const cancel = new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
    const confirm = new ButtonComponent(actions)
      .setButtonText("确认清空")
      .setCta()
      .onClick(async () => {
        cancel.setDisabled(true);
        confirm.setDisabled(true);
        status.setText("正在清空远端数据，请勿关闭 Obsidian……");
        try {
          await this.onConfirm();
          this.close();
        } catch (error) {
          status.setText(`清空失败：${error instanceof Error ? error.message : String(error)}`);
          cancel.setDisabled(false);
          confirm.setDisabled(false);
        }
      });
    confirm.buttonEl.addClass("team-core-destructive-button");
  }
}

class MobileSyncProgressModal extends Modal {
  private snapshot: SyncSnapshot;
  private readonly onClosed: () => void;

  constructor(hostApp: App, snapshot: SyncSnapshot, onClosed: () => void) {
    super(hostApp);
    this.snapshot = snapshot;
    this.onClosed = onClosed;
  }

  onOpen(): void {
    this.modalEl.addClass("team-core-mobile-sync-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }

  setSnapshot(snapshot: SyncSnapshot): void {
    this.snapshot = snapshot;
    if (this.contentEl) this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.titleEl.setText("同步进度");
    const progress = this.snapshot.progress;
    const summary = this.contentEl.createDiv("team-core-mobile-sync-summary");
    summary.createEl("strong", { text: progress?.phase ?? "同步中" });
    if (progress && progress.total > 0) {
      summary.createSpan({ text: `${progress.current}/${progress.total}` });
      const progressBar = this.contentEl.createEl("progress", { cls: "team-core-mobile-sync-progress" });
      progressBar.max = progress.total;
      progressBar.value = progress.current;
      progressBar.setAttr("aria-label", `${progress.phase} ${progress.current}/${progress.total}`);
    } else {
      const progressBar = this.contentEl.createEl("progress", { cls: "team-core-mobile-sync-progress" });
      progressBar.removeAttribute("value");
      progressBar.setAttr("aria-label", progress?.phase ?? "同步中");
    }
    this.contentEl.createEl("p", {
      cls: "team-core-mobile-sync-item",
      text: progress?.item ?? "正在准备同步，请稍候……"
    });
  }
}

function safeRemoteLabel(value: string): string {
  try {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim() ? "已配置的 Git 仓库" : "未配置";
  }
}
