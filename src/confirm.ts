import { ButtonComponent, Modal, type App } from "obsidian";

interface ConfirmationOptions {
  title: string;
  message: string;
  details?: readonly string[];
  warning?: string;
  confirmText?: string;
  destructive?: boolean;
}

export interface DeletionRestoreItem {
  /** A human-readable path; folder labels conventionally end in a slash. */
  label: string;
  /** Every deleted path restored by this one action. */
  paths: readonly string[];
  kind: "file" | "folder";
}

interface DeletionConfirmationOptions extends Omit<ConfirmationOptions, "details"> {
  items: readonly DeletionRestoreItem[];
}

export interface DeletionConfirmationResult {
  confirmed: boolean;
  restorePaths: string[];
}

export function requestConfirmation(app: App, options: ConfirmationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, options, resolve).open();
  });
}

/**
 * A destructive-sync confirmation with precise, local-only recovery choices.
 * Selecting a row does not immediately mutate the Vault: every selected path
 * is restored atomically by the sync coordinator immediately before it stages
 * the remaining confirmed deletions.
 */
export function requestDeletionConfirmation(app: App, options: DeletionConfirmationOptions): Promise<DeletionConfirmationResult> {
  return new Promise((resolve) => {
    new DeletionConfirmationModal(app, options, resolve).open();
  });
}

class ConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: ConfirmationOptions,
    private readonly resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.modalEl.addClass("team-core-confirm-modal");
    this.contentEl.createEl("p", { text: this.options.message, cls: "team-core-confirm-description" });
    if (this.options.details?.length) {
      const details = this.contentEl.createDiv({ cls: "team-core-confirm-list", attr: { role: "list" } });
      for (const detail of this.options.details) details.createDiv({ text: detail, cls: "team-core-confirm-list-item", attr: { role: "listitem" } });
    }
    if (this.options.warning) this.contentEl.createEl("p", { text: this.options.warning, cls: "team-core-confirm-note" });
    const actions = this.contentEl.createDiv("team-core-confirm-actions");
    new ButtonComponent(actions).setButtonText("取消").onClick(() => this.finish(false));
    const confirm = new ButtonComponent(actions)
      .setButtonText(this.options.confirmText ?? "确认")
      .setCta()
      .onClick(() => this.finish(true));
    if (this.options.destructive) confirm.buttonEl.addClass("team-core-destructive-button");
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveOnce(false);
  }

  private finish(confirmed: boolean): void {
    this.resolveOnce(confirmed);
    this.close();
  }

  private resolveOnce(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(confirmed);
  }
}

class DeletionConfirmationModal extends Modal {
  private settled = false;
  private readonly restorePaths = new Set<string>();
  private listEl: HTMLElement | undefined;
  private confirmButton: ButtonComponent | undefined;

  constructor(
    app: App,
    private readonly options: DeletionConfirmationOptions,
    private readonly resolve: (result: DeletionConfirmationResult) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.modalEl.addClass("team-core-confirm-modal");
    this.contentEl.createEl("p", { text: this.options.message, cls: "team-core-confirm-description" });
    this.listEl = this.contentEl.createDiv({ cls: "team-core-confirm-list", attr: { role: "list" } });
    this.renderItems();
    if (this.options.warning) this.contentEl.createEl("p", { text: this.options.warning, cls: "team-core-confirm-note" });
    const actions = this.contentEl.createDiv("team-core-confirm-actions");
    new ButtonComponent(actions).setButtonText("取消").onClick(() => this.finish(false));
    this.confirmButton = new ButtonComponent(actions)
      .setCta()
      .onClick(() => this.finish(true));
    if (this.options.destructive) this.confirmButton.buttonEl.addClass("team-core-destructive-button");
    this.updateConfirmButton();
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveOnce({ confirmed: false, restorePaths: [] });
  }

  private renderItems(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    for (const item of this.options.items) {
      const row = this.listEl.createDiv({ cls: "team-core-confirm-list-item team-core-confirm-restore-row", attr: { role: "listitem" } });
      const label = row.createSpan({ text: item.label, cls: "team-core-confirm-restore-label" });
      const fullySelected = item.paths.length > 0 && item.paths.every((path) => this.restorePaths.has(path));
      const action = new ButtonComponent(row)
        .setButtonText(fullySelected ? "已撤回" : item.kind === "folder" ? "撤回整个目录" : "撤回删除")
        .onClick(() => this.selectForRestore(item.paths));
      action.buttonEl.addClass("team-core-confirm-restore-button");
      action.buttonEl.disabled = fullySelected;
      if (item.kind === "folder") {
        label.setAttr("data-count", `${item.paths.length}`);
        row.createSpan({ text: `（${item.paths.length} 项）`, cls: "team-core-confirm-restore-count" });
      }
    }
  }

  private selectForRestore(paths: readonly string[]): void {
    for (const path of paths) this.restorePaths.add(path);
    this.renderItems();
    this.updateConfirmButton();
  }

  private updateConfirmButton(): void {
    if (!this.confirmButton) return;
    const restored = this.restorePaths.size;
    const allPaths = new Set(this.options.items.flatMap((item) => item.paths)).size;
    this.confirmButton.setButtonText(restored
      ? restored === allPaths ? "恢复已选内容" : `恢复 ${restored} 项并继续同步`
      : this.options.confirmText ?? "确认");
    this.confirmButton.buttonEl.toggleClass("team-core-destructive-button", Boolean(this.options.destructive && restored !== allPaths));
  }

  private finish(confirmed: boolean): void {
    this.resolveOnce({ confirmed, restorePaths: confirmed ? [...this.restorePaths].sort() : [] });
    this.close();
  }

  private resolveOnce(result: DeletionConfirmationResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(result);
  }
}
