import { FileSystemAdapter, Platform, TFile, TFolder, type App, type Editor } from "obsidian";
import { MANIFEST_PATH, DEFAULT_BRANCH, PRIVATE_FOLDER } from "./constants";
import { sha256Hex } from "./crypto";
import { GitRepository, isPushReconciliationError, type ConflictEditorSession, type ConflictResolution } from "./git";
import { PluginLogger } from "./logger";
import { createEmptyManifest, readManifest, removeManifestEntry, updateManifestEntry, writeManifest } from "./manifest";
import { S3NotFoundError, S3Transport } from "./s3";
import type { AssetManifest, AssetManifestEntry, Logger, SyncProgress, SyncSnapshot, SyncState, TeamCoreSettings } from "./types";
import { assetPathForHash, collectMarkdownReferences, collectPrivateAttachmentReferences, createVaultAdapter, ensureAssetsExcluded, hashFromAssetPath, isAssetPath, isConfigPath, isManagedPath, isPrivateAssetPath, isPrivatePath, isTrashPath, legacyHashFromAssetPath, listRemoteOverwriteFiles, normalizeVaultPath, pastedImageExtension, pastedImageTargetPath, pruneEmptyManagedFolders, rewriteAssetReferences, type BinaryVault } from "./vault";
import { applySharedPluginState as applySharedPluginStateToVault, isCommunityPluginStatePath, readCommunityPluginIds, readSharedPluginIds, readSharedPluginState, SHARED_PLUGIN_STATE_PATH, writeSharedPluginIds, writeSharedPluginState } from "./shared-plugins";

const MAX_PUSH_RECONCILIATION_RETRIES = 2;
export const MOBILE_ATTACHMENT_DOWNLOAD_LIMIT = 32 * 1024 * 1024;

export function shouldDeferLargeMobileAttachment(size: number, isMobile: boolean): boolean {
  return isMobile && size > MOBILE_ATTACHMENT_DOWNLOAD_LIMIT;
}

export interface SyncCallbacks {
  onSnapshot(snapshot: SyncSnapshot): void;
  onNotice(message: string): void;
}

export interface ConnectionInfo {
  localRepository: boolean;
  localHasManagedFiles: boolean;
  localRemoteUrl?: string;
  remoteHasCommits: boolean;
}

export interface RemoteClearResult {
  deletedS3Objects: number;
  deletedGitBranch: boolean;
}

interface AttachmentPlan {
  sourcePath: string;
  targetPath: string;
  hash: string;
  size: number;
  mime: string;
  data?: ArrayBuffer;
  requiresUpload: boolean;
}

export interface MarkdownSnapshot {
  path: string;
  content: string;
}

export interface PrivateDraftAttachmentPlan {
  sourcePath: string;
  targetPath: string;
  data: ArrayBuffer;
  createTarget: boolean;
  removeSource: boolean;
}

export interface PrivateDraftPublicationPlan {
  markdown: string;
  attachments: PrivateDraftAttachmentPlan[];
}

type AttachmentReferenceCollector = (markdown: string, sourcePath: string) => string[];

async function planAttachmentTransfer(
  vault: BinaryVault,
  markdown: string,
  originalPath: string,
  currentPath: string,
  otherNotes: readonly MarkdownSnapshot[],
  collectReferences: AttachmentReferenceCollector,
  targetForHash: (hash: string, extension?: string) => string,
  sourceLabel: string,
  targetLabel: string
): Promise<PrivateDraftPublicationPlan> {
  const referenced = new Set([
    ...collectReferences(markdown, originalPath),
    ...collectReferences(markdown, currentPath)
  ]);
  const shared = new Set<string>();
  for (const note of otherNotes) {
    for (const path of collectReferences(note.content, note.path)) shared.add(path);
  }

  const attachments: PrivateDraftAttachmentPlan[] = [];
  let rewritten = markdown;
  for (const sourcePath of [...referenced].sort()) {
    const source = await vault.stat(sourcePath);
    if (!source || source.type !== "file") throw new Error(`${sourceLabel}附件不存在：${sourcePath}`);
    const data = await vault.read(sourcePath);
    const hash = await sha256Hex(data);
    const filename = sourcePath.split("/").pop() ?? "";
    const dot = filename.lastIndexOf(".");
    const extension = dot > 0 ? filename.slice(dot + 1) : undefined;
    const targetPath = targetForHash(hash, extension);
    const target = await vault.stat(targetPath);
    let createTarget = true;
    if (target) {
      if (target.type !== "file") throw new Error(`${targetLabel}附件路径无法使用：${targetPath}`);
      const targetData = await vault.read(targetPath);
      if (targetData.byteLength !== data.byteLength || await sha256Hex(targetData) !== hash) {
        throw new Error(`${targetLabel}哈希附件与${sourceLabel}附件内容不一致：${targetPath}`);
      }
      createTarget = false;
    }
    attachments.push({ sourcePath, targetPath, data, createTarget, removeSource: !shared.has(sourcePath) });
    rewritten = rewriteAssetReferences(rewritten, currentPath, sourcePath, targetPath, originalPath);
    rewritten = rewriteAssetReferences(rewritten, currentPath, sourcePath, targetPath, currentPath);
  }

  const remaining = new Set([
    ...collectReferences(rewritten, originalPath),
    ...collectReferences(rewritten, currentPath)
  ]);
  for (const sourcePath of referenced) {
    if (remaining.has(sourcePath)) throw new Error(`无法改写${sourceLabel}附件链接：${sourcePath}`);
  }
  return { markdown: rewritten, attachments };
}

/**
 * Builds a complete publication plan without changing the Vault. All private
 * attachment bytes and existing public destinations are verified up front so
 * the caller can safely materialize the plan before exposing the Markdown.
 */
export async function planPrivateDraftPublication(
  vault: BinaryVault,
  markdown: string,
  originalPath: string,
  currentPath: string,
  otherPrivateNotes: readonly MarkdownSnapshot[]
): Promise<PrivateDraftPublicationPlan> {
  return planAttachmentTransfer(
    vault,
    markdown,
    originalPath,
    currentPath,
    otherPrivateNotes,
    collectPrivateAttachmentReferences,
    assetPathForHash,
    "私人",
    "公共"
  );
}

export async function planPublicNotePrivatization(
  vault: BinaryVault,
  markdown: string,
  originalPath: string,
  currentPath: string,
  otherPublicNotes: readonly MarkdownSnapshot[]
): Promise<PrivateDraftPublicationPlan> {
  return planAttachmentTransfer(
    vault,
    markdown,
    originalPath,
    currentPath,
    otherPublicNotes,
    collectMarkdownReferences,
    (hash, extension) => `${PRIVATE_FOLDER}/${assetPathForHash(hash, extension)}`,
    "公共",
    "私人"
  );
}

export interface RemoteReconciliationResult {
  conflicts: string[];
  deferred: boolean;
}

export async function pushWithNonFastForwardRetry(
  push: () => Promise<void>,
  reconcile: (attempt: number, maximum: number) => Promise<RemoteReconciliationResult>,
  maximumRetries = MAX_PUSH_RECONCILIATION_RETRIES
): Promise<RemoteReconciliationResult> {
  let retries = 0;
  while (true) {
    try {
      await push();
      return { conflicts: [], deferred: false };
    } catch (error) {
      if (!isPushReconciliationError(error) || retries >= maximumRetries) throw error;
      retries += 1;
      const result = await reconcile(retries, maximumRetries);
      if (result.conflicts.length || result.deferred) return result;
    }
  }
}

export function shouldMaterializeRemoteAttachment(previous: AssetManifestEntry | undefined, current: AssetManifestEntry, localFileExists: boolean): boolean {
  return !localFileExists || !previous || previous.sha256 !== current.sha256 || previous.size !== current.size;
}

export function shouldProtectMismatchedLocalAttachment(localFileExists: boolean, uploadedBy: string, username: string): boolean {
  return localFileExists && uploadedBy === username;
}

export function shouldTrackVaultEvent(path: string, configDir: string, sharedPluginIds: readonly string[]): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized !== MANIFEST_PATH
    && !isPrivatePath(normalized)
    && (isAssetPath(normalized) || isManagedPath(normalized, configDir, sharedPluginIds));
}

export function shouldPublishPrivateDraftRename(
  previousPath: string,
  currentPath: string,
  extension: string,
  configDir: string,
  sharedPluginIds: readonly string[]
): boolean {
  return extension === "md"
    && isPrivatePath(previousPath)
    && isManagedPath(currentPath, configDir, sharedPluginIds);
}

export function takePendingPaths(pending: Set<string>): Set<string> {
  const snapshot = new Set(pending);
  for (const path of snapshot) pending.delete(path);
  return snapshot;
}

export function shouldNormalizeMovedAttachment(previousPath: string, currentPath: string, configDir: string): boolean {
  const previous = normalizeVaultPath(previousPath);
  const current = normalizeVaultPath(currentPath);
  return (isAssetPath(previous) || isPrivateAssetPath(previous))
    && !isConfigPath(current, configDir)
    && isManagedPath(current, configDir);
}

export class SyncCoordinator {
  private state: SyncState = "uninitialized";
  private pendingFiles = new Set<string>();
  private pendingAssets = new Set<string>();
  private internalMarkdownWrites = new Set<string>();
  private internalAssetWrites = new Set<string>();
  private internalDraftNoteMoves = new Set<string>();
  private fileMoveRevisions = new WeakMap<TFile, number>();
  private pendingDraftPublications = new Map<symbol, { file: TFile; originalPath: string }>();
  private pendingNotePrivatizations = new Map<symbol, { file: TFile; originalPath: string }>();
  private internalCommunityPluginWriteDepth = 0;
  private debounceTimer: number | undefined;
  private periodicTimer: number | undefined;
  private running: Promise<void> | undefined;
  private lastError = "";
  private lastSyncAt: number | undefined;
  private currentAuthor: string | undefined;
  private progress: SyncProgress | undefined;
  private fullAttachmentScanPending = false;
  private sharedPluginIds: string[] = [];
  readonly logger: Logger;

  constructor(private readonly app: App, private readonly settings: () => TeamCoreSettings, private readonly callbacks: SyncCallbacks, logger?: Logger) {
    this.logger = logger ?? new PluginLogger();
  }

  private createVault(): BinaryVault {
    return createVaultAdapter(this.app.vault.adapter);
  }

  private createRepository(vault: BinaryVault = this.createVault(), settings: TeamCoreSettings = this.settings(), sharedPluginIds: readonly string[] = this.sharedPluginIds): GitRepository {
    return new GitRepository(vault, settings, this.logger, this.app.vault.configDir, sharedPluginIds);
  }

  start(): void {
    this.stop();
    if (!this.settings().autoSync) return;
    if (this.pendingFiles.size || this.pendingAssets.size) {
      this.debounceTimer = window.setTimeout(() => void this.flushDebounce(), this.settings().debounceMs);
    }
    this.periodicTimer = window.setInterval(() => void this.runCycle(false), this.settings().syncIntervalMs);
  }

  stop(): void {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    if (this.periodicTimer !== undefined) window.clearInterval(this.periodicTimer);
    this.debounceTimer = undefined;
    this.periodicTimer = undefined;
  }

  markFileChanged(file: TFile): void {
    const path = normalizeVaultPath(file.path);
    if (isCommunityPluginStatePath(path, this.app.vault.configDir)) {
      if (this.internalCommunityPluginWriteDepth > 0) return;
      this.pendingFiles.add(SHARED_PLUGIN_STATE_PATH);
      this.scheduleSync();
      return;
    }
    // Attachments are managed through S3 rather than Git, but their Vault
    // events still need to enter the attachment preparation queue.
    if (!shouldTrackVaultEvent(path, this.app.vault.configDir, this.sharedPluginIds)) return;
    if (isAssetPath(path)) {
      if (this.internalAssetWrites.delete(path)) return;
      this.pendingAssets.add(path);
      this.scheduleSync();
      return;
    }
    if (this.internalMarkdownWrites.delete(path)) return;
    this.pendingFiles.add(path);
    this.scheduleSync();
  }

  markManagedPathChanged(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (!isManagedPath(normalized, this.app.vault.configDir, this.sharedPluginIds)) return;
    this.pendingFiles.add(normalized);
    this.scheduleSync();
  }

  markFileDeleted(file: TFile): void {
    const path = normalizeVaultPath(file.path);
    if (path === MANIFEST_PATH) {
      this.pendingFiles.add(path);
      this.fullAttachmentScanPending = true;
      this.scheduleSync();
      return;
    }
    this.markFileChanged(file);
  }

  markFileRenamed(file: TFile, oldPath: string): void {
    const previous = normalizeVaultPath(oldPath);
    const current = normalizeVaultPath(file.path);
    const moveRevision = (this.fileMoveRevisions.get(file) ?? 0) + 1;
    this.fileMoveRevisions.set(file, moveRevision);
    if (this.internalDraftNoteMoves.has(previous) || this.internalDraftNoteMoves.has(current)) {
      this.internalDraftNoteMoves.delete(previous);
      this.internalDraftNoteMoves.delete(current);
      return;
    }
    if (this.internalAssetWrites.has(previous) || this.internalAssetWrites.has(current)) {
      this.internalAssetWrites.delete(previous);
      this.internalAssetWrites.delete(current);
      return;
    }
    if (previous === MANIFEST_PATH) {
      this.pendingFiles.add(MANIFEST_PATH);
      this.fullAttachmentScanPending = true;
      this.scheduleSync();
      return;
    }
    if (shouldPublishPrivateDraftRename(previous, current, file.extension, this.app.vault.configDir, this.sharedPluginIds)) {
      const token = Symbol(current);
      this.pendingDraftPublications.set(token, { file, originalPath: previous });
      void this.runExclusive(() => this.publishPrivateDraft(file, previous, moveRevision))
        .catch((error) => {
          this.progress = undefined;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.setState("error");
          this.callbacks.onNotice(`私人草稿发布失败：${this.lastError}`);
          this.logger.error("Private draft publication failed", { source: previous, error: this.lastError });
        })
        .finally(() => this.pendingDraftPublications.delete(token));
      return;
    }
    if (file.extension === "md" && !isPrivatePath(previous) && isPrivatePath(current)
      && isManagedPath(previous, this.app.vault.configDir, this.sharedPluginIds)) {
      const token = Symbol(current);
      this.pendingNotePrivatizations.set(token, { file, originalPath: previous });
      void this.runExclusive(() => this.privatizePublicNote(file, previous, moveRevision))
        .catch((error) => {
          this.progress = undefined;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.setState("error");
          this.callbacks.onNotice(`笔记移入“私人笔记”失败：${this.lastError}`);
          this.logger.error("Public note privatization failed", { source: previous, error: this.lastError });
        })
        .finally(() => this.pendingNotePrivatizations.delete(token));
      return;
    }
    if (isAssetPath(previous)) {
      this.pendingAssets.add(previous);
      if (shouldNormalizeMovedAttachment(previous, current, this.app.vault.configDir)) this.pendingAssets.add(current);
      this.scheduleSync();
      return;
    }
    if (isPrivateAssetPath(previous) && shouldNormalizeMovedAttachment(previous, current, this.app.vault.configDir)) {
      this.pendingAssets.add(current);
      this.scheduleSync();
      return;
    }
    if (isManagedPath(previous, this.app.vault.configDir, this.sharedPluginIds) && !isPrivatePath(previous) && previous !== MANIFEST_PATH) this.pendingFiles.add(previous);
    this.markFileChanged(file);
    if (this.pendingFiles.has(previous) || this.pendingAssets.has(previous)) this.scheduleSync();
  }

  markFolderRenamed(folder: TFolder, oldPath: string): void {
    const previousRoot = normalizeVaultPath(oldPath);
    const currentRoot = normalizeVaultPath(folder.path);
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFile) {
          const suffix = normalizeVaultPath(child.path).slice(currentRoot.length).replace(/^\/+/, "");
          this.markFileRenamed(child, suffix ? `${previousRoot}/${suffix}` : previousRoot);
        } else if (child instanceof TFolder) visit(child);
      }
    };
    visit(folder);
  }

  markFolderDeleted(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (!isAssetPath(normalized) && !isManagedPath(normalized, this.app.vault.configDir, this.sharedPluginIds)) return;
    this.pendingFiles.add(normalized);
    this.fullAttachmentScanPending = true;
    this.scheduleSync();
  }

  handleEditorPaste(event: ClipboardEvent, editor: Editor, sourceFile: TFile | null): boolean {
    if (!sourceFile) return false;
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!images.length) return false;
    void this.insertPastedImages(images, editor, sourceFile);
    return true;
  }

  async prepareLocalVault(): Promise<void> {
    const vault = this.createVault();
    try {
      if (ensureAssetsExcluded(this.app.vault)) this.logger.debug("已将公共和私人附件目录加入 Obsidian 排除文件规则");
    } catch (error) {
      this.logger.warn("无法将 assets 加入 Obsidian 排除文件规则", error);
    }
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const existing = await vault.stat(PRIVATE_FOLDER);
    if (existing && existing.type !== "folder") throw new Error(`无法创建私人笔记文件夹：${PRIVATE_FOLDER} 已被文件占用`);
    await vault.mkdir(PRIVATE_FOLDER);
  }

  async setSharedPluginIds(ids: readonly string[]): Promise<void> {
    const vault = this.createVault();
    await writeSharedPluginIds(vault, this.app.vault.configDir, ids);
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    await this.refreshState();
    if (this.state !== "uninitialized") {
      this.pendingFiles.add(".gitignore");
      this.scheduleSync();
    }
  }

  private scheduleSync(): void {
    if (this.state !== "conflict") this.setState("local-changes");
    if (!this.settings().autoSync) return;
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.flushDebounce(), this.settings().debounceMs);
  }

  async flushDebounce(): Promise<void> {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.pendingFiles.size || this.pendingAssets.size) await this.runCycle(true);
  }

  async runManual(): Promise<void> {
    if (this.debounceTimer !== undefined && (this.pendingFiles.size || this.pendingAssets.size)) {
      await this.flushDebounce();
      return;
    }
    await this.runCycle(true);
  }

  async normalizeAllAttachments(): Promise<void> {
    this.fullAttachmentScanPending = true;
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    await this.runCycle(true);
    if (this.fullAttachmentScanPending) await this.runCycle(true);
  }

  async refreshState(): Promise<void> {
    const vault = this.createVault();
    try {
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      if (!(await git.exists()) || !(await git.remoteUrl())) {
        this.setState("uninitialized");
        return;
      }
      const conflicts = await git.conflictedFiles();
      if (conflicts.length) {
        this.lastError = `待解决的 Git 冲突：${conflicts.join(", ")}`;
        this.setState("conflict");
        return;
      }
      this.setState(await git.hasUncommittedChanges() ? "local-changes" : "synced");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState(this.isOffline(error) ? "offline" : "error");
    }
  }

  async getConflictEditorSession(): Promise<ConflictEditorSession> {
    return this.runExclusive(async () => {
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      return git.getConflictEditorSession();
    });
  }

  async resolveConflicts(resolutions: readonly ConflictResolution[]): Promise<SyncSnapshot> {
    await this.runExclusive(async () => {
      const vault = this.createVault();
      const previousSharedPluginIds = [...this.sharedPluginIds];
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      await git.resolveConflicts(resolutions);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const enabledStateChanged = await this.applySharedPluginState(vault);
      this.notifySharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
      for (const { path } of resolutions) this.pendingFiles.delete(path);
      this.lastError = "";
      this.progress = undefined;
      this.setState("local-changes");
    });
    await this.runCycle(true);
    return this.snapshot();
  }

  async clearRemoteData(): Promise<RemoteClearResult> {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    while (this.running) await this.running;
    let result: RemoteClearResult | undefined;
    const task = this.executeRemoteClear().then((value) => { result = value; });
    const running = task.finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    await running;
    return result as RemoteClearResult;
  }

  snapshot(): SyncSnapshot {
    return { state: this.state, lastError: this.lastError || undefined, lastSyncAt: this.lastSyncAt, currentAuthor: this.currentAuthor, pendingFiles: [...this.pendingFiles].sort(), pendingAssets: [...this.pendingAssets].sort(), progress: this.progress ? { ...this.progress } : undefined };
  }

  async runCycle(force: boolean): Promise<void> {
    if (this.running) return this.running;
    if (!force && !this.settings().autoSync) return;
    if (!force && this.debounceTimer !== undefined) return;
    this.running = this.executeCycle().finally(() => { this.running = undefined; });
    return this.running;
  }

  async initializeEmptyRemote(): Promise<void> {
    return this.runExclusive(() => this.executeInitializeEmptyRemote());
  }

  private async executeInitializeEmptyRemote(): Promise<void> {
    this.setState("syncing");
    try {
      const settings = this.settings();
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault, settings);
      const remote = await git.remoteInfo();
      if (Object.keys(remote.heads).length > 0) throw new Error("远端仓库已有提交，请使用“从远端知识库导入”或“立即同步”，不能重复初始化");
      this.startProgress("准备本地仓库", 1);
      await git.init();
      this.advanceProgress();
      await git.ensureRemote();
      await git.ensureGitignore();
      await this.syncSharedPluginStateBeforeCommit(vault);
      await this.prepareAttachments(new Set(), new Set(), true);
      if (!(await vault.exists(MANIFEST_PATH))) await writeManifest(vault, createEmptyManifest());
      this.startProgress("提交知识库", 1);
      await git.commit("Initialize vault");
      this.advanceProgress();
      this.startProgress("推送到远端", 1);
      await git.push();
      this.advanceProgress();
      this.progress = undefined;
      this.setState("synced");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState(this.isOffline(error) ? "offline" : "error");
      throw error;
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    while (this.running) await this.running;
    let result!: T;
    const task = operation().then((value) => { result = value; });
    const running = task.finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    await running;
    return result;
  }

  async inspectConnection(): Promise<ConnectionInfo> {
    const vault = this.createVault();
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const git = this.createRepository(vault);
    const files = await listRemoteOverwriteFiles(vault, this.app.vault.configDir);
    const info = await git.remoteInfo();
    return {
      localRepository: await git.exists(),
      localHasManagedFiles: files.length > 0 || await vault.exists(".git"),
      localRemoteUrl: await git.remoteUrl(),
      remoteHasCommits: Object.keys(info.heads).length > 0
    };
  }

  async cloneRemote(force = false): Promise<void> {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.setState("syncing");
    this.startProgress(force ? "等待重新同步" : "等待远端导入", 1);
    return this.runExclusive(() => this.executeCloneRemote(force));
  }

  private async executeCloneRemote(force: boolean): Promise<void> {
    this.setState("syncing");
    try {
      this.pendingFiles.clear();
      this.pendingAssets.clear();
      this.fullAttachmentScanPending = false;
      if (force) await this.clearForRemoteClone();
      const vault = this.createVault();
      const previousSharedPluginIds = [...this.sharedPluginIds];
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      this.startProgress("拉取远端 Git", 1);
      await git.clone((event) => this.updateProgress("拉取远端 Git", event.loaded, event.total, event.phase));
      this.updateProgress("拉取远端 Git", 1, 1, "Git 工作区已写入");
      this.startProgress("应用远端配置", 2);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      this.advanceProgress("公共插件白名单");
      const enabledStateChanged = await this.applySharedPluginState(vault);
      this.advanceProgress("公共插件启用状态");
      this.notifySharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
      this.startProgress("检查远端附件", 1);
      const remoteManifest = await readManifest(vault);
      this.advanceProgress(MANIFEST_PATH);
      await this.materializeRemoteAttachments(createEmptyManifest(), remoteManifest);
      this.startProgress("整理本地目录", 1);
      await pruneEmptyManagedFolders(vault, this.app.vault.configDir);
      this.advanceProgress();
      this.lastSyncAt = Date.now();
      this.lastError = "";
      this.progress = undefined;
      this.pendingFiles.clear();
      this.pendingAssets.clear();
      this.setState("synced");
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState(this.isOffline(error) ? "offline" : "error");
      throw error;
    }
  }

  getVaultBasePath(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }

  private async clearForRemoteClone(): Promise<void> {
    const adapter = this.createVault();
    const files = await listRemoteOverwriteFiles(adapter, this.app.vault.configDir);
    const hasGitDirectory = await adapter.exists(".git");
    const cleanupItems = files.length + (hasGitDirectory ? 1 : 0);
    this.startProgress("清理本地知识库", Math.max(cleanupItems, 1));
    for (const path of files) {
      const indexed = this.app.vault.getAbstractFileByPath(path);
      if (indexed instanceof TFile) await this.app.fileManager.trashFile(indexed);
      else await adapter.remove(path);
      this.advanceProgress(path);
    }
    await pruneEmptyManagedFolders(adapter, this.app.vault.configDir);
    if (hasGitDirectory) {
      await adapter.rmdir(".git", true);
      this.advanceProgress(".git");
    } else if (!cleanupItems) {
      this.advanceProgress("无需清理本地文件");
    }
  }

  private async executeRemoteClear(): Promise<RemoteClearResult> {
    this.progress = undefined;
    this.setState("syncing");
    try {
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      const s3 = new S3Transport(this.settings(), this.logger);
      if (!s3.enabled()) throw new Error("S3 配置不完整，未执行任何删除");

      this.startProgress("检查远端清空范围", 2);
      const remote = await git.remoteInfo();
      this.advanceProgress("Git main");
      const objectKeys = await s3.listManagedObjects();
      this.advanceProgress(s3.managedObjectPrefix());
      const remoteMainOid = remote.heads[DEFAULT_BRANCH];
      const remoteBranchExists = Boolean(remoteMainOid);

      this.startProgress("删除远端附件", objectKeys.length);
      await s3.deleteManagedObjects(objectKeys, (key) => this.advanceProgress(key));
      if (remoteMainOid) {
        this.startProgress("清空远端 Git", 1);
        await git.deleteRemoteBranch(remoteMainOid);
        this.advanceProgress(DEFAULT_BRANCH);
      }

      await writeManifest(vault, createEmptyManifest());
      if (await vault.exists(".git")) {
        this.startProgress("重置本地 Git", 1);
        await vault.rmdir(".git", true);
        this.advanceProgress(".git");
      }
      this.pendingFiles.clear();
      this.pendingAssets.clear();
      this.fullAttachmentScanPending = false;
      this.lastError = "";
      this.lastSyncAt = undefined;
      this.currentAuthor = undefined;
      this.progress = undefined;
      this.setState("uninitialized");
      return { deletedS3Objects: objectKeys.length, deletedGitBranch: remoteBranchExists };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.progress = undefined;
      this.setState(this.isOffline(error) ? "offline" : "error");
      this.logger.error("Remote clear failed", { error: this.lastError });
      throw error;
    }
  }

  private async executeCycle(): Promise<void> {
    this.progress = undefined;
    this.setState("syncing");
    // Consume only the captured generation. Events arriving after this point,
    // including another edit to the same path, remain queued for the next run.
    const pendingNotes = takePendingPaths(this.pendingFiles);
    const pendingAssets = takePendingPaths(this.pendingAssets);
    const forceFullAttachmentScan = this.fullAttachmentScanPending;
    if (forceFullAttachmentScan) this.fullAttachmentScanPending = false;
    try {
      const settings = this.settings();
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault, settings);
      if (!(await git.exists())) {
        this.progress = undefined;
        this.setState("uninitialized");
        return;
      }
      const existingConflicts = await git.conflictedFiles();
      if (existingConflicts.length) {
        this.enterConflict(existingConflicts, false);
        return;
      }
      await git.ensureRemote();
      await git.ensureGitignore();
      await this.syncSharedPluginStateBeforeCommit(vault);
      const changed = await this.prepareAttachments(pendingNotes, pendingAssets, forceFullAttachmentScan);
      const hasGitChanges = await git.hasUncommittedChanges();
      if (this.pendingDraftPublications.size || this.pendingNotePrivatizations.size) {
        for (const path of pendingNotes) this.pendingFiles.add(path);
        for (const path of pendingAssets) this.pendingAssets.add(path);
        if (forceFullAttachmentScan) this.fullAttachmentScanPending = true;
        this.deferForLocalChanges();
        return;
      }
      if (changed || pendingNotes.size || hasGitChanges) {
        this.startProgress("提交本地更改", 1);
        await git.commit(
          `Update vault: ${pendingNotes.size || 1} files`,
          () => [...this.pendingDraftPublications.values(), ...this.pendingNotePrivatizations.values()]
            .flatMap(({ file, originalPath }) => [normalizeVaultPath(file.path), normalizeVaultPath(originalPath)])
        );
        this.advanceProgress();
      }
      const manifestBeforeRemote = await readManifest(vault);
      this.startProgress("拉取远端更改", 1);
      await git.fetch();
      this.advanceProgress();
      const initialReconciliation = await this.mergeFetchedRemote(git, vault, manifestBeforeRemote);
      if (initialReconciliation.deferred) {
        this.deferForLocalChanges();
        return;
      }
      if (initialReconciliation.conflicts.length) {
        this.enterConflict(initialReconciliation.conflicts);
        return;
      }
      const pushResult = await pushWithNonFastForwardRetry(
        async () => {
          this.startProgress("推送到远端", 1);
          await git.push();
          this.advanceProgress();
        },
        async (attempt, maximum) => {
          const manifestBeforeRetry = await readManifest(vault);
          this.startProgress(`远端已更新，重新拉取 ${attempt}/${maximum}`, 1);
          await git.fetch();
          this.advanceProgress();
          return this.mergeFetchedRemote(git, vault, manifestBeforeRetry);
        }
      );
      if (pushResult.deferred) {
        this.deferForLocalChanges();
        return;
      }
      if (pushResult.conflicts.length) {
        this.enterConflict(pushResult.conflicts);
        return;
      }
      const active = this.app.workspace.getActiveFile();
      if (active) this.currentAuthor = (await git.log(active.path, 1))[0]?.author;
      this.lastSyncAt = Date.now();
      this.lastError = "";
      this.progress = undefined;
      const remainingChanges = await git.hasUncommittedChanges();
      const queuedChanges = this.pendingFiles.size > 0 || this.pendingAssets.size > 0 || this.fullAttachmentScanPending;
      this.setState(remainingChanges || queuedChanges ? "local-changes" : "synced");
    } catch (error) {
      for (const path of pendingNotes) this.pendingFiles.add(path);
      for (const path of pendingAssets) this.pendingAssets.add(path);
      if (forceFullAttachmentScan) this.fullAttachmentScanPending = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.isOffline(error)) this.setState("offline");
      else {
        this.setState("error");
        this.callbacks.onNotice(`Oldeng Team Core 同步失败：${this.lastError}`);
      }
      this.logger.error("Synchronization failed", { error: this.lastError });
    }
  }

  private async mergeFetchedRemote(git: GitRepository, vault: BinaryVault, manifestBeforeRemote: AssetManifest): Promise<RemoteReconciliationResult> {
    // A note may be edited while fetch is in flight. Defer the merge so the
    // next cycle commits that edit before checkout can materialize remote data.
    if (await git.hasUncommittedChanges()) return { conflicts: [], deferred: true };
    this.startProgress("合并远端更改", 1);
    const previousSharedPluginIds = [...this.sharedPluginIds];
    const merge = await git.mergeRemote();
    this.advanceProgress();
    if (merge.conflicts.length) return { conflicts: merge.conflicts, deferred: false };
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const enabledStateChanged = await this.applySharedPluginState(vault);
    this.notifySharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
    await this.materializeRemoteAttachments(manifestBeforeRemote, await readManifest(vault));
    await pruneEmptyManagedFolders(vault, this.app.vault.configDir);
    return { conflicts: [], deferred: false };
  }

  private async ensureSharedPluginState(vault: BinaryVault): Promise<void> {
    const existing = await readSharedPluginState(vault);
    if (existing !== undefined) return;
    const enabled = (await readCommunityPluginIds(vault, this.app.vault.configDir)).filter((id) => this.sharedPluginIds.includes(id));
    await writeSharedPluginState(vault, enabled);
  }

  private async syncSharedPluginStateBeforeCommit(vault: BinaryVault): Promise<void> {
    const enabled = (await readCommunityPluginIds(vault, this.app.vault.configDir)).filter((id) => this.sharedPluginIds.includes(id));
    await writeSharedPluginState(vault, enabled);
  }

  private async applySharedPluginState(vault: BinaryVault): Promise<boolean> {
    const state = await readSharedPluginState(vault);
    if (state === undefined) {
      await this.ensureSharedPluginState(vault);
      return false;
    }
    this.internalCommunityPluginWriteDepth += 1;
    try {
      return await applySharedPluginStateToVault(vault, this.app.vault.configDir, this.sharedPluginIds, state);
    } finally {
      this.internalCommunityPluginWriteDepth -= 1;
    }
  }

  private notifySharedPluginChange(before: readonly string[], after: readonly string[], enabledStateChanged = false): void {
    if (!enabledStateChanged && before.length === after.length && before.every((id, index) => id === after[index])) return;
    this.callbacks.onNotice("公共插件文件和启用状态已同步。请重启 Obsidian 以加载变更。");
  }

  private deferForLocalChanges(): void {
    this.progress = undefined;
    this.lastError = "";
    this.setState("local-changes");
  }

  private enterConflict(conflicts: string[], notify = true): void {
    this.progress = undefined;
    this.lastError = `待解决的 Git 冲突：${conflicts.join(", ")}`;
    if (notify) this.callbacks.onNotice(`检测到 Git 冲突：${conflicts.join(", ")}。已停止推送，请先解决冲突。`);
    this.setState("conflict");
  }

  private async prepareAttachments(pendingNotes: ReadonlySet<string>, pendingAssets: ReadonlySet<string>, forceFullScan = false): Promise<boolean> {
    const vault = this.createVault();
    const manifest = await readManifest(vault);
    let next = manifest;
    for (const path of pendingAssets) {
      const normalized = normalizeVaultPath(path);
      if (isAssetPath(normalized) && !(this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) && next.files[normalized]) {
        next = removeManifestEntry(next, normalized);
      }
    }
    if (forceFullScan) {
      for (const path of Object.keys(next.files)) {
        if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) next = removeManifestEntry(next, path);
      }
    }
    const discovered = await this.collectAttachmentCandidates(pendingNotes, pendingAssets, forceFullScan);
    const candidates = forceFullScan
      ? new Set([...discovered].filter((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        const normalizedPath = normalizeVaultPath(file.path);
        if (!isAssetPath(file.path) && !pendingAssets.has(normalizedPath)) return false;
        const namedHash = hashFromAssetPath(normalizedPath);
        const entry = manifest.files[normalizedPath];
        return pendingAssets.has(normalizedPath)
          || !namedHash
          || !entry
          || entry.sha256 !== namedHash
          || entry.size !== file.stat.size;
      }))
      : discovered;
    this.logger.debug("Attachment candidates selected", { count: candidates.size, fullScan: forceFullScan, pendingAssets: pendingAssets.size, pendingNotes: pendingNotes.size });
    if (!candidates.size) {
      const manifestMissing = !(await vault.exists(MANIFEST_PATH));
      if (next !== manifest || manifestMissing) await writeManifest(vault, next);
      return next !== manifest || manifestMissing;
    }

    const plans: AttachmentPlan[] = [];
    const knownObjects = new Set(Object.values(next.files).map((entry) => `${entry.sha256}:${entry.size}`));
    this.startProgress(forceFullScan ? "筛选待规范附件" : "检查改动附件", candidates.size);
    for (const sourcePath of candidates) {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile) || (!isAssetPath(file.path) && !pendingAssets.has(normalizeVaultPath(file.path)))) {
        this.advanceProgress(sourcePath);
        continue;
      }
      const normalizedSource = normalizeVaultPath(file.path);
      const current = next.files[normalizedSource];
      const namedHash = hashFromAssetPath(normalizedSource) ?? legacyHashFromAssetPath(normalizedSource);
      const isExplicitlyDirty = pendingAssets.has(normalizedSource);
      const trustedNamedHash = !isExplicitlyDirty
        && namedHash
        && current?.sha256 === namedHash
        && current.size === file.stat.size;
      let hash: string | undefined = trustedNamedHash ? namedHash : undefined;
      let size = current?.size;
      let data: ArrayBuffer | undefined;
      if (!hash || size === undefined) {
        const readStartedAt = Date.now();
        this.logger.debug("Attachment read started", { path: normalizedSource, expectedSize: size });
        data = await vault.read(normalizedSource);
        hash = await sha256Hex(data);
        size = data.byteLength;
        this.logger.debug("Attachment read completed", { path: normalizedSource, size, durationMs: Date.now() - readStartedAt, hash });
      }
      const targetPath = assetPathForHash(hash, file.extension);
      const objectId = `${hash}:${size}`;
      const requiresUpload = !knownObjects.has(objectId);
      if (requiresUpload) knownObjects.add(objectId);
      plans.push({ sourcePath: normalizedSource, targetPath, hash, size, mime: this.mime(targetPath), data, requiresUpload });
      this.advanceProgress(normalizedSource);
    }

    const uploads = plans.filter((plan) => plan.requiresUpload);
    if (uploads.length) {
      const s3 = new S3Transport(this.settings(), this.logger);
      this.startProgress("上传新附件", uploads.length);
      for (const plan of uploads) {
        const uploadStartedAt = Date.now();
        this.logger.debug("Attachment upload started", { path: plan.sourcePath, hash: plan.hash, size: plan.size, mime: plan.mime });
        const data = plan.data ?? await vault.read(plan.sourcePath);
        if (data.byteLength !== plan.size || await sha256Hex(data) !== plan.hash) {
          this.logger.error("Attachment changed before upload", { path: plan.sourcePath, expectedSize: plan.size, actualSize: data.byteLength, hash: plan.hash });
          throw new Error(`附件在同步时发生变化：${plan.sourcePath}`);
        }
        await s3.ensureUploaded(plan.hash, data, plan.mime);
        this.logger.debug("Attachment upload completed", { path: plan.sourcePath, hash: plan.hash, size: plan.size, durationMs: Date.now() - uploadStartedAt });
        this.advanceProgress(plan.sourcePath);
      }
    }

    const renames = new Map<string, string>();
    for (const plan of plans) {
      if (plan.sourcePath !== plan.targetPath) {
        const source = this.app.vault.getAbstractFileByPath(plan.sourcePath);
        if (!(source instanceof TFile)) continue;
        const destination = this.app.vault.getAbstractFileByPath(plan.targetPath);
        this.internalAssetWrites.add(plan.sourcePath);
        this.internalAssetWrites.add(plan.targetPath);
        try {
          if (destination instanceof TFile) {
            const destinationHash = await sha256Hex(await vault.read(plan.targetPath));
            if (destinationHash !== plan.hash) throw new Error(`哈希附件路径已被不同内容占用：${plan.targetPath}`);
            await this.app.fileManager.trashFile(source);
          } else if (destination) {
            throw new Error(`哈希附件路径无法使用：${plan.targetPath}`);
          } else {
            // Links are updated in one batched pass below, independent of user preferences.
            await this.app.vault.rename(source, plan.targetPath);
          }
        } finally {
          this.internalAssetWrites.delete(plan.sourcePath);
          this.internalAssetWrites.delete(plan.targetPath);
        }
        renames.set(plan.sourcePath, plan.targetPath);
        next = removeManifestEntry(next, plan.sourcePath);
      }
      const previous = next.files[plan.targetPath];
      if (!previous || previous.sha256 !== plan.hash || previous.size !== plan.size || previous.mime !== plan.mime) {
        next = updateManifestEntry(next, plan.targetPath, this.manifestEntry(plan));
      }
    }
    const linksChanged = await this.rewriteLinksForRenames(renames);
    const manifestChanged = JSON.stringify(next) !== JSON.stringify(manifest);
    if (manifestChanged) await writeManifest(vault, next);
    return manifestChanged || linksChanged;
  }

  private async collectAttachmentCandidates(pendingNotes: ReadonlySet<string>, pendingAssets: ReadonlySet<string>, fullScan: boolean): Promise<Set<string>> {
    const candidates = new Set([...pendingAssets].map(normalizeVaultPath));
    if (fullScan) {
      for (const file of this.app.vault.getFiles()) if (isAssetPath(file.path)) candidates.add(normalizeVaultPath(file.path));
    }
    const notes = [...pendingNotes]
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => file instanceof TFile && file.extension === "md");
    if (!notes.length) return candidates;
    this.startProgress("检查改动笔记", notes.length);
    for (const file of notes) {
      const content = await this.app.vault.read(file);
      for (const path of collectMarkdownReferences(content, file.path)) candidates.add(path);
      this.advanceProgress(file.path);
    }
    return candidates;
  }

  private async insertPastedImages(images: readonly File[], editor: Editor, sourceFile: TFile): Promise<void> {
    try {
      const vault = this.createVault();
      const links: string[] = [];
      for (const image of images) {
        const data = await image.arrayBuffer();
        const hash = await sha256Hex(data);
        const extension = pastedImageExtension(image.name, image.type);
        const targetPath = pastedImageTargetPath(hash, extension, sourceFile.path);
        const destination = this.app.vault.getAbstractFileByPath(targetPath);
        this.internalAssetWrites.add(targetPath);
        try {
          if (destination instanceof TFile) {
            const destinationHash = await sha256Hex(await vault.read(targetPath));
            if (destinationHash !== hash) throw new Error(`哈希附件路径已被不同内容占用：${targetPath}`);
          } else if (destination) {
            throw new Error(`哈希附件路径无法使用：${targetPath}`);
          } else {
            const parent = targetPath.split("/").slice(0, -1).join("/");
            await vault.mkdir(parent);
            await this.app.vault.createBinary(targetPath, data);
          }
        } finally {
          this.internalAssetWrites.delete(targetPath);
        }
        links.push(`![[${targetPath}]]`);
        if (isAssetPath(targetPath)) this.pendingAssets.add(targetPath);
      }
      editor.replaceSelection(links.join("\n"));
      if (links.some((link) => link.startsWith("![[assets/"))) this.scheduleSync();
    } catch (error) {
      this.callbacks.onNotice(`图片整理失败：${error instanceof Error ? error.message : String(error)}`);
      this.logger.warn("Pasted image organization failed", { source: sourceFile.path, error: String(error) });
    }
  }

  private isStableNoteMove(file: TFile, expectedPath: string, revision: number): boolean {
    return this.fileMoveRevisions.get(file) === revision
      && normalizeVaultPath(file.path) === expectedPath
      && this.app.vault.getAbstractFileByPath(expectedPath) === file;
  }

  private assertStableNoteMove(file: TFile, expectedPath: string, revision: number): void {
    if (!this.isStableNoteMove(file, expectedPath, revision)) throw new Error("笔记在附件迁移期间再次移动，旧迁移任务已取消");
  }

  private async publishPrivateDraft(file: TFile, originalPath: string, moveRevision: number): Promise<void> {
    const currentPath = normalizeVaultPath(file.path);
    if (isPrivatePath(currentPath) || file.extension !== "md") return;
    const currentFile = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(currentFile instanceof TFile)) return;

    this.setState("syncing");
    const vault = this.createVault();
    const originalMarkdown = await this.app.vault.read(currentFile);
    const privateNotes = this.app.vault.getMarkdownFiles().filter((note) => isPrivatePath(note.path));
    const pendingNotes = [...this.pendingDraftPublications.values()].filter(({ file: pending }) => pending !== file);
    this.startProgress("发布私人草稿", privateNotes.length + pendingNotes.length + 1);
    const snapshots: MarkdownSnapshot[] = [];
    for (const note of privateNotes) {
      snapshots.push({ path: normalizeVaultPath(note.path), content: await this.app.vault.read(note) });
      this.advanceProgress(note.path);
    }
    for (const pending of pendingNotes) {
      const pendingPath = normalizeVaultPath(pending.file.path);
      const pendingFile = this.app.vault.getAbstractFileByPath(pendingPath);
      if (!(pendingFile instanceof TFile) || pendingFile.extension !== "md") continue;
      snapshots.push({ path: pending.originalPath, content: await this.app.vault.read(pendingFile) });
      this.advanceProgress(pendingPath);
    }

    const createdTargets: string[] = [];
    const removedSources = new Set<string>();
    let plan: PrivateDraftPublicationPlan | undefined;
    let noteUpdated = false;
    try {
      this.assertStableNoteMove(file, currentPath, moveRevision);
      plan = await planPrivateDraftPublication(vault, originalMarkdown, originalPath, currentPath, snapshots);
      this.assertStableNoteMove(file, currentPath, moveRevision);
      const materialized = new Set<string>();
      for (const attachment of plan.attachments) {
        if (!attachment.createTarget || materialized.has(attachment.targetPath)) continue;
        this.assertStableNoteMove(file, currentPath, moveRevision);
        this.internalAssetWrites.add(attachment.targetPath);
        try {
          await vault.mkdir(attachment.targetPath.split("/").slice(0, -1).join("/"));
          await this.app.vault.createBinary(attachment.targetPath, attachment.data);
        } finally {
          this.internalAssetWrites.delete(attachment.targetPath);
        }
        this.assertStableNoteMove(file, currentPath, moveRevision);
        materialized.add(attachment.targetPath);
        createdTargets.push(attachment.targetPath);
      }

      if (plan.markdown !== originalMarkdown) {
        this.assertStableNoteMove(file, currentPath, moveRevision);
        this.internalMarkdownWrites.add(currentPath);
        try {
          await this.app.vault.modify(currentFile, plan.markdown);
          noteUpdated = true;
        } finally {
          this.internalMarkdownWrites.delete(currentPath);
        }
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      for (const attachment of plan.attachments) {
        if (!attachment.removeSource) continue;
        this.assertStableNoteMove(file, currentPath, moveRevision);
        const source = this.app.vault.getAbstractFileByPath(attachment.sourcePath);
        if (!(source instanceof TFile)) continue;
        try {
          await this.app.fileManager.trashFile(source);
          removedSources.add(attachment.sourcePath);
        } catch (error) {
          this.logger.warn("Unable to remove published private attachment", { path: attachment.sourcePath, error: String(error) });
        }
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      this.assertStableNoteMove(file, currentPath, moveRevision);
      this.advanceProgress(currentPath);
      this.progress = undefined;
      this.lastError = "";
      this.pendingFiles.add(currentPath);
      for (const attachment of plan.attachments) this.pendingAssets.add(attachment.targetPath);
      this.scheduleSync();
      if (plan.attachments.length) {
        this.callbacks.onNotice(`私人草稿已发布，并整理 ${plan.attachments.length} 个附件。`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (plan) {
        for (const attachment of plan.attachments) {
          if (removedSources.has(attachment.sourcePath) && !(await vault.exists(attachment.sourcePath))) {
            await vault.write(attachment.sourcePath, attachment.data).catch(() => undefined);
          }
        }
      }
      const stable = this.isStableNoteMove(file, currentPath, moveRevision);
      if (noteUpdated && stable) {
        this.internalMarkdownWrites.add(currentPath);
        try {
          await this.app.vault.modify(currentFile, originalMarkdown);
        } finally {
          this.internalMarkdownWrites.delete(currentPath);
        }
      }
      for (const targetPath of createdTargets.reverse()) {
        const target = this.app.vault.getAbstractFileByPath(targetPath);
        if (target instanceof TFile) await this.app.fileManager.trashFile(target).catch(() => undefined);
        else if (await vault.exists(targetPath)) await vault.remove(targetPath).catch(() => undefined);
      }
      let rolledBack = false;
      if (stable && this.app.vault.getAbstractFileByPath(currentPath) instanceof TFile && !(await vault.exists(originalPath))) {
        this.internalDraftNoteMoves.add(currentPath);
        this.internalDraftNoteMoves.add(normalizeVaultPath(originalPath));
        try {
          await this.app.vault.rename(currentFile, normalizeVaultPath(originalPath));
          rolledBack = true;
        } finally {
          this.internalDraftNoteMoves.delete(currentPath);
          this.internalDraftNoteMoves.delete(normalizeVaultPath(originalPath));
        }
      }
      throw new Error(rolledBack
        ? `${reason}；笔记已移回“私人笔记”`
        : `${reason}；无法自动移回原路径，请检查当前笔记位置`);
    }
  }

  private async privatizePublicNote(file: TFile, originalPath: string, moveRevision: number): Promise<void> {
    const currentPath = normalizeVaultPath(file.path);
    if (!isPrivatePath(currentPath) || file.extension !== "md") return;
    const currentFile = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(currentFile instanceof TFile)) return;

    this.setState("syncing");
    const vault = this.createVault();
    const originalMarkdown = await this.app.vault.read(currentFile);
    const referenceNotes = this.app.vault.getMarkdownFiles().filter((note) => note !== currentFile && !isTrashPath(note.path));
    const pendingNotes = [...this.pendingNotePrivatizations.values()].filter(({ file: pending }) => pending !== file);
    this.startProgress("移入私人笔记", referenceNotes.length + pendingNotes.length + 1);
    const snapshots: MarkdownSnapshot[] = [];
    for (const note of referenceNotes) {
      snapshots.push({ path: normalizeVaultPath(note.path), content: await this.app.vault.read(note) });
      this.advanceProgress(note.path);
    }
    for (const pending of pendingNotes) {
      const pendingPath = normalizeVaultPath(pending.file.path);
      const pendingFile = this.app.vault.getAbstractFileByPath(pendingPath);
      if (!(pendingFile instanceof TFile) || pendingFile.extension !== "md") continue;
      snapshots.push({ path: pending.originalPath, content: await this.app.vault.read(pendingFile) });
      this.advanceProgress(pendingPath);
    }

    const createdTargets: string[] = [];
    const removedSources = new Set<string>();
    let plan: PrivateDraftPublicationPlan | undefined;
    let noteUpdated = false;
    try {
      this.assertStableNoteMove(file, currentPath, moveRevision);
      plan = await planPublicNotePrivatization(vault, originalMarkdown, originalPath, currentPath, snapshots);
      this.assertStableNoteMove(file, currentPath, moveRevision);
      const materialized = new Set<string>();
      for (const attachment of plan.attachments) {
        if (!attachment.createTarget || materialized.has(attachment.targetPath)) continue;
        this.assertStableNoteMove(file, currentPath, moveRevision);
        await vault.mkdir(attachment.targetPath.split("/").slice(0, -1).join("/"));
        await this.app.vault.createBinary(attachment.targetPath, attachment.data);
        this.assertStableNoteMove(file, currentPath, moveRevision);
        materialized.add(attachment.targetPath);
        createdTargets.push(attachment.targetPath);
      }

      if (plan.markdown !== originalMarkdown) {
        this.assertStableNoteMove(file, currentPath, moveRevision);
        this.internalMarkdownWrites.add(currentPath);
        try {
          await this.app.vault.modify(currentFile, plan.markdown);
          noteUpdated = true;
        } finally {
          this.internalMarkdownWrites.delete(currentPath);
        }
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      for (const attachment of plan.attachments) {
        if (!attachment.removeSource) continue;
        this.assertStableNoteMove(file, currentPath, moveRevision);
        const source = this.app.vault.getAbstractFileByPath(attachment.sourcePath);
        if (!(source instanceof TFile)) continue;
        this.internalAssetWrites.add(attachment.sourcePath);
        try {
          await this.app.fileManager.trashFile(source);
          removedSources.add(attachment.sourcePath);
        } catch (error) {
          this.logger.warn("Unable to remove privatized public attachment", { path: attachment.sourcePath, error: String(error) });
        } finally {
          this.internalAssetWrites.delete(attachment.sourcePath);
        }
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      this.assertStableNoteMove(file, currentPath, moveRevision);
      this.advanceProgress(currentPath);
      this.progress = undefined;
      this.lastError = "";
      this.pendingFiles.add(normalizeVaultPath(originalPath));
      for (const sourcePath of removedSources) this.pendingAssets.add(sourcePath);
      this.scheduleSync();
      if (plan.attachments.length) {
        this.callbacks.onNotice(`笔记已移入“私人笔记”，并整理 ${plan.attachments.length} 个附件。`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (plan) {
        for (const attachment of plan.attachments) {
          if (removedSources.has(attachment.sourcePath) && !(await vault.exists(attachment.sourcePath))) {
            await vault.write(attachment.sourcePath, attachment.data).catch(() => undefined);
          }
        }
      }
      const stable = this.isStableNoteMove(file, currentPath, moveRevision);
      if (noteUpdated && stable) {
        this.internalMarkdownWrites.add(currentPath);
        try {
          await this.app.vault.modify(currentFile, originalMarkdown);
        } finally {
          this.internalMarkdownWrites.delete(currentPath);
        }
      }
      for (const targetPath of createdTargets.reverse()) {
        const target = this.app.vault.getAbstractFileByPath(targetPath);
        if (target instanceof TFile) await this.app.fileManager.trashFile(target).catch(() => undefined);
        else if (await vault.exists(targetPath)) await vault.remove(targetPath).catch(() => undefined);
      }
      let rolledBack = false;
      if (stable && this.app.vault.getAbstractFileByPath(currentPath) instanceof TFile && !(await vault.exists(originalPath))) {
        this.internalDraftNoteMoves.add(currentPath);
        this.internalDraftNoteMoves.add(normalizeVaultPath(originalPath));
        try {
          await this.app.vault.rename(currentFile, normalizeVaultPath(originalPath));
          rolledBack = true;
        } finally {
          this.internalDraftNoteMoves.delete(currentPath);
          this.internalDraftNoteMoves.delete(normalizeVaultPath(originalPath));
        }
      }
      throw new Error(rolledBack
        ? `${reason}；笔记已移回原公共路径`
        : `${reason}；无法自动移回原路径，请检查当前笔记位置`);
    }
  }

  private manifestEntry(plan: AttachmentPlan): AssetManifestEntry {
    return {
      sha256: plan.hash,
      size: plan.size,
      mime: plan.mime,
      uploadedAt: new Date().toISOString(),
      uploadedBy: this.settings().gitUsername.trim() || "unknown"
    };
  }

  private async rewriteLinksForRenames(renames: ReadonlyMap<string, string>): Promise<boolean> {
    if (!renames.size) return false;
    const markdownFiles = this.app.vault.getMarkdownFiles();
    this.startProgress("更新附件链接", markdownFiles.length);
    let changed = false;
    for (const file of markdownFiles) {
      const original = await this.app.vault.read(file);
      let updated = original;
      for (const [oldPath, newPath] of renames) updated = rewriteAssetReferences(updated, file.path, oldPath, newPath);
      if (updated !== original) {
        const path = normalizeVaultPath(file.path);
        this.internalMarkdownWrites.add(path);
        try {
          await this.app.vault.modify(file, updated);
        } finally {
          this.internalMarkdownWrites.delete(path);
        }
        changed = true;
      }
      this.advanceProgress(file.path);
    }
    return changed;
  }

  private async materializeRemoteAttachments(before: AssetManifest, after: AssetManifest): Promise<void> {
    const entries = Object.entries(after.files).filter(([path, entry]) => {
      const previous = before.files[path];
      const localFileExists = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
      return shouldMaterializeRemoteAttachment(previous, entry, localFileExists);
    });
    if (!entries.length) return;
    const vault = this.createVault();
    const s3 = new S3Transport(this.settings(), this.logger);
    const username = this.settings().gitUsername.trim() || "unknown";
    const deferred: string[] = [];
    this.startProgress("下载远端附件", entries.length);
    for (const [path, entry] of entries) {
      try {
        const localStat = await vault.stat(path);
        const localHashNameMatches = hashFromAssetPath(path) === entry.sha256 && localStat?.type === "file" && localStat.size === entry.size;
        if (!localHashNameMatches && shouldDeferLargeMobileAttachment(entry.size, Platform.isMobile)) {
          this.logger.warn("Large mobile attachment deferred", { path, hash: entry.sha256, size: entry.size, limit: MOBILE_ATTACHMENT_DOWNLOAD_LIMIT });
          deferred.push(path);
          this.advanceProgress(path);
          continue;
        }
        let matches = localHashNameMatches;
        if (!matches && localStat?.type === "file") {
          const local = await vault.read(path);
          matches = await sha256Hex(local) === entry.sha256;
        }
        if (matches) {
          this.advanceProgress(path);
          continue;
        }
        if (shouldProtectMismatchedLocalAttachment(localStat?.type === "file", entry.uploadedBy, username)) {
          this.logger.warn("Local attachment differs from same-user manifest entry", { path });
          this.advanceProgress(path);
          continue;
        }
        const downloadStartedAt = Date.now();
        this.logger.debug("Attachment download started", { path, hash: entry.sha256, expectedSize: entry.size });
        const data = await s3.download(entry.sha256);
        if (data.byteLength !== entry.size) throw new Error(`附件大小校验失败：${path}`);
        this.logger.debug("Attachment Vault write started", { path, size: data.byteLength });
        await vault.write(path, data);
        this.logger.debug("Attachment Vault write completed", { path, size: data.byteLength, durationMs: Date.now() - downloadStartedAt });
        this.logger.debug("Attachment download completed", { path, hash: entry.sha256, size: data.byteLength, durationMs: Date.now() - downloadStartedAt });
      } catch (error) {
        if (error instanceof S3NotFoundError) {
          this.logger.warn("Remote attachment object is missing", { path, hash: entry.sha256 });
          this.advanceProgress(path);
          continue;
        }
        this.logger.error("Attachment download failed", { path, hash: entry.sha256, error: String(error) });
        throw error;
      }
      this.advanceProgress(path);
      if (Platform.isMobile) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    if (deferred.length) throw new Error(`移动端暂不下载超过 ${Math.round(MOBILE_ATTACHMENT_DOWNLOAD_LIMIT / (1024 * 1024))} MB 的附件：${deferred.join(", ")}。请使用桌面端同步后再在手机端继续。`);
  }

  private mime(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase();
    return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown" } as Record<string, string>)[ext ?? ""] ?? "application/octet-stream";
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.callbacks.onSnapshot(this.snapshot());
  }

  private startProgress(phase: string, total: number): void {
    this.logger.debug("Sync phase started", { phase, total });
    this.progress = { phase, current: 0, total, item: undefined };
    this.callbacks.onSnapshot(this.snapshot());
  }

  private updateProgress(phase: string, current: number, total: number, item?: string): void {
    const safeTotal = Math.max(total, 1);
    this.progress = {
      phase,
      current: Math.min(Math.max(current, 0), safeTotal),
      total: safeTotal,
      item
    };
    this.callbacks.onSnapshot(this.snapshot());
  }

  private advanceProgress(item?: string): void {
    if (!this.progress) return;
    this.progress = {
      ...this.progress,
      current: Math.min(this.progress.current + 1, this.progress.total),
      item
    };
    this.logger.debug("Sync progress advanced", { phase: this.progress.phase, current: this.progress.current, total: this.progress.total, item });
    this.callbacks.onSnapshot(this.snapshot());
  }

  private isOffline(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /network|offline|fetch|timeout|failed to fetch|ECONN|ENOTFOUND/i.test(message);
  }
}
