import { ButtonComponent, Modal, Notice, type App } from "obsidian";

export class DiagnosticsModal extends Modal {
  constructor(private readonly hostApp: App, private readonly diagnostics: string) {
    super(hostApp);
  }

  onOpen(): void {
    this.modalEl.addClass("team-core-diagnostics-modal");
    this.titleEl.setText("诊断日志");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "日志已脱敏，仅包含同步状态、阶段和错误信息。" });
    const text = this.contentEl.createEl("textarea", { cls: "team-core-diagnostics-text" });
    text.value = this.diagnostics;
    text.readOnly = true;
    text.setAttr("aria-label", "诊断日志");
    const actions = this.contentEl.createDiv("team-core-diagnostics-actions");
    new ButtonComponent(actions).setButtonText("复制日志").setCta().onClick(async () => {
      try {
        await navigator.clipboard.writeText(this.diagnostics);
        new Notice("诊断日志已复制");
      } catch {
        text.focus();
        text.select();
        new Notice("无法访问系统剪贴板，请手动复制文本");
      }
    });
    new ButtonComponent(actions).setButtonText("关闭").onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
