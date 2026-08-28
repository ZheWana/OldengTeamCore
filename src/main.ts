import { ButtonComponent, Modal, Notice, Plugin, TFile, type App } from "obsidian";
import { DEFAULT_SETTINGS, type SyncSnapshot, type TeamCoreSettings } from "./types";
import { mergeSettings } from "./config";
import { PluginLogger } from "./logger";
import { SyncCoordinator } from "./sync";
import { HISTORY_VIEW_TYPE, TeamCoreHistoryView, TeamCoreSettingTab } from "./ui";
import { compareVersions, PluginUpdater, UPDATE_CHECK_INTERVAL_MS, type PluginRelease } from "./updater";
import { ConflictEditorModal } from "./conflict-ui";

export default class TeamCorePlugin extends Plugin {
  teamCoreSettings: TeamCoreSettings = { ...DEFAULT_SETTINGS };
  coordinator!: SyncCoordinator;
  private statusBar!: HTMLElement;
  private statusText!: HTMLElement;
  private statusProgress!: HTMLProgressElement;
  private latestSnapshot: SyncSnapshot = { state: "uninitialized", pendingFiles: [] };
  private logger!: PluginLogger;
  private updater!: PluginUpdater;
  private updateCheckTask: Promise<void> | undefined;
  private notifiedVersion: string | undefined;
  private conflictEditor: ConflictEditorModal | undefined;
  private openingConflictEditor = false;

  async onload(): Promise<void> {
    this.teamCoreSettings = mergeSettings(await this.loadData());
    this.logger = new PluginLogger(() => false);
    this.updater = new PluginUpdater(this.manifest.id);
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
    this.addSettingTab(new TeamCoreSettingTab(this.app, this));
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new TeamCoreHistoryView(leaf, () => this.teamCoreSettings, () => this.coordinator));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.handleSyncAction() });
    this.addCommand({ id: "resolve-conflicts", name: "解决同步冲突", callback: () => void this.openConflictEditor() });
    this.addCommand({ id: "normalize-attachments", name: "规范化全部附件", callback: () => void this.coordinator.normalizeAllAttachments() });
    this.addCommand({ id: "open-history", name: "打开历史窗口", callback: () => void this.openHistory() });
    this.addCommand({ id: "initialize-remote", name: "初始化并同步当前知识库", callback: () => void this.confirmInitialize() });
    this.addCommand({ id: "clone-remote", name: "从远端知识库导入", callback: () => void this.confirmClone() });
    this.addCommand({ id: "clear-remote-test-data", name: "测试：清空远端 Git 与 S3", callback: () => this.confirmClearRemote() });
    this.addCommand({ id: "copy-diagnostics", name: "复制诊断信息", callback: () => void this.copyDiagnostics() });
    this.addCommand({ id: "check-for-updates", name: "检查插件更新", callback: () => void this.checkForPluginUpdate(true) });
    this.registerEvent(this.app.vault.on("modify", (file) => { if (file instanceof TFile) this.coordinator.markFileChanged(file); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (file instanceof TFile) this.coordinator.markFileRenamed(file, oldPath); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (file instanceof TFile) this.coordinator.markFileChanged(file); }));
    this.app.workspace.onLayoutReady(() => {
      void this.coordinator.prepareLocalVault()
        .then(() => this.coordinator.refreshState())
        .catch((error) => new Notice(`无法创建“私人笔记”文件夹：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.coordinator.start());
      void this.checkForPluginUpdate(false);
    });
    this.registerInterval(window.setInterval(() => void this.checkForPluginUpdate(false), UPDATE_CHECK_INTERVAL_MS));
    this.updateSnapshot(this.latestSnapshot);
  }

  onunload(): void {
    this.conflictEditor?.close();
    this.conflictEditor = undefined;
    this.coordinator?.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.teamCoreSettings);
    this.coordinator?.start();
  }

  async checkForPluginUpdate(manual = true): Promise<void> {
    if (this.updateCheckTask) return this.updateCheckTask;
    const task = this.performUpdateCheck(manual);
    this.updateCheckTask = task;
    try { await task; }
    finally { if (this.updateCheckTask === task) this.updateCheckTask = undefined; }
  }

  private async performUpdateCheck(manual: boolean): Promise<void> {
    try {
      const index = await this.updater.fetchIndex();
      const current = this.manifest.version;
      if (compareVersions(index.latest.version, current) > 0) {
        this.showUpdateNotice(index.latest, current, manual);
      } else if (manual) {
        new Notice(`Oldeng Team Core 已是最新版本（${current}）`);
      }
    } catch (error) {
      this.logger.warn("Plugin update check failed", error);
      if (manual) new Notice(`检查更新失败：${error instanceof Error ? error.message : String(error)}`, 10_000);
    }
  }

  private showUpdateNotice(release: PluginRelease, current: string, manual: boolean): void {
    if (!manual && this.notifiedVersion === release.version) return;
    this.notifiedVersion = release.version;
    const fragment = createFragment();
    const message = fragment.createDiv();
    message.setText(`Oldeng Team Core 有新版本：${current} → ${release.version}`);
    if (release.notes.trim()) {
      const notes = fragment.createDiv();
      notes.addClass("team-core-update-notes");
      notes.setText(release.notes.trim());
    }
    const notice = new Notice(fragment, 0);
    const actions = notice.messageEl.createDiv("team-core-update-actions");
    new ButtonComponent(actions).setButtonText("稍后").onClick(() => notice.hide());
    new ButtonComponent(actions).setButtonText("查看发布页").setCta().onClick(() => {
      notice.hide();
      window.open("https://github.com/ZheWana/OldengTeamCore/releases/latest", "_blank", "noopener");
    });
  }

  private updateSnapshot(snapshot: SyncSnapshot): void {
    this.latestSnapshot = snapshot;
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
          new Notice("远端仓库已有内容。请使用“从远端知识库导入”，不要重复初始化当前 Vault。");
          return;
        }
        if (!window.confirm("远端仓库已有内容，将按普通同步流程合并本地与远端更改。是否继续？")) return;
        await this.coordinator.runManual();
        new Notice("已执行同步；请查看状态栏确认结果");
        return;
      }
      if (!window.confirm("检测到你要初始化当前知识库并推送到远端，是否继续？")) return;
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
        await this.coordinator.runManual();
        new Notice("已按同一知识库执行同步");
        return;
      }
      if (!info.localHasManagedFiles) {
        if (!window.confirm("本地知识库为空，将从远端导入，是否继续？")) return;
        await this.coordinator.cloneRemote();
      } else {
        const path = this.coordinator.getVaultBasePath();
        const location = path ? `\n\n备份目录：${path}` : "";
        if (path) {
          const backupNotice = new Notice(`请先备份知识库目录：${path}`, 0);
          const copy = backupNotice.messageEl.createEl("button", { text: "复制路径" });
          copy.addEventListener("click", () => void navigator.clipboard.writeText(path));
        }
        if (!window.confirm(`本地已有内容。请先备份后确认远端覆盖本地。${location}\n\n确定后将删除本地非 .obsidian 文件。`)) return;
        await this.coordinator.cloneRemote(true);
      }
      new Notice("远端知识库已导入");
    }
    catch (error) { new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`); }
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
    this.contentEl.createEl("p", { text: "此操作不可撤销。将删除远端 Git main，并删除当前 S3 Prefix 下由 Oldeng Team Core 管理的全部附件对象。" });
    const targets = this.contentEl.createEl("ul", { cls: "team-core-clear-targets" });
    targets.createEl("li", { text: `Git：${safeRemoteLabel(this.settings.gitUrl)}` });
    targets.createEl("li", { text: `S3：${this.settings.s3Bucket || "未配置"}/${[this.settings.s3Prefix.replace(/^\/+|\/+$/g, ""), "sha256/"].filter(Boolean).join("/")}` });
    this.contentEl.createEl("p", { text: "“私人笔记”文件夹、Vault 中的本地笔记和本地附件不会删除；本地 Git 元数据会重置，避免自动同步把测试内容立即推回远端。", cls: "team-core-clear-note" });
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
