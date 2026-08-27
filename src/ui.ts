import { ItemView, Notice, PluginSettingTab, Setting, WorkspaceLeaf, type App, type Plugin } from "obsidian";
import { exportSettings, importSettings } from "./config";
import { readManifest } from "./manifest";
import { GitRepository } from "./git";
import type { CommitSummary, ReferenceInfo, TeamCoreSettings } from "./types";
import { buildReferenceAudit, createVaultAdapter } from "./vault";
import type { SyncCoordinator } from "./sync";

export const HISTORY_VIEW_TYPE = "team-core-history";

export class TeamCoreHistoryView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly getSettings: () => TeamCoreSettings, private readonly getSync: () => SyncCoordinator) {
    super(leaf);
  }

  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "Oldeng Team Core 历史"; }
  getIcon(): string { return "git-commit-horizontal"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("team-core-history-view");
    container.createEl("h2", { text: "知识库历史" });
    const toolbar = container.createDiv("team-core-toolbar");
    const syncButton = toolbar.createEl("button", { text: "立即同步" });
    syncButton.addEventListener("click", () => void this.getSync().runManual().then(() => this.render()));
    const auditButton = toolbar.createEl("button", { text: "附件审计" });
    auditButton.addEventListener("click", () => void this.renderAudit(container));
    const settings = this.getSettings();
    if (!settings.gitUrl) {
      container.createEl("p", { text: "请先在 Oldeng Team Core 设置中配置 Git 和 S3。" });
      return;
    }
    const repo = new GitRepository(createVaultAdapter(this.app.vault.adapter), settings, consoleLogger(), this.app.vault.configDir);
    let commits: CommitSummary[] = [];
    try { commits = await repo.log(undefined, 200); } catch (error) { container.createEl("p", { text: `历史暂不可用：${String(error)}` }); return; }
    const counts = this.counts(commits);
    const summary = container.createDiv("team-core-summary-grid");
    for (const [label, value] of [["近一周", counts.week], ["近一月", counts.month], ["近一年", counts.year]]) {
      const card = summary.createDiv("team-core-stat");
      card.createEl("strong", { text: String(value) });
      card.createSpan({ text: String(label) });
    }
    const authors = new Map<string, number>();
    for (const commit of commits) authors.set(commit.author, (authors.get(commit.author) ?? 0) + 1);
    const authorSection = container.createDiv("team-core-section");
    authorSection.createEl("h3", { text: "作者统计" });
    const authorList = authorSection.createEl("ul");
    for (const [author, count] of [...authors.entries()].sort((a, b) => b[1] - a[1])) authorList.createEl("li", { text: `${author} · ${count} 次提交` });
    const timeline = container.createDiv("team-core-section");
    timeline.createEl("h3", { text: "提交时间线" });
    const list = timeline.createDiv({ cls: "team-core-commit-list" });
    for (const commit of commits) {
      const row = list.createDiv("team-core-commit");
      row.createDiv("team-core-commit-dot");
      const detail = row.createDiv("team-core-commit-detail");
      detail.createEl("strong", { text: commit.message || "无提交说明" });
      detail.createSpan({ text: `${commit.author} · ${new Date(commit.timestamp).toLocaleString()} · ${commit.shortOid}` });
    }
  }

  private counts(commits: CommitSummary[]): { week: number; month: number; year: number } {
    const now = Date.now();
    return {
      week: commits.filter((commit) => now - commit.timestamp <= 7 * 86_400_000).length,
      month: commits.filter((commit) => now - commit.timestamp <= 30 * 86_400_000).length,
      year: commits.filter((commit) => now - commit.timestamp <= 365 * 86_400_000).length
    };
  }

  private async renderAudit(container: HTMLElement): Promise<void> {
    container.empty();
    container.createEl("h2", { text: "附件审计" });
    const back = container.createEl("button", { text: "返回历史" });
    back.addEventListener("click", () => void this.render());
    const audit = await buildReferenceAudit(this.app.vault);
    const orphan = audit.filter((item) => item.orphan);
    const summary = container.createEl("p", { text: `共 ${audit.length} 个附件，${orphan.length} 个孤立附件。` });
    summary.addClass("team-core-audit-summary");
    const table = container.createEl("table");
    const header = table.createEl("tr");
    for (const label of ["附件", "引用次数", "引用笔记", "状态"]) header.createEl("th", { text: label });
    for (const item of audit) {
      const row = table.createEl("tr");
      row.createEl("td", { text: item.path });
      row.createEl("td", { text: String(item.count) });
      row.createEl("td", { text: item.references.join(", ") || "-" });
      row.createEl("td", { text: item.orphan ? "孤立" : "正常" });
    }
    if (orphan.length) {
      const clean = container.createEl("button", { text: "清理孤立附件" });
      clean.addEventListener("click", () => void this.cleanupOrphans(orphan));
    }
  }

  private async cleanupOrphans(orphan: ReferenceInfo[]): Promise<void> {
    if (!window.confirm(`确定删除 ${orphan.length} 个本地孤立附件吗？S3 对象不会删除。`)) return;
    for (const item of orphan) await this.app.vault.adapter.remove(item.path);
    const manifest = await readManifest(createVaultAdapter(this.app.vault.adapter));
    for (const item of orphan) delete manifest.files[item.path];
    const adapter = createVaultAdapter(this.app.vault.adapter);
    const { writeManifest } = await import("./manifest");
    await writeManifest(adapter, manifest);
    new Notice("孤立附件已清理（S3 对象保留）");
    await this.render();
  }
}

type TeamCorePluginHost = Plugin & {
  teamCoreSettings: TeamCoreSettings;
  coordinator: SyncCoordinator;
  saveSettings(): Promise<void>;
  checkForPluginUpdate(manual?: boolean): Promise<void>;
};

export class TeamCoreSettingTab extends PluginSettingTab {
  private readonly teamCorePlugin: TeamCorePluginHost;

  constructor(app: App, plugin: TeamCorePluginHost) {
    super(app, plugin);
    this.teamCorePlugin = plugin;
  }

  private get teamPlugin(): TeamCorePluginHost { return this.teamCorePlugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("team-core-settings");
    new Setting(containerEl).setName("Git").setHeading();
    this.text("Git 远端 URL", "gitUrl", false);
    this.text("个人 username", "gitUsername", false);
    this.text("团队密码", "gitPassword", true);
    new Setting(containerEl).setName("七牛 S3").setHeading();
    for (const [name, key, secret] of [["Endpoint", "s3Endpoint", false], ["Region", "s3Region", false], ["Bucket / Space", "s3Bucket", false], ["Prefix", "s3Prefix", false], ["Access Key", "s3AccessKey", true], ["Secret Key", "s3SecretKey", true]] as const) this.text(name, key, secret);
    new Setting(containerEl).setName("同步").setHeading();
    this.number("保存消抖（分钟）", "debounceMs", 60_000);
    this.number("自动同步（分钟）", "syncIntervalMs", 300_000);
    new Setting(containerEl).setName("插件更新").setHeading();
    new Setting(containerEl)
      .setName(`当前版本 ${this.teamPlugin.manifest.version}`)
      .setDesc("发现新版本后请通过 Obsidian 社区插件功能更新")
      .addButton((button) => button.setButtonText("检查更新").onClick(() => void this.teamPlugin.checkForPluginUpdate(true)));
    new Setting(containerEl).setName("快速导入 / 导出").setHeading();
    const transfer = new Setting(containerEl).setName("配置字符串").setClass("team-core-config-transfer");
    const configInput = transfer.controlEl.createEl("input", { type: "text", placeholder: "粘贴配置字符串", cls: "team-core-config-input" });
    configInput.setAttr("aria-label", "配置字符串");
    const importButton = transfer.controlEl.createEl("button", { text: "导入配置", cls: "team-core-config-action" });
    importButton.type = "button";
    importButton.addEventListener("click", () => {
      try {
        this.teamPlugin.teamCoreSettings = importSettings(configInput.value, this.teamPlugin.teamCoreSettings);
        void this.teamPlugin.saveSettings().then(() => { new Notice("配置已导入"); this.display(); });
      } catch (error) { new Notice(error instanceof Error ? error.message : "配置导入失败"); }
    });
    const exportButton = transfer.controlEl.createEl("button", { text: "复制导出字符串", cls: "team-core-config-action" });
    exportButton.type = "button";
    exportButton.addEventListener("click", () => void navigator.clipboard.writeText(exportSettings(this.teamPlugin.teamCoreSettings)).then(() => new Notice("配置字符串已复制")));
  }

  private text(name: string, key: keyof TeamCoreSettings, secret: boolean): void {
    new Setting(this.containerEl).setName(name).addText((component) => {
      component.setValue(String(this.teamPlugin.teamCoreSettings[key] ?? ""));
      component.inputEl.type = secret ? "password" : "text";
      component.onChange(async (value) => {
        (this.teamPlugin.teamCoreSettings[key] as string) = value;
        await this.teamPlugin.saveSettings();
      });
    });
  }

  private number(name: string, key: "debounceMs" | "syncIntervalMs", defaultMs: number): void {
    new Setting(this.containerEl).setName(name).addText((component) => {
      component.setValue(String(Math.round(this.teamPlugin.teamCoreSettings[key] / 60_000) || defaultMs / 60_000));
      component.inputEl.type = "number";
      component.onChange(async (value) => {
        const minutes = Number(value);
        if (Number.isFinite(minutes) && minutes > 0) {
          this.teamPlugin.teamCoreSettings[key] = minutes * 60_000;
          await this.teamPlugin.saveSettings();
        }
      });
    });
  }
}

function consoleLogger() {
  return { debug: () => {}, warn: (message: string, details?: unknown) => console.warn(message, details), error: (message: string, details?: unknown) => console.error(message, details) };
}
