import { ButtonComponent, Modal, setIcon, type App } from "obsidian";
import type { ConflictEditorSession, ConflictResolution } from "./git";

type ConflictView = "local" | "result" | "remote";

interface ResolutionDraft {
  content?: string;
  resolved: boolean;
}

export class ConflictEditorModal extends Modal {
  private readonly drafts: ResolutionDraft[];
  private selectedIndex = 0;
  private activeView: ConflictView = "result";
  private saving = false;
  private saveButton: ButtonComponent | undefined;
  private completionEl: HTMLElement | undefined;
  private resultStatusEl: HTMLElement | undefined;
  private errorEl: HTMLElement | undefined;
  private fileButtons: HTMLButtonElement[] = [];
  private fileIcons: HTMLElement[] = [];

  constructor(
    app: App,
    private readonly session: ConflictEditorSession,
    private readonly onSave: (resolutions: readonly ConflictResolution[]) => Promise<void>,
    private readonly onClosed: () => void
  ) {
    super(app);
    this.drafts = session.files.map((file) => ({ content: file.local, resolved: false }));
  }

  onOpen(): void {
    this.modalEl.addClass("team-core-conflict-modal");
    this.titleEl.setText("解决同步冲突");
    this.render();
    this.contentEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (this.canSave()) void this.save();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.onClosed();
  }

  private render(): void {
    this.contentEl.empty();
    this.fileButtons = [];
    this.fileIcons = [];
    const header = this.contentEl.createDiv("team-core-conflict-header");
    const revision = header.createDiv("team-core-conflict-revision");
    revision.setText(`${this.session.localOid.slice(0, 7)}  /  ${this.session.remoteOid.slice(0, 7)}`);
    this.completionEl = header.createDiv("team-core-conflict-completion");

    const mobileFile = this.contentEl.createDiv("team-core-conflict-mobile-file");
    const select = mobileFile.createEl("select", { attr: { "aria-label": "冲突文件" } });
    this.session.files.forEach((file, index) => {
      const option = select.createEl("option", { text: file.path, value: String(index) });
      option.selected = index === this.selectedIndex;
    });
    select.addEventListener("change", () => {
      this.selectedIndex = Number(select.value);
      this.render();
    });

    const shell = this.contentEl.createDiv("team-core-conflict-shell");
    const files = shell.createDiv("team-core-conflict-files");
    files.createDiv({ cls: "team-core-conflict-section-label", text: "冲突文件" });
    this.session.files.forEach((file, index) => {
      const button = files.createEl("button", { cls: "team-core-conflict-file", attr: { type: "button" } });
      button.toggleClass("is-active", index === this.selectedIndex);
      const icon = button.createSpan("team-core-conflict-file-icon");
      const path = button.createSpan("team-core-conflict-file-path");
      path.setText(file.path);
      button.addEventListener("click", () => {
        this.selectedIndex = index;
        this.render();
      });
      this.fileButtons.push(button);
      this.fileIcons.push(icon);
    });

    const workbench = shell.createDiv("team-core-conflict-workbench");
    const fileHeader = workbench.createDiv("team-core-conflict-file-header");
    fileHeader.createEl("strong", { text: this.currentFile().path });
    const navigation = fileHeader.createDiv("team-core-conflict-navigation");
    this.iconButton(navigation, "chevron-left", "上一个冲突文件", () => this.selectRelative(-1)).setDisabled(this.selectedIndex === 0);
    this.iconButton(navigation, "chevron-right", "下一个冲突文件", () => this.selectRelative(1)).setDisabled(this.selectedIndex === this.session.files.length - 1);

    const tabs = workbench.createDiv("team-core-conflict-tabs");
    this.addTab(tabs, "local", "本地");
    this.addTab(tabs, "result", "结果");
    this.addTab(tabs, "remote", "远端");

    const panes = workbench.createDiv("team-core-conflict-panes");
    this.renderVersionPane(panes, "local", "本地版本", this.session.localOid, this.currentFile().local);
    this.renderResultPane(panes);
    this.renderVersionPane(panes, "remote", "远端版本", this.session.remoteOid, this.currentFile().remote);

    const decisionBar = workbench.createDiv("team-core-conflict-decisions");
    this.labeledButton(decisionBar, "采用本地", "arrow-left", () => this.choose(this.currentFile().local));
    this.labeledButton(decisionBar, "采用远端", "arrow-right", () => this.choose(this.currentFile().remote));
    const remove = this.labeledButton(decisionBar, "删除文件", "trash-2", () => this.choose(undefined));
    remove.buttonEl.addClass("team-core-conflict-delete");
    this.labeledButton(decisionBar, "标记已解决", "check", () => {
      this.currentDraft().resolved = true;
      this.updateCompletionUi();
    });

    this.errorEl = this.contentEl.createDiv({ cls: "team-core-conflict-error", attr: { role: "alert" } });
    const footer = this.contentEl.createDiv("team-core-conflict-footer");
    new ButtonComponent(footer).setButtonText("取消").onClick(() => this.close());
    this.saveButton = this.labeledButton(footer, "保存并同步", "git-merge", () => void this.save()).setCta();
    this.updateCompletionUi();
  }

  private renderVersionPane(parent: HTMLElement, view: "local" | "remote", label: string, oid: string, content: string | undefined): void {
    const pane = parent.createDiv(`team-core-conflict-pane team-core-conflict-${view}`);
    pane.toggleClass("is-mobile-active", this.activeView === view);
    const heading = pane.createDiv("team-core-conflict-pane-heading");
    heading.createEl("strong", { text: content === undefined ? `${label}（已删除）` : label });
    heading.createSpan({ text: oid.slice(0, 7) });
    const textarea = pane.createEl("textarea", {
      cls: "team-core-conflict-editor",
      attr: { readonly: "", "aria-label": label, spellcheck: "false", placeholder: "此版本中不存在该文件" }
    });
    textarea.value = content ?? "";
  }

  private renderResultPane(parent: HTMLElement): void {
    const pane = parent.createDiv("team-core-conflict-pane team-core-conflict-result");
    pane.toggleClass("is-mobile-active", this.activeView === "result");
    const heading = pane.createDiv("team-core-conflict-pane-heading");
    heading.createEl("strong", { text: "合并结果" });
    this.resultStatusEl = heading.createSpan();
    const textarea = pane.createEl("textarea", {
      cls: "team-core-conflict-editor",
      attr: { "aria-label": "合并结果", spellcheck: "false", placeholder: "文件将被删除" }
    });
    textarea.value = this.currentDraft().content ?? "";
    textarea.addEventListener("input", () => {
      const draft = this.currentDraft();
      draft.content = textarea.value;
      draft.resolved = false;
      this.updateCompletionUi();
    });
  }

  private addTab(parent: HTMLElement, view: ConflictView, label: string): void {
    const button = parent.createEl("button", { text: label, attr: { type: "button", "aria-pressed": String(this.activeView === view) } });
    button.toggleClass("is-active", this.activeView === view);
    button.addEventListener("click", () => {
      this.activeView = view;
      this.render();
    });
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): ButtonComponent {
    const button = new ButtonComponent(parent).setIcon(icon).onClick(onClick);
    button.buttonEl.setAttr("aria-label", label);
    button.buttonEl.setAttr("title", label);
    return button;
  }

  private labeledButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): ButtonComponent {
    const button = new ButtonComponent(parent).setButtonText(label).onClick(onClick);
    const iconEl = createSpan({ cls: "team-core-button-icon" });
    setIcon(iconEl, icon);
    button.buttonEl.prepend(iconEl);
    return button;
  }

  private selectRelative(offset: number): void {
    const next = this.selectedIndex + offset;
    if (next < 0 || next >= this.session.files.length) return;
    this.selectedIndex = next;
    this.render();
  }

  private choose(content: string | undefined): void {
    this.drafts[this.selectedIndex] = { content, resolved: true };
    this.render();
  }

  private currentFile() {
    return this.session.files[this.selectedIndex];
  }

  private currentDraft(): ResolutionDraft {
    return this.drafts[this.selectedIndex];
  }

  private canSave(): boolean {
    return !this.saving && this.drafts.length > 0 && this.drafts.every(({ resolved }) => resolved);
  }

  private updateCompletionUi(): void {
    const completed = this.drafts.filter(({ resolved }) => resolved).length;
    this.completionEl?.setText(`已解决 ${completed}/${this.drafts.length}`);
    this.resultStatusEl?.setText(this.currentDraft().resolved ? "已确认" : "待确认");
    this.fileButtons.forEach((button, index) => button.toggleClass("is-resolved", this.drafts[index].resolved));
    this.fileIcons.forEach((icon, index) => {
      icon.empty();
      setIcon(icon, this.drafts[index].resolved ? "check" : "file-warning");
    });
    this.saveButton?.setDisabled(!this.canSave());
  }

  private async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving = true;
    this.errorEl?.empty();
    this.contentEl.querySelectorAll("button, textarea, select").forEach((element) => {
      (element as HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement).disabled = true;
    });
    try {
      await this.onSave(this.session.files.map((file, index) => ({ path: file.path, content: this.drafts[index].content })));
      this.close();
    } catch (error) {
      this.saving = false;
      this.errorEl?.setText(error instanceof Error ? error.message : String(error));
      this.contentEl.querySelectorAll("button, textarea, select").forEach((element) => {
        (element as HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement).disabled = false;
      });
      this.updateCompletionUi();
    }
  }
}
