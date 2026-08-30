import { ButtonComponent, ItemView, Modal, Notice, PluginSettingTab, Setting, TFile, WorkspaceLeaf, setIcon, setTooltip, type App, type Plugin, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { exportSettings, importSettings } from "./config";
import { readManifest } from "./manifest";
import { GitRepository } from "./git";
import type { CommitSummary, ReferenceInfo, TeamCoreSettings } from "./types";
import { buildReferenceAudit, createVaultAdapter } from "./vault";
import type { SyncCoordinator } from "./sync";
import { listLocalCommunityPlugins, readSharedPluginIds } from "./shared-plugins";
import { requestConfirmation } from "./confirm";
import { createEmptyFileAuthorRegistry, listAuthorableMarkdownFiles, type FileAuthorRegistry, type FileAuthorService } from "./file-authors";

export const HISTORY_VIEW_TYPE = "team-core-history";

export class TeamCoreHistoryView extends ItemView {
  private renderRevision = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => TeamCoreSettings,
    private readonly getSync: () => SyncCoordinator,
    private readonly getAuthorService: () => FileAuthorService
  ) {
    super(leaf);
  }

  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "团队知识库历史"; }
  getIcon(): string { return "git-commit-horizontal"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const renderRevision = ++this.renderRevision;
    const viewport = this.containerEl.children[1] as HTMLElement;
    viewport.empty();
    viewport.addClass("team-core-history-view");
    const container = viewport.createDiv("team-core-history-content");
    container.createEl("h2", { text: "知识库历史" });
    const toolbar = container.createDiv("team-core-toolbar");
    const syncButton = toolbar.createEl("button", { text: "立即同步" });
    syncButton.addEventListener("click", () => void this.getSync().runManual().then(() => this.render()));
    const auditButton = toolbar.createEl("button", { text: "附件审计" });
    auditButton.addEventListener("click", () => void this.renderAudit(container));
    const settings = this.getSettings();
    if (!settings.gitUrl) {
      container.createEl("p", { text: "请先在插件设置中配置 Git 和 S3。" });
      return;
    }
    const repo = new GitRepository(createVaultAdapter(this.app.vault.adapter), settings, consoleLogger(), this.app.vault.configDir);
    const authorService = this.getAuthorService();
    let commits: CommitSummary[] = [];
    try { commits = await repo.log(undefined, 200); } catch (error) { container.createEl("p", { text: `历史暂不可用：${String(error)}` }); return; }
    let authorRegistry = createEmptyFileAuthorRegistry();
    try {
      authorRegistry = await authorService.getRegistry();
    } catch (error) {
      container.createEl("p", { text: `文件作者归属表不可用：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
    }
    const markdownFiles = listAuthorableMarkdownFiles(this.app.vault);
    const counts = this.counts(commits);
    const summary = container.createDiv("team-core-summary-grid");
    for (const [label, value] of [["近一周", counts.week], ["近一月", counts.month], ["近一年", counts.year]]) {
      const card = summary.createDiv("team-core-stat");
      card.createEl("strong", { text: String(value) });
      card.createSpan({ text: String(label) });
    }
    void this.renderContributionWall(container, repo, commits, renderRevision);
    this.renderAuthorAssignments(container, authorRegistry, authorService);
    const authorSection = container.createDiv("team-core-section");
    authorSection.createEl("h3", { text: "文档作者分布" });
    void this.renderDocumentAuthorChart(authorSection, authorService, markdownFiles, renderRevision);
    const timeline = container.createDiv("team-core-section");
    const timelineHeader = timeline.createDiv("team-core-history-list-header");
    timelineHeader.createEl("h3", { text: "提交历史" });
    const filter = timeline.createDiv("team-core-history-filter");
    const input = filter.createEl("input", { type: "search", placeholder: "按文件路径筛选，例如 notes/readme.md" });
    input.setAttr("list", "team-core-history-file-list");
    const datalist = filter.createEl("datalist", { attr: { id: "team-core-history-file-list" } });
    for (const file of markdownFiles) datalist.createEl("option", { attr: { value: file.path } });
    const searchButton = filter.createEl("button", { attr: { "aria-label": "搜索文件提交历史", title: "搜索文件提交历史" } });
    setIcon(searchButton, "search");
    const clearButton = filter.createEl("button", { attr: { "aria-label": "清除文件筛选", title: "清除文件筛选" } });
    setIcon(clearButton, "x");
    const results = timeline.createDiv("team-core-history-results");
    let requestId = 0;
    const renderResults = async (): Promise<void> => {
      const query = input.value.trim();
      const currentRequest = ++requestId;
      results.empty();
      results.createEl("p", { text: query ? "正在查询提交历史…" : "正在加载提交历史…", cls: "team-core-history-loading" });
      try {
        let filepath = query;
        if (query && !query.includes("/")) {
          const normalized = query.toLocaleLowerCase();
          const matches = markdownFiles.filter((file) => file.basename.toLocaleLowerCase() === normalized || file.name.toLocaleLowerCase() === normalized);
          if (matches.length > 1) throw new Error(`存在 ${matches.length} 个同名文件，请从候选项中选择完整路径`);
          if (matches.length === 1) {
            filepath = matches[0].path;
            input.value = filepath;
          }
        }
        const filtered = filepath ? await repo.log(filepath, 200) : commits;
        if (currentRequest !== requestId) return;
        results.empty();
        if (filepath) results.createEl("p", { text: filtered.length ? `${filepath} · ${filtered.length} 次提交` : `${filepath} · 暂无提交记录`, cls: "team-core-history-filter-result" });
        this.renderCommitList(results, filtered);
      } catch (error) {
        if (currentRequest !== requestId) return;
        results.empty();
        results.createEl("p", { text: `查询失败：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
      }
    };
    searchButton.addEventListener("click", () => void renderResults());
    clearButton.addEventListener("click", () => { input.value = ""; void renderResults(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") void renderResults(); });
    this.renderCommitList(results, commits);
  }

  private renderAuthorAssignments(container: HTMLElement, registry: FileAuthorRegistry, authorService: FileAuthorService): void {
    const section = container.createDiv("team-core-author-assignments");
    const text = section.createDiv("team-core-author-assignments-text");
    text.createEl("h3", { text: "文件作者归属" });
    const count = Object.keys(registry.files).length;
    text.createSpan({ text: count ? `已人工设置 ${count} 个文件；其他文件使用 Git 历史作者` : "尚未人工设置；所有文件使用 Git 历史作者" });
    const button = section.createEl("button");
    setIcon(button, "users");
    button.appendText("管理文件作者");
    button.addEventListener("click", () => new FileAuthorManagerModal(this.app, authorService, () => void this.render()).open());
  }

  private async renderDocumentAuthorChart(
    container: HTMLElement,
    authorService: FileAuthorService,
    files: readonly TFile[],
    renderRevision: number
  ): Promise<void> {
    const chart = container.createDiv("team-core-author-chart");
    const loading = chart.createEl("p", {
      text: files.length ? `正在统计文档作者 0/${files.length}` : "正在统计文档作者",
      cls: "team-core-history-loading"
    });
    try {
      const authors = await authorService.getDocumentAuthorCounts(files.map((file) => file.path), ({ current, total }) => {
        if (this.renderRevision === renderRevision && (current === total || current % 10 === 0)) {
          loading.setText(`正在统计文档作者 ${current}/${total}`);
        }
      });
      if (this.renderRevision !== renderRevision) return;
      chart.empty();
      const sortedAuthors = [...authors.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
      if (!sortedAuthors.length) {
        chart.createEl("p", { text: "暂无文档作者记录", cls: "team-core-history-empty" });
        return;
      }
      const maxDocuments = sortedAuthors[0]?.[1] ?? 0;
      for (const [author, count] of sortedAuthors) {
        const row = chart.createDiv("team-core-author-row");
        row.createSpan({ text: author, cls: "team-core-author-name" });
        const track = row.createDiv("team-core-author-track");
        const bar = track.createDiv("team-core-author-bar");
        bar.style.width = `${maxDocuments > 0 ? Math.max(3, count / maxDocuments * 100) : 0}%`;
        row.createSpan({ text: `${count} 篇`, cls: "team-core-author-count" });
        row.setAttr("aria-label", `${author}：${count} 篇文档`);
      }
    } catch (error) {
      if (this.renderRevision !== renderRevision) return;
      chart.empty();
      chart.createEl("p", { text: `作者统计失败：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
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

  private async renderContributionWall(container: HTMLElement, repo: GitRepository, recentCommits: CommitSummary[], renderRevision: number): Promise<void> {
    const weeks = 53;
    const end = new Date();
    const endKey = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - (weeks * 7 - 1));
    start.setDate(start.getDate() - start.getDay());
    const startKey = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const wall = container.createDiv("team-core-contribution-wall");
    wall.createEl("p", { text: "正在加载近一年提交活动…", cls: "team-core-history-loading" });
    let commits = recentCommits;
    try {
      commits = await repo.logSince(startKey, undefined);
    } catch (error) {
      if (this.renderRevision !== renderRevision) return;
      wall.empty();
      const fallback = wall.createDiv("team-core-history-error");
      fallback.setText(`提交活动统计失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.renderRevision !== renderRevision) return;
    const counts = new Map<number, number>();
    for (const commit of commits) {
      const date = new Date(commit.timestamp);
      const key = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
      if (key < startKey || key > endKey) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const peak = Math.max(0, ...counts.values());
    wall.empty();
    const wallHeader = wall.createDiv("team-core-contribution-header");
    const title = wallHeader.createDiv("team-core-contribution-title");
    title.createEl("h3", { text: "提交活动" });
    title.createSpan({ text: `${[...counts.values()].reduce((sum, value) => sum + value, 0)} 次提交 · 近一年`, cls: "team-core-contribution-total" });
    const legend = wallHeader.createDiv("team-core-contribution-legend");
    legend.createSpan({ text: "少" });
    for (let level = 0; level <= 4; level++) legend.createSpan(`team-core-contribution-cell is-level-${level}`);
    legend.createSpan({ text: "多" });

    const scroller = wall.createDiv("team-core-contribution-scroller");
    const monthLabels = scroller.createDiv("team-core-contribution-months");
    let previousMonth = -1;
    for (let week = 0; week < weeks; week++) {
      const date = new Date(start);
      date.setDate(start.getDate() + week * 7);
      if (date.getMonth() === previousMonth) continue;
      previousMonth = date.getMonth();
      const label = monthLabels.createSpan({ text: `${date.getMonth() + 1}月` });
      label.style.gridColumn = String(week + 1);
    }
    const grid = scroller.createDiv("team-core-contribution-grid");
    for (let week = 0; week < weeks; week++) {
      for (let day = 0; day < 7; day++) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + day);
        const key = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
        const count = counts.get(key) ?? 0;
        const level = count === 0 || peak === 0 ? 0 : Math.min(4, Math.ceil((count / peak) * 4));
        const cell = grid.createSpan(`team-core-contribution-cell is-level-${level}`);
        const description = `${date.getMonth() + 1}月${date.getDate()}日有${count}个提交`;
        cell.setAttr("aria-label", description);
        setTooltip(cell, description, { placement: "top" });
      }
    }
  }

  private renderCommitList(container: HTMLElement, commits: CommitSummary[]): void {
    if (!commits.length) {
      container.createEl("p", { text: "暂无提交历史", cls: "team-core-history-empty" });
      return;
    }
    const wrapper = container.createDiv("team-core-commit-table-wrap");
    const table = wrapper.createEl("table", { cls: "team-core-commit-table" });
    const head = table.createEl("thead");
    const headRow = head.createEl("tr");
    for (const label of ["提交说明", "作者", "提交时间", "哈希", "类型"]) headRow.createEl("th", { text: label });
    const body = table.createEl("tbody");
    for (const [index, commit] of commits.entries()) {
      const row = body.createEl("tr");
      const message = row.createEl("td", { cls: "team-core-commit-message" });
      message.createSpan({ text: commit.message || "无提交说明" });
      if (index === 0) message.createSpan({ text: "最新", cls: "team-core-commit-latest" });
      row.createEl("td", { text: commit.author, cls: "team-core-commit-author" });
      row.createEl("td", { text: new Date(commit.timestamp).toLocaleString(), cls: "team-core-commit-date" });
      row.createEl("td", { text: commit.shortOid, cls: "team-core-commit-oid" });
      const type = row.createEl("td");
      if (commit.parents.length > 1) type.createSpan({ text: "合并", cls: "team-core-commit-merge" });
      else type.createSpan({ text: "普通", cls: "team-core-commit-type" });
    }
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
    if (!await requestConfirmation(this.app, {
      title: "清理孤立附件",
      message: `确定删除 ${orphan.length} 个本地孤立附件吗？S3 对象不会删除。`,
      confirmText: "删除附件",
      destructive: true
    })) return;
    for (const item of orphan) {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) await this.app.fileManager.trashFile(file);
    }
    const manifest = await readManifest(createVaultAdapter(this.app.vault.adapter));
    for (const item of orphan) delete manifest.files[item.path];
    const adapter = createVaultAdapter(this.app.vault.adapter);
    const { writeManifest } = await import("./manifest");
    await writeManifest(adapter, manifest);
    new Notice("孤立附件已清理（S3 对象保留）");
    await this.render();
  }
}

class FileAuthorManagerModal extends Modal {
  private readonly selected = new Set<string>();
  private registry = createEmptyFileAuthorRegistry();
  private files: TFile[] = [];
  private query = "";

  constructor(app: App, private readonly authorService: FileAuthorService, private readonly onChanged?: () => void) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("team-core-file-authors-modal");
    this.setTitle("管理文件作者");
    this.files = listAuthorableMarkdownFiles(this.app.vault);
    try {
      this.registry = await this.authorService.getRegistry();
      this.renderContent();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: `无法读取文件作者归属：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
    }
  }

  private renderContent(): void {
    const container = this.contentEl;
    container.empty();
    container.createEl("p", { text: "人工归属优先于 Git 历史；清除人工归属后将自动恢复 Git 历史作者。", cls: "team-core-file-authors-intro" });
    const controls = container.createDiv("team-core-file-authors-controls");
    const search = controls.createEl("input", { type: "search", placeholder: "搜索文件路径" });
    search.value = this.query;
    const selectVisible = controls.createEl("button", { text: "全选结果" });
    const clearSelection = controls.createEl("button", { text: "取消选择" });
    const selectedStatus = container.createDiv("team-core-file-authors-selected");
    const list = container.createDiv("team-core-file-authors-list");

    const visibleFiles = (): TFile[] => {
      const query = this.query.trim().toLocaleLowerCase();
      return query ? this.files.filter((file) => file.path.toLocaleLowerCase().includes(query)) : this.files;
    };
    const renderList = (): void => {
      selectedStatus.setText(`已选择 ${this.selected.size} 个文件`);
      list.empty();
      const visible = visibleFiles();
      if (!visible.length) {
        list.createEl("p", { text: "没有匹配的文件", cls: "team-core-history-empty" });
        return;
      }
      for (const file of visible) {
        const label = list.createEl("label", { cls: "team-core-file-author-item" });
        const checkbox = label.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selected.has(file.path);
        const detail = label.createDiv("team-core-file-author-detail");
        detail.createSpan({ text: file.path, cls: "team-core-file-author-path" });
        const assigned = this.registry.files[file.path];
        detail.createSpan({ text: assigned ? assigned.join(", ") : "使用 Git 历史", cls: assigned ? "team-core-file-author-assigned" : "team-core-file-author-fallback" });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selected.add(file.path);
          else this.selected.delete(file.path);
          selectedStatus.setText(`已选择 ${this.selected.size} 个文件`);
        });
      }
    };
    search.addEventListener("input", () => { this.query = search.value; renderList(); });
    selectVisible.addEventListener("click", () => { for (const file of visibleFiles()) this.selected.add(file.path); renderList(); });
    clearSelection.addEventListener("click", () => { this.selected.clear(); renderList(); });
    renderList();

    const editor = container.createDiv("team-core-file-authors-editor");
    const authorInput = editor.createEl("input", { type: "text", placeholder: "作者姓名，多个作者使用逗号分隔" });
    const actions = editor.createDiv("team-core-file-authors-actions");
    const clearButton = actions.createEl("button", { text: "恢复 Git 历史" });
    const saveButton = actions.createEl("button", { text: "设置作者", cls: "mod-cta" });
    const save = async (clear: boolean): Promise<void> => {
      const paths = [...this.selected];
      if (!paths.length) {
        new Notice("请至少选择一个文件");
        return;
      }
      const authors = authorInput.value.split(/[,，\n]+/).map((author) => author.trim()).filter(Boolean);
      if (!clear && !authors.length) {
        new Notice("请输入至少一个作者姓名");
        return;
      }
      saveButton.disabled = true;
      clearButton.disabled = true;
      try {
        this.registry = clear
          ? await this.authorService.clearAuthors(paths)
          : await this.authorService.setAuthors(paths, authors);
        this.onChanged?.();
        new Notice(clear ? `已恢复 ${paths.length} 个文件的 Git 历史作者` : `已设置 ${paths.length} 个文件的作者`);
        renderList();
      } catch (error) {
        new Notice(`保存文件作者失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        saveButton.disabled = false;
        clearButton.disabled = false;
      }
    };
    clearButton.addEventListener("click", () => void save(true));
    saveButton.addEventListener("click", () => void save(false));
  }
}

type TeamCorePluginHost = Plugin & {
  teamCoreSettings: TeamCoreSettings;
  coordinator: SyncCoordinator;
  saveSettings(): Promise<void>;
  confirmRemoteOverwrite(): Promise<void>;
};

export class TeamCoreSettingTab extends PluginSettingTab {
  private readonly teamCorePlugin: TeamCorePluginHost;

  constructor(app: App, plugin: TeamCorePluginHost) {
    super(app, plugin);
    this.teamCorePlugin = plugin;
  }

  private get teamPlugin(): TeamCorePluginHost { return this.teamCorePlugin; }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      this.group("Git", [
        this.textDefinition("Git 远端 URL", "gitUrl", false),
        this.textDefinition("个人 username", "gitUsername", false),
        this.textDefinition("团队密码", "gitPassword", true)
      ]),
      this.group("七牛 S3", [
        this.textDefinition("Endpoint", "s3Endpoint", false),
        this.textDefinition("Region", "s3Region", false),
        this.textDefinition("Bucket / Space", "s3Bucket", false),
        this.textDefinition("Prefix", "s3Prefix", false),
        this.textDefinition("Access Key", "s3AccessKey", true),
        this.textDefinition("Secret Key", "s3SecretKey", true)
      ]),
      this.group("同步", [
        this.toggleDefinition("启用自动同步", "autoSync"),
        this.numberDefinition("保存消抖（分钟）", "debounceMs", 60_000),
        this.numberDefinition("自动同步（分钟）", "syncIntervalMs", 300_000),
        this.remoteOverwriteDefinition()
      ]),
      this.group("团队公共插件", [this.sharedPluginsDefinition()]),
      this.group("快速导入 / 导出", [this.transferDefinition()])
    ];
  }

  display(): void {
    this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("team-core-settings");
    new Setting(containerEl).setName("Git").setHeading();
    this.addTextControl(new Setting(containerEl).setName("Git 远端 URL"), "gitUrl", false);
    this.addTextControl(new Setting(containerEl).setName("个人 username"), "gitUsername", false);
    this.addTextControl(new Setting(containerEl).setName("团队密码"), "gitPassword", true);
    new Setting(containerEl).setName("七牛 S3").setHeading();
    for (const [name, key, secret] of [["Endpoint", "s3Endpoint", false], ["Region", "s3Region", false], ["Bucket / Space", "s3Bucket", false], ["Prefix", "s3Prefix", false], ["Access Key", "s3AccessKey", true], ["Secret Key", "s3SecretKey", true]] as const) {
      this.addTextControl(new Setting(containerEl).setName(name), key, secret);
    }
    new Setting(containerEl).setName("同步").setHeading();
    this.addToggleControl(new Setting(containerEl).setName("启用自动同步").setDesc("关闭后不会因保存或定时器自动同步，只能通过“立即同步”手动执行。"), "autoSync");
    this.addNumberControl(new Setting(containerEl).setName("保存消抖（分钟）"), "debounceMs", 60_000);
    this.addNumberControl(new Setting(containerEl).setName("自动同步（分钟）"), "syncIntervalMs", 300_000);
    this.addRemoteOverwriteEntry(new Setting(containerEl).setName("重置本地并重新同步"));
    new Setting(containerEl).setName("团队公共插件").setHeading();
    this.addSharedPluginsEntry(new Setting(containerEl).setName("公共插件管理"));
    new Setting(containerEl).setName("快速导入 / 导出").setHeading();
    this.addTransferControl(new Setting(containerEl).setName("配置字符串"));
  }

  private group(heading: string, items: SettingDefinition[]): SettingDefinitionItem {
    return { type: "group", heading, cls: "team-core-settings", items };
  }

  private textDefinition(name: string, key: keyof TeamCoreSettings, secret: boolean): SettingDefinition {
    return { name, aliases: [String(key)], render: (setting) => this.addTextControl(setting, key, secret) };
  }

  private numberDefinition(name: string, key: "debounceMs" | "syncIntervalMs", defaultMs: number): SettingDefinition {
    return { name, aliases: [String(key)], render: (setting) => this.addNumberControl(setting, key, defaultMs) };
  }

  private toggleDefinition(name: string, key: "autoSync"): SettingDefinition {
    return {
      name,
      desc: "关闭后不会因保存或定时器自动同步，只能通过“立即同步”手动执行。",
      aliases: [String(key)],
      render: (setting) => this.addToggleControl(setting, key)
    };
  }

  private remoteOverwriteDefinition(): SettingDefinition {
    return {
      name: "重置本地并重新同步",
      desc: "保留远端，清空本地公共知识库和 Git 元数据，再从远端完整下载。",
      aliases: ["清空本地", "覆盖导入", "强制导入", "重新同步整个仓库"],
      render: (setting) => this.addRemoteOverwriteEntry(setting)
    };
  }

  private addRemoteOverwriteEntry(setting: Setting): void {
    setting.setDesc("远端 Git 与 S3 保持不变；清空本地公共知识库和 Git 元数据后，从远端完整下载。请先备份。");
    setting.addButton((button) => {
      button.setIcon("refresh-cw").setTooltip("重置本地并重新同步");
      button.buttonEl.appendText("清空并重新同步");
      button.buttonEl.addClass("team-core-destructive-button");
      button.onClick(() => void this.teamPlugin.confirmRemoteOverwrite());
    });
  }

  private sharedPluginsDefinition(): SettingDefinition {
    return {
      name: "公共插件管理",
      desc: "仅供负责维护团队插件配置的核心成员使用。",
      aliases: ["团队插件", "共享插件", "插件同步", "gitignore"],
      render: (setting) => this.addSharedPluginsEntry(setting)
    };
  }

  private transferDefinition(): SettingDefinition {
    return {
      name: "配置字符串",
      aliases: ["导入配置", "导出配置"],
      render: (setting) => this.addTransferControl(setting)
    };
  }

  private addSharedPluginsEntry(setting: Setting): void {
    setting.setDesc("仅供负责维护团队插件配置的核心成员使用。");
    setting.addButton((button) => {
      button
        .setIcon("settings-2")
        .setTooltip("进入公共插件管理")
        .onClick(() => void this.openSharedPluginManager());
      button.buttonEl.appendText("管理公共插件");
    });
  }

  private async openSharedPluginManager(): Promise<void> {
    const confirmed = await requestConfirmation(this.app, {
      title: "进入公共插件管理",
      message: "这里的更改会修改团队公共插件配置，并在同步后影响所有成员。只有确认自己正在维护团队配置时才应继续。",
      confirmText: "进入管理",
      destructive: true
    });
    if (!confirmed) return;
    new SharedPluginsModal(this.app, (container) => this.renderSharedPlugins(container)).open();
  }

  private addTransferControl(transfer: Setting): void {
    transfer.setClass("team-core-config-transfer");
    const configInput = transfer.controlEl.createEl("input", { type: "text", placeholder: "粘贴配置字符串", cls: "team-core-config-input" });
    configInput.setAttr("aria-label", "配置字符串");
    const importButton = transfer.controlEl.createEl("button", { text: "导入配置", cls: "team-core-config-action" });
    importButton.type = "button";
    importButton.addEventListener("click", () => {
      try {
        this.teamPlugin.teamCoreSettings = importSettings(configInput.value, this.teamPlugin.teamCoreSettings);
        void this.teamPlugin.saveSettings().then(() => { new Notice("配置已导入"); this.refreshSettings(); });
      } catch (error) { new Notice(error instanceof Error ? error.message : "配置导入失败"); }
    });
    const exportButton = transfer.controlEl.createEl("button", { text: "复制导出字符串", cls: "team-core-config-action" });
    exportButton.type = "button";
    exportButton.addEventListener("click", () => void navigator.clipboard.writeText(exportSettings(this.teamPlugin.teamCoreSettings)).then(() => new Notice("配置字符串已复制")));
  }

  private refreshSettings(): void {
    const update = (this as { update?: () => void }).update;
    if (typeof update === "function") update.call(this);
    else this.renderLegacySettings();
  }

  private async renderSharedPlugins(container: HTMLElement): Promise<void> {
    try {
      const vault = createVaultAdapter(this.app.vault.adapter);
      const [localPlugins, selected] = await Promise.all([
        listLocalCommunityPlugins(vault, this.app.vault.configDir),
        readSharedPluginIds(vault, this.app.vault.configDir)
      ]);
      const pluginsById = new Map(localPlugins.map((plugin) => [plugin.id, plugin]));
      for (const id of selected) if (!pluginsById.has(id)) pluginsById.set(id, { id, name: id });
      const plugins = [...pluginsById.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      container.empty();
      if (!plugins.length) {
        container.createEl("p", { text: "尚未发现其他已安装插件。安装插件后重新打开此设置页即可选择。", cls: "team-core-shared-plugins-empty" });
        return;
      }
      const selectedSet = new Set(selected);
      for (const plugin of plugins) {
        const local = localPlugins.some(({ id }) => id === plugin.id);
        const detail = plugin.version ? `${plugin.id} · v${plugin.version}` : local ? plugin.id : `${plugin.id} · 文件尚未同步到本机`;
        new Setting(container)
          .setName(plugin.name)
          .setDesc(detail)
          .addToggle((toggle) => {
            toggle.setValue(selectedSet.has(plugin.id));
            toggle.setTooltip(`共享 ${plugin.name}`);
            toggle.onChange(async (enabled) => {
              toggle.setDisabled(true);
              try {
                if (enabled) selectedSet.add(plugin.id);
                else selectedSet.delete(plugin.id);
                await this.teamPlugin.coordinator.setSharedPluginIds([...selectedSet]);
                new Notice(enabled ? `已将 ${plugin.name} 加入团队共享` : `已将 ${plugin.name} 保留为本地插件`);
              } catch (error) {
                toggle.setValue(!enabled);
                new Notice(`共享插件设置失败：${error instanceof Error ? error.message : String(error)}`, 10_000);
              } finally {
                toggle.setDisabled(false);
              }
            });
          });
      }
    } catch (error) {
      container.empty();
      container.createEl("p", { text: `无法读取共享插件白名单：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-shared-plugins-error" });
    }
  }

  private addTextControl(setting: Setting, key: keyof TeamCoreSettings, secret: boolean): void {
    setting.addText((component) => {
      component.setValue(String(this.teamPlugin.teamCoreSettings[key] ?? ""));
      component.inputEl.type = secret ? "password" : "text";
      component.onChange(async (value) => {
        (this.teamPlugin.teamCoreSettings[key] as string) = value;
        await this.teamPlugin.saveSettings();
      });
    });
  }

  private addNumberControl(setting: Setting, key: "debounceMs" | "syncIntervalMs", defaultMs: number): void {
    setting.addText((component) => {
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

  private addToggleControl(setting: Setting, key: "autoSync"): void {
    setting.addToggle((component) => {
      component.setValue(this.teamPlugin.teamCoreSettings[key]);
      component.onChange(async (value) => {
        this.teamPlugin.teamCoreSettings[key] = value;
        await this.teamPlugin.saveSettings();
      });
    });
  }
}

class SharedPluginsModal extends Modal {
  constructor(app: App, private readonly renderPlugins: (container: HTMLElement) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("team-core-shared-plugins-modal");
    this.titleEl.setText("公共插件管理");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "启用后会同步该插件目录中的全部文件，包括 main.js、配置和样式。关闭后插件仍保留在本机。",
      cls: "team-core-shared-plugins-intro"
    });
    const warning = this.contentEl.createEl("p", {
      text: "公共插件包含可执行 JavaScript，远端版本会替换其他成员的本地版本。",
      cls: "team-core-shared-plugins-warning"
    });
    warning.setAttr("role", "note");
    const list = this.contentEl.createDiv("team-core-shared-plugins-list");
    list.createEl("p", { text: "正在读取本地插件……", cls: "team-core-shared-plugins-loading" });
    void this.renderPlugins(list);
    const footer = this.contentEl.createDiv("team-core-shared-plugins-footer");
    new ButtonComponent(footer).setButtonText("完成").setCta().onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function consoleLogger() {
  return { debug: () => {}, warn: (message: string, details?: unknown) => console.warn(message, details), error: (message: string, details?: unknown) => console.error(message, details) };
}
