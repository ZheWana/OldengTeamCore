import { ButtonComponent, Modal, type App } from "obsidian";

interface ConfirmationOptions {
  title: string;
  message: string;
  confirmText?: string;
  destructive?: boolean;
}

export function requestConfirmation(app: App, options: ConfirmationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, options, resolve).open();
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
    this.contentEl.createEl("p", { text: this.options.message });
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
