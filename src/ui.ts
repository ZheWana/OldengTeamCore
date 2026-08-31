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
import { AuthorDisplayService, parseAuthorDisplayMappings, type AuthorDisplayMappings } from "./author-display";

export const DASHBOARD_VIEW_TYPE = "team-core-history";
export const COMMIT_HISTORY_VIEW_TYPE = "team-core-commit-history";

export class TeamCoreDashboardView extends ItemView {
  private renderRevision = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => TeamCoreSettings,
    private readonly getAuthorService: () => FileAuthorService,
    private readonly getAuthorDisplay: () => AuthorDisplayService
  ) {
    super(leaf);
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return "团队看板"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const renderRevision = ++this.renderRevision;
    const viewport = this.containerEl.children[1] as HTMLElement;
    viewport.empty();
    viewport.addClass("team-core-history-view");
    const container = viewport.createDiv("team-core-history-content");
    container.createEl("h2", { text: "团队看板" });
    const toolbar = container.createDiv("team-core-toolbar");
    const historyButton = toolbar.createEl("button", { text: "提交历史" });
    historyButton.addEventListener("click", () => void this.openCommitHistory());
    const auditButton = toolbar.createEl("button", { text: "附件审计" });
    auditButton.addEventListener("click", () => void this.renderAudit(container));
    const settings = this.getSettings();
    if (!settings.gitUrl) {
      container.createEl("p", { text: "请先在插件设置中配置 Git 和 S3。" });
      return;
    }
    const repo = new GitRepository(createVaultAdapter(this.app.vault.adapter), settings, consoleLogger(), this.app.vault.configDir);
    const authorService = this.getAuthorService();
    let authorRegistry = createEmptyFileAuthorRegistry();
    try {
      authorRegistry = await authorService.getRegistry();
    } catch (error) {
      container.createEl("p", { text: `文件作者归属表不可用：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
    }
    const markdownFiles = listAuthorableMarkdownFiles(this.app.vault);
    const summary = container.createDiv("team-core-summary-grid");
    const summaryValues: HTMLElement[] = [];
    for (const label of ["近一周", "近一月", "近一年"]) {
      const card = summary.createDiv("team-core-stat");
      summaryValues.push(card.createEl("strong", { text: "…" }));
      card.createSpan({ text: label });
    }
    void this.renderContributionWall(container, repo, renderRevision, summaryValues);
    this.renderAuthorAssignments(container, authorRegistry, authorService);
    const authorSection = container.createDiv("team-core-section");
    authorSection.createEl("h3", { text: "文档作者分布" });
    void this.renderDocumentAuthorChart(authorSection, authorService, markdownFiles, renderRevision);
    this.renderWeeklyUpdates(container, markdownFiles);
  }

  private async openCommitHistory(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: COMMIT_HISTORY_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private renderWeeklyUpdates(container: HTMLElement, files: readonly TFile[]): void {
    const section = container.createDiv("team-core-section team-core-weekly-updates");
    const header = section.createDiv("team-core-history-list-header");
    header.createEl("h3", { text: "本周最新更新" });
    const headerActions = header.createDiv("team-core-weekly-header-actions");
    const refresh = headerActions.createEl("button", { cls: "team-core-weekly-refresh", attr: { "aria-label": "刷新本周更新", title: "刷新本周更新" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.render());
    const weekStart = Date.now() - 6 * 86_400_000;
    const updated = [...files]
      .filter((file) => file.stat.mtime >= weekStart || file.basename.includes("置顶-"))
      .sort((left, right) => {
        const leftPinned = left.basename.includes("置顶-");
        const rightPinned = right.basename.includes("置顶-");
        return Number(rightPinned) - Number(leftPinned) || right.stat.mtime - left.stat.mtime || left.path.localeCompare(right.path);
      });
    headerActions.createSpan({ text: updated.length ? `${updated.length} 篇` : "本周暂无更新", cls: "team-core-weekly-count" });
    if (!updated.length) { section.createEl("p", { text: "本周还没有公共笔记更新。", cls: "team-core-history-empty" }); return; }
    const pageSize = 10;
    let page = 0;
    const viewport = section.closest(".team-core-history-view");
    const renderPage = (): void => {
      const scrollTop = viewport?.scrollTop ?? 0;
      const pageCount = Math.ceil(updated.length / pageSize);
      const pageItems = updated.slice(page * pageSize, (page + 1) * pageSize);
      section.querySelectorAll(".team-core-weekly-table-wrap, .team-core-pagination").forEach((element) => element.remove());
      const wrapper = section.createDiv("team-core-weekly-table-wrap");
      const table = wrapper.createEl("table", { cls: "team-core-weekly-table" });
      const head = table.createEl("thead").createEl("tr");
      for (const label of ["文章", "目录", "最近保存"]) head.createEl("th", { text: label });
      const body = table.createEl("tbody");
      for (const update of pageItems) {
        const row = body.createEl("tr", { attr: { title: update.path, tabindex: "0" } });
        row.addEventListener("click", () => void this.app.workspace.openLinkText(update.path, "", true));
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void this.app.workspace.openLinkText(update.path, "", true);
          }
        });
        const title = row.createEl("td", { cls: "team-core-weekly-title" });
        title.createSpan({ text: update.basename });
        if (update.basename.includes("置顶-")) title.createSpan({ text: "置顶", cls: "team-core-weekly-pinned" });
        row.createEl("td", { text: update.parent?.path || "根目录", cls: "team-core-weekly-path" });
        row.createEl("td", { text: new Date(update.stat.mtime).toLocaleString(), cls: "team-core-weekly-date" });
      }
      if (pageCount <= 1) return;
      const pagination = section.createDiv("team-core-pagination");
      const firstButton = pagination.createEl("button", { attr: { "aria-label": "跳转到首页", title: "跳转到首页" } });
      setIcon(firstButton, "chevrons-left");
      firstButton.disabled = page === 0;
      firstButton.addEventListener("click", () => { page = 0; renderPage(); });
      const previousButton = pagination.createEl("button", { attr: { "aria-label": "上一页", title: "上一页" } });
      setIcon(previousButton, "chevron-left");
      previousButton.disabled = page === 0;
      previousButton.addEventListener("click", () => { page -= 1; renderPage(); });
      pagination.createSpan({ text: `${page + 1} / ${pageCount}`, cls: "team-core-pagination-label" });
      const nextButton = pagination.createEl("button", { attr: { "aria-label": "下一页", title: "下一页" } });
      setIcon(nextButton, "chevron-right");
      nextButton.disabled = page >= pageCount - 1;
      nextButton.addEventListener("click", () => { page += 1; renderPage(); });
      if (viewport) window.requestAnimationFrame(() => { viewport.scrollTop = scrollTop; });
    };
    renderPage();
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
      const authors = await authorService.getDocumentAuthorCounts(files.map((file) => file.path), ({ current, total, path }) => {
        if (this.renderRevision === renderRevision && (current === total || current % 10 === 0)) {
          loading.setText(path === "Git 历史" ? `正在扫描 Git 历史 ${current}/${total}` : `正在统计文档作者 ${current}/${total}`);
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

  private async renderContributionWall(container: HTMLElement, repo: GitRepository, renderRevision: number, summaryValues: readonly HTMLElement[]): Promise<void> {
    const weeks = 53;
    const end = new Date();
    const endKey = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    // Anchor the grid to the current week's Sunday. The previous calculation
    // started 370 days back, which left the final two days outside 53 columns.
    const currentWeekStart = new Date(end);
    currentWeekStart.setHours(0, 0, 0, 0);
    currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay());
    const start = new Date(currentWeekStart);
    start.setDate(start.getDate() - (weeks - 1) * 7);
    const startKey = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const wall = container.createDiv("team-core-contribution-wall");
    wall.createEl("p", { text: "正在加载近一年提交活动…", cls: "team-core-history-loading" });
    let commits: CommitSummary[];
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
    const now = Date.now();
    const values = [
      commits.filter((commit) => now - commit.timestamp <= 7 * 86_400_000).length,
      commits.filter((commit) => now - commit.timestamp <= 30 * 86_400_000).length,
      commits.filter((commit) => now - commit.timestamp <= 365 * 86_400_000).length
    ];
    for (const [index, value] of values.entries()) summaryValues[index]?.setText(String(value));
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

  private async renderAudit(container: HTMLElement): Promise<void> {
    container.empty();
    const header = container.createDiv("team-core-audit-header");
    const heading = header.createDiv("team-core-audit-heading");
    heading.createEl("h2", { text: "附件审计" });
    heading.createSpan({ text: "检查公共附件是否仍被笔记引用" });
    const actions = header.createDiv("team-core-audit-actions");
    const back = actions.createEl("button", { text: "返回历史" });
    back.addEventListener("click", () => void this.render());
    const audit = await buildReferenceAudit(this.app.vault);
    const orphan = audit.filter((item) => item.orphan);
    if (orphan.length) {
      const clean = actions.createEl("button", { text: `清理 ${orphan.length} 个孤立附件`, cls: "team-core-audit-clean team-core-destructive-button" });
      setIcon(clean, "trash-2");
      clean.addEventListener("click", () => void this.cleanupOrphans(orphan));
    }
    const summary = container.createDiv("team-core-audit-summary");
    const total = summary.createDiv("team-core-audit-metric");
    total.createEl("strong", { text: String(audit.length) });
    total.createSpan({ text: "附件总数" });
    const orphanMetric = summary.createDiv(`team-core-audit-metric${orphan.length ? " is-warning" : ""}`);
    orphanMetric.createEl("strong", { text: String(orphan.length) });
    orphanMetric.createSpan({ text: "孤立附件" });
    summary.createSpan({ text: orphan.length ? "孤立附件已置顶，可确认后清理。" : "所有附件都至少被一篇笔记引用。", cls: "team-core-audit-summary-note" });

    const wrapper = container.createDiv("team-core-audit-table-wrap");
    const table = wrapper.createEl("table", { cls: "team-core-audit-table" });
    const tableHead = table.createEl("thead").createEl("tr");
    for (const label of ["状态", "引用笔记", "引用", "对象标识"]) tableHead.createEl("th", { text: label });
    const body = table.createEl("tbody");
    const ordered = [...audit].sort((left, right) => Number(right.orphan) - Number(left.orphan) || right.count - left.count || left.path.localeCompare(right.path));
    for (const item of ordered) {
      const row = body.createEl("tr");
      const status = row.createEl("td", { cls: "team-core-audit-status-cell" });
      status.createSpan({ text: item.orphan ? "孤立" : "已引用", cls: `team-core-audit-status${item.orphan ? " is-orphan" : ""}` });

      const references = row.createEl("td", { cls: "team-core-audit-references" });
      if (!item.references.length) {
        references.createSpan({ text: "未被笔记引用", cls: "team-core-audit-no-reference" });
      } else {
        for (const path of item.references.slice(0, 2)) {
          const note = references.createEl("button", { cls: "team-core-audit-note", attr: { title: path } });
          const slash = path.lastIndexOf("/");
          note.createSpan({ text: slash >= 0 ? path.slice(slash + 1) : path, cls: "team-core-audit-note-name" });
          if (slash >= 0) note.createSpan({ text: path.slice(0, slash), cls: "team-core-audit-note-folder" });
          note.addEventListener("click", () => void this.app.workspace.openLinkText(path, "", true));
        }
        if (item.references.length > 2) references.createSpan({ text: `另 ${item.references.length - 2} 篇`, cls: "team-core-audit-more-references" });
      }

      const count = row.createEl("td", { cls: "team-core-audit-count-cell" });
      count.createSpan({ text: String(item.count), cls: "team-core-audit-count" });

      const asset = row.createEl("td", { cls: "team-core-audit-asset" });
      const filename = item.path.split("/").pop() ?? item.path;
      const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toUpperCase() : "文件";
      const hash = filename.replace(/^tc-sha256-/, "").replace(/\.[^.]+$/, "");
      const compactHash = hash.length > 14 ? `${hash.slice(0, 7)}…${hash.slice(-5)}` : hash;
      const type = asset.createDiv("team-core-audit-asset-type");
      const icon = type.createSpan("team-core-audit-asset-icon");
      setIcon(icon, extension === "PDF" ? "file-text" : ["PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG", "AVIF"].includes(extension) ? "image" : "paperclip");
      type.createSpan({ text: extension });
      asset.createSpan({ text: compactHash, cls: "team-core-audit-asset-hash", attr: { title: item.path } });
      const copy = asset.createEl("button", { cls: "team-core-audit-copy", attr: { "aria-label": "复制完整附件路径", title: "复制完整附件路径" } });
      setIcon(copy, "copy");
      copy.addEventListener("click", () => void navigator.clipboard.writeText(item.path).then(() => new Notice("附件路径已复制")));
    }
  }

  private async cleanupOrphans(orphan: ReferenceInfo[]): Promise<void> {
    if (!await requestConfirmation(this.app, {
      title: "清理孤立附件",
      message: `确定将 ${orphan.length} 个本地孤立附件移入 Obsidian 回收站吗？它们的 S3 对象不会删除。`,
      confirmText: "移入回收站",
      destructive: true
    })) return;
    const removed: ReferenceInfo[] = [];
    for (const item of orphan) {
      const file = this.app.vault.getAbstractFileByPath(item.path);
      if (!(file instanceof TFile)) continue;
      await this.app.fileManager.trashFile(file);
      removed.push(item);
    }
    if (!removed.length) {
      new Notice("没有可清理的孤立附件，审计结果将刷新");
      await this.render();
      return;
    }
    const manifest = await readManifest(createVaultAdapter(this.app.vault.adapter));
    for (const item of removed) delete manifest.files[item.path];
    const adapter = createVaultAdapter(this.app.vault.adapter);
    const { writeManifest } = await import("./manifest");
    await writeManifest(adapter, manifest);
    new Notice(`已将 ${removed.length} 个孤立附件移入回收站；S3 对象保留`);
    await this.render();
  }
}

export class TeamCoreCommitHistoryView extends ItemView {
  private renderRevision = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => TeamCoreSettings,
    private readonly getAuthorDisplay: () => AuthorDisplayService
  ) {
    super(leaf);
  }

  getViewType(): string { return COMMIT_HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "提交历史"; }
  getIcon(): string { return "git-commit-horizontal"; }

  async onOpen(): Promise<void> { await this.render(); }

  async render(): Promise<void> {
    const renderRevision = ++this.renderRevision;
    const viewport = this.containerEl.children[1] as HTMLElement;
    viewport.empty();
    viewport.addClass("team-core-history-view");
    const container = viewport.createDiv("team-core-history-content");
    const header = container.createDiv("team-core-commit-history-header");
    const title = header.createDiv();
    title.createEl("h2", { text: "提交历史" });
    title.createSpan({ text: "按文件筛选团队知识库的 Git 提交记录" });
    const dashboard = header.createEl("button", { text: "返回团队看板" });
    dashboard.addEventListener("click", () => void this.openDashboard());
    const settings = this.getSettings();
    if (!settings.gitUrl) {
      container.createEl("p", { text: "请先在插件设置中配置 Git 和 S3。" });
      return;
    }
    const repo = new GitRepository(createVaultAdapter(this.app.vault.adapter), settings, consoleLogger(), this.app.vault.configDir);
    const markdownFiles = listAuthorableMarkdownFiles(this.app.vault);
    const filter = container.createDiv("team-core-history-filter team-core-commit-history-filter");
    const input = filter.createEl("input", { type: "search", placeholder: "按文件路径筛选，例如 notes/readme.md" });
    input.setAttr("list", "team-core-commit-history-file-list");
    const datalist = filter.createEl("datalist", { attr: { id: "team-core-commit-history-file-list" } });
    for (const file of markdownFiles) datalist.createEl("option", { attr: { value: file.path } });
    const searchButton = filter.createEl("button", { attr: { "aria-label": "搜索文件提交历史", title: "搜索文件提交历史" } });
    setIcon(searchButton, "search");
    const clearButton = filter.createEl("button", { attr: { "aria-label": "清除文件筛选", title: "清除文件筛选" } });
    setIcon(clearButton, "x");
    const results = container.createDiv("team-core-history-results");
    const pageSize = 10;
    let requestId = 0;
    const renderResults = async (page = 0): Promise<void> => {
      const scrollTop = viewport.scrollTop;
      const query = input.value.trim();
      const currentRequest = ++requestId;
      results.empty();
      results.createEl("p", { text: query ? `正在查询提交历史（第 ${page + 1} 页）…` : `正在加载提交历史（第 ${page + 1} 页）…`, cls: "team-core-history-loading" });
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
        // isomorphic-git has no offset parameter. Read one extra item to determine
        // whether a next page exists, while keeping the initial request bounded.
        const loaded = await repo.log(filepath || undefined, (page + 1) * pageSize + 1);
        const filtered = loaded.slice(page * pageSize, (page + 1) * pageSize);
        const hasNext = loaded.length > (page + 1) * pageSize;
        if (currentRequest !== requestId || this.renderRevision !== renderRevision) return;
        results.empty();
        if (filepath) results.createEl("p", { text: filtered.length ? `${filepath} · 第 ${page + 1} 页` : `${filepath} · 暂无提交记录`, cls: "team-core-history-filter-result" });
        this.renderCommitList(results, filtered, page, hasNext, (nextPage) => void renderResults(nextPage));
        window.requestAnimationFrame(() => { viewport.scrollTop = scrollTop; });
      } catch (error) {
        if (currentRequest !== requestId || this.renderRevision !== renderRevision) return;
        results.empty();
        results.createEl("p", { text: `查询失败：${error instanceof Error ? error.message : String(error)}`, cls: "team-core-history-error" });
      }
    };
    searchButton.addEventListener("click", () => void renderResults());
    clearButton.addEventListener("click", () => { input.value = ""; void renderResults(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") void renderResults(); });
    void renderResults();
  }

  private async openDashboard(): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private renderCommitList(container: HTMLElement, commits: CommitSummary[], page: number, hasNext: boolean, onPage: (page: number) => void): void {
    if (!commits.length) {
      container.createEl("p", { text: "暂无提交历史", cls: "team-core-history-empty" });
      return;
    }
    const wrapper = container.createDiv("team-core-commit-table-wrap");
    const table = wrapper.createEl("table", { cls: "team-core-commit-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of ["提交说明", "作者", "提交时间", "哈希", "类型"]) head.createEl("th", { text: label });
    const body = table.createEl("tbody");
    const authorDisplay = this.getAuthorDisplay();
    for (const [index, commit] of commits.entries()) {
      const row = body.createEl("tr");
      const message = row.createEl("td", { cls: "team-core-commit-message" });
      message.createSpan({ text: commit.message || "无提交说明" });
      if (page === 0 && index === 0) message.createSpan({ text: "最新", cls: "team-core-commit-latest" });
      row.createEl("td", { text: authorDisplay.display(commit.author), cls: "team-core-commit-author" });
      row.createEl("td", { text: new Date(commit.timestamp).toLocaleString(), cls: "team-core-commit-date" });
      row.createEl("td", { text: commit.shortOid, cls: "team-core-commit-oid" });
      const type = row.createEl("td");
      type.createSpan({ text: commit.parents.length > 1 ? "合并" : "普通", cls: commit.parents.length > 1 ? "team-core-commit-merge" : "team-core-commit-type" });
    }
    const pagination = container.createDiv("team-core-pagination");
    const first = pagination.createEl("button", { attr: { "aria-label": "跳转到首页", title: "跳转到首页" } });
    setIcon(first, "chevrons-left");
    first.disabled = page === 0;
    first.addEventListener("click", () => onPage(0));
    const previous = pagination.createEl("button", { attr: { "aria-label": "上一页", title: "上一页" } });
    setIcon(previous, "chevron-left");
    previous.disabled = page === 0;
    previous.addEventListener("click", () => onPage(page - 1));
    pagination.createSpan({ text: `第 ${page + 1} 页`, cls: "team-core-pagination-label" });
    const next = pagination.createEl("button", { attr: { "aria-label": "下一页", title: "下一页" } });
    setIcon(next, "chevron-right");
    next.disabled = !hasNext;
    next.addEventListener("click", () => onPage(page + 1));
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
        detail.createSpan({ text: assigned ? this.authorService.displayAuthors(assigned).join(", ") : "使用 Git 历史", cls: assigned ? "team-core-file-author-assigned" : "team-core-file-author-fallback" });
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
  refreshAuthorDisplays(): void;
  confirmRemoteOverwrite(): Promise<void>;
};

type TextSettingKey = "gitUrl" | "gitUsername" | "gitPassword" | "s3Endpoint" | "s3Region" | "s3Bucket" | "s3Prefix" | "s3AccessKey" | "s3SecretKey";

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
      this.group("S3 对象存储", [
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
      this.group("Git 作者显示", [this.authorDisplayMappingsDefinition()]),
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
    new Setting(containerEl).setName("S3 对象存储").setHeading();
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
    new Setting(containerEl).setName("Git 作者显示").setHeading();
    this.addAuthorDisplayMappingsEntry(new Setting(containerEl).setName("Git 作者显示名称"));
    new Setting(containerEl).setName("快速导入 / 导出").setHeading();
    this.addTransferControl(new Setting(containerEl).setName("配置字符串"));
  }

  private group(heading: string, items: SettingDefinition[]): SettingDefinitionItem {
    return { type: "group", heading, cls: "team-core-settings", items };
  }

  private textDefinition(name: string, key: TextSettingKey, secret: boolean): SettingDefinition {
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

  private authorDisplayMappingsDefinition(): SettingDefinition {
    return {
      name: "Git 作者显示名称",
      desc: "将 Git 历史中的原始作者名映射为本地显示名称，不修改 Git 提交。",
      aliases: ["作者映射", "用户名映射", "中文作者", "Git 作者"],
      render: (setting) => this.addAuthorDisplayMappingsEntry(setting)
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

  private addAuthorDisplayMappingsEntry(setting: Setting): void {
    setting.setDesc("仅修改本机的作者显示；导出的配置字符串可同步给团队成员，不会改写 Git 历史。");
    setting.addButton((button) => {
      button
        .setIcon("languages")
        .setTooltip("管理 Git 作者显示名称")
        .onClick(() => void this.openAuthorDisplayMappingsManager());
      button.buttonEl.appendText("管理显示名称");
    });
  }

  private async openAuthorDisplayMappingsManager(): Promise<void> {
    const confirmed = await requestConfirmation(this.app, {
      title: "管理 Git 作者显示名称",
      message: "这里的设置会改变本机笔记标题、提交历史和作者统计中的显示名称。它不会修改 Git 提交或服务器账户；通过配置字符串导入的成员会获得相同显示规则。",
      confirmText: "进入管理",
      destructive: true
    });
    if (!confirmed) return;
    new AuthorDisplayMappingsModal(this.app, this.teamPlugin.teamCoreSettings.authorDisplayMappings, async (mappings) => {
      this.teamPlugin.teamCoreSettings.authorDisplayMappings = mappings;
      await this.teamPlugin.saveSettings();
      this.teamPlugin.refreshAuthorDisplays();
      this.refreshSettings();
      new Notice("Git 作者显示名称已保存");
    }).open();
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

  private addTextControl(setting: Setting, key: TextSettingKey, secret: boolean): void {
    setting.addText((component) => {
      component.setValue(this.teamPlugin.teamCoreSettings[key]);
      component.inputEl.type = secret ? "password" : "text";
      component.onChange(async (value) => {
        this.teamPlugin.teamCoreSettings[key] = value;
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

class AuthorDisplayMappingsModal extends Modal {
  constructor(
    app: App,
    private readonly mappings: AuthorDisplayMappings,
    private readonly onSave: (mappings: AuthorDisplayMappings) => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("team-core-author-display-modal");
    this.titleEl.setText("Git 作者显示名称");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "为每个需要替换显示名称的 Git 作者添加一行映射。原始名称匹配不区分大小写。",
      cls: "team-core-author-display-intro"
    });
    this.contentEl.createEl("p", {
      text: "映射仅影响本机显示和配置字符串，不会改写任何 Git 提交、服务器账户或文件内容。",
      cls: "team-core-author-display-note"
    });
    const table = this.contentEl.createDiv("team-core-author-display-table");
    const header = table.createDiv("team-core-author-display-header");
    header.createSpan({ text: "原始 Git 作者名称" });
    header.createSpan({ text: "=" });
    header.createSpan({ text: "显示名称" });
    header.createSpan({ text: "操作" });
    const rows = table.createDiv("team-core-author-display-rows");
    const rowInputs: Array<{ source: HTMLInputElement; display: HTMLInputElement }> = [];
    const addRow = (source = "", display = ""): void => {
      const row = rows.createDiv("team-core-author-display-row");
      const sourceInput = row.createEl("input", { type: "text", placeholder: "团队成员账号" });
      sourceInput.value = source;
      sourceInput.setAttr("aria-label", "原始 Git 作者名称");
      sourceInput.setAttr("spellcheck", "false");
      row.createSpan({ text: "=", cls: "team-core-author-display-equals" });
      const displayInput = row.createEl("input", { type: "text", placeholder: "显示名称" });
      displayInput.value = display;
      displayInput.setAttr("aria-label", "显示名称");
      const remove = new ButtonComponent(row)
        .setIcon("trash-2")
        .setTooltip("删除此映射")
        .onClick(() => {
          const index = rowInputs.findIndex((inputs) => inputs.source === sourceInput);
          if (index >= 0) rowInputs.splice(index, 1);
          row.remove();
        });
      remove.buttonEl.addClass("team-core-author-display-remove");
      rowInputs.push({ source: sourceInput, display: displayInput });
    };
    for (const [source, display] of Object.entries(this.mappings)) addRow(source, display);
    new ButtonComponent(this.contentEl.createDiv("team-core-author-display-add"))
      .setIcon("plus")
      .setButtonText("新增映射")
      .onClick(() => {
        addRow();
        rowInputs[rowInputs.length - 1]?.source.focus();
      });
    const error = this.contentEl.createEl("p", { cls: "team-core-author-display-error" });
    const actions = this.contentEl.createDiv("team-core-author-display-actions");
    const cancel = new ButtonComponent(actions).setButtonText("取消").onClick(() => this.close());
    const save = new ButtonComponent(actions).setButtonText("保存显示名称").setCta().onClick(async () => {
      let mappings: AuthorDisplayMappings;
      try {
        mappings = parseAuthorDisplayMappings(rowInputs.map(({ source, display }) => `${source.value}=${display.value}`).join("\n"));
        error.empty();
      } catch (cause) {
        error.setText(cause instanceof Error ? cause.message : String(cause));
        rowInputs.find(({ source, display }) => !source.value.trim() || !display.value.trim())?.source.focus();
        return;
      }
      cancel.setDisabled(true);
      save.setDisabled(true);
      try {
        await this.onSave(mappings);
        this.close();
      } catch (cause) {
        error.setText(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
        cancel.setDisabled(false);
        save.setDisabled(false);
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function consoleLogger() {
  return { debug: () => {}, warn: (message: string, details?: unknown) => console.warn(message, details), error: (message: string, details?: unknown) => console.error(message, details) };
}
