import { FileSystemAdapter, TFile, type App } from "obsidian";
import { MANIFEST_PATH, DEFAULT_BRANCH, PRIVATE_FOLDER } from "./constants";
import { sha256Hex } from "./crypto";
import { GitRepository, isPushReconciliationError, type ConflictEditorSession, type ConflictResolution } from "./git";
import { PluginLogger } from "./logger";
import { createEmptyManifest, readManifest, removeManifestEntry, updateManifestEntry, writeManifest } from "./manifest";
import { S3NotFoundError, S3Transport } from "./s3";
import type { AssetManifest, AssetManifestEntry, Logger, SyncProgress, SyncSnapshot, SyncState, TeamCoreSettings } from "./types";
import { assetPathForHash, collectMarkdownReferences, createVaultAdapter, hashFromAssetPath, isAssetPath, isConfigPath, isManagedPath, isPrivatePath, legacyHashFromAssetPath, normalizeVaultPath, rewriteAssetReferences, type BinaryVault } from "./vault";
import { readSharedPluginIds, writeSharedPluginIds } from "./shared-plugins";

const MAX_PUSH_RECONCILIATION_RETRIES = 2;

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

export class SyncCoordinator {
  private state: SyncState = "uninitialized";
  private pendingFiles = new Set<string>();
  private pendingAssets = new Set<string>();
  private internalMarkdownWrites = new Set<string>();
  private internalAssetWrites = new Set<string>();
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

  start(): void {
    this.stop();
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

  markFileRenamed(file: TFile, oldPath: string): void {
    const previous = normalizeVaultPath(oldPath);
    const current = normalizeVaultPath(file.path);
    if (this.internalAssetWrites.has(previous) || this.internalAssetWrites.has(current)) {
      this.internalAssetWrites.delete(previous);
      this.internalAssetWrites.delete(current);
      return;
    }
    if (isAssetPath(previous)) this.pendingAssets.add(previous);
    else if (isManagedPath(previous, this.app.vault.configDir, this.sharedPluginIds) && !isPrivatePath(previous) && previous !== MANIFEST_PATH) this.pendingFiles.add(previous);
    this.markFileChanged(file);
    if (this.pendingFiles.has(previous) || this.pendingAssets.has(previous)) this.scheduleSync();
  }

  async prepareLocalVault(): Promise<void> {
    const vault = createVaultAdapter(this.app.vault.adapter);
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const existing = await vault.stat(PRIVATE_FOLDER);
    if (existing && existing.type !== "folder") throw new Error(`无法创建私人笔记文件夹：${PRIVATE_FOLDER} 已被文件占用`);
    await vault.mkdir(PRIVATE_FOLDER);
  }

  async setSharedPluginIds(ids: readonly string[]): Promise<void> {
    const vault = createVaultAdapter(this.app.vault.adapter);
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
    const vault = createVaultAdapter(this.app.vault.adapter);
    try {
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
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
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
      return git.getConflictEditorSession();
    });
  }

  async resolveConflicts(resolutions: readonly ConflictResolution[]): Promise<SyncSnapshot> {
    await this.runExclusive(async () => {
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
      await git.resolveConflicts(resolutions);
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
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, settings, this.logger, this.app.vault.configDir, this.sharedPluginIds);
      const remote = await git.remoteInfo();
      if (Object.keys(remote.heads).length > 0) throw new Error("远端仓库已有提交，请使用“从远端知识库导入”或“立即同步”，不能重复初始化");
      this.startProgress("准备本地仓库", 1);
      await git.init();
      this.advanceProgress();
      await git.ensureRemote();
      await git.ensureGitignore();
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
    const vault = createVaultAdapter(this.app.vault.adapter);
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
    const files = this.app.vault.getFiles().filter((file) => {
      const path = normalizeVaultPath(file.path);
      return (isAssetPath(path) || isManagedPath(path, this.app.vault.configDir, this.sharedPluginIds)) && !isPrivatePath(path);
    });
    const info = await git.remoteInfo();
    return {
      localRepository: await git.exists(),
      localHasManagedFiles: files.length > 0,
      localRemoteUrl: await git.remoteUrl(),
      remoteHasCommits: Object.keys(info.heads).length > 0
    };
  }

  async cloneRemote(force = false): Promise<void> {
    this.setState("syncing");
    try {
      if (force) await this.clearForRemoteClone();
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
      await git.clone();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      await this.materializeRemoteAttachments(createEmptyManifest(), await readManifest(vault));
      this.lastSyncAt = Date.now();
      this.lastError = "";
      this.progress = undefined;
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
    const files = this.app.vault.getFiles()
      .filter((file) => {
        const path = normalizeVaultPath(file.path);
        return !isConfigPath(path, this.app.vault.configDir) && !isPrivatePath(path);
      })
      .sort((a, b) => b.path.length - a.path.length);
    for (const file of files) await this.app.vault.delete(file);
    const adapter = createVaultAdapter(this.app.vault.adapter);
    if (await adapter.exists(".git")) await adapter.rmdir(".git", true);
  }

  private async executeRemoteClear(): Promise<RemoteClearResult> {
    this.progress = undefined;
    this.setState("syncing");
    try {
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, this.settings(), this.logger, this.app.vault.configDir, this.sharedPluginIds);
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
    const pendingNotes = new Set(this.pendingFiles);
    const pendingAssets = new Set(this.pendingAssets);
    const forceFullAttachmentScan = this.fullAttachmentScanPending;
    try {
      const settings = this.settings();
      const vault = createVaultAdapter(this.app.vault.adapter);
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = new GitRepository(vault, settings, this.logger, this.app.vault.configDir, this.sharedPluginIds);
      if (!(await git.exists())) {
        this.pendingFiles.clear();
        this.pendingAssets.clear();
        this.fullAttachmentScanPending = false;
        this.progress = undefined;
        this.setState("uninitialized");
        return;
      }
      const existingConflicts = await git.conflictedFiles();
      if (existingConflicts.length) {
        this.enterConflict(existingConflicts, false);
        return;
      }
      this.pendingFiles.clear();
      this.pendingAssets.clear();
      this.fullAttachmentScanPending = false;
      await git.ensureRemote();
      await git.ensureGitignore();
      const changed = await this.prepareAttachments(pendingNotes, pendingAssets, forceFullAttachmentScan);
      const hasGitChanges = await git.hasUncommittedChanges();
      if (changed || pendingNotes.size || hasGitChanges) {
        this.startProgress("提交本地更改", 1);
        await git.commit(`Update vault: ${pendingNotes.size || 1} files`);
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
      this.setState(this.pendingFiles.size || this.pendingAssets.size ? "local-changes" : "synced");
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
    const merge = await git.mergeRemote();
    this.advanceProgress();
    if (merge.conflicts.length) return { conflicts: merge.conflicts, deferred: false };
    await this.materializeRemoteAttachments(manifestBeforeRemote, await readManifest(vault));
    return { conflicts: [], deferred: false };
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
    const vault = createVaultAdapter(this.app.vault.adapter);
    const manifest = await readManifest(vault);
    let next = manifest;
    for (const path of pendingAssets) {
      const normalized = normalizeVaultPath(path);
      if (isAssetPath(normalized) && !(this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) && next.files[normalized]) {
        next = removeManifestEntry(next, normalized);
      }
    }
    const discovered = await this.collectAttachmentCandidates(pendingNotes, pendingAssets, forceFullScan);
    const candidates = forceFullScan
      ? new Set([...discovered].filter((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !isAssetPath(file.path)) return false;
        const normalizedPath = normalizeVaultPath(file.path);
        const namedHash = hashFromAssetPath(normalizedPath);
        const entry = manifest.files[normalizedPath];
        return pendingAssets.has(normalizedPath)
          || !namedHash
          || !entry
          || entry.sha256 !== namedHash
          || entry.size !== file.stat.size;
      }))
      : discovered;
    if (!candidates.size) {
      if (next !== manifest) await writeManifest(vault, next);
      return next !== manifest;
    }

    const plans: AttachmentPlan[] = [];
    const knownObjects = new Set(Object.values(next.files).map((entry) => `${entry.sha256}:${entry.size}`));
    this.startProgress(forceFullScan ? "筛选待规范附件" : "检查改动附件", candidates.size);
    for (const sourcePath of candidates) {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile) || !isAssetPath(file.path)) {
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
        data = await vault.read(normalizedSource);
        hash = await sha256Hex(data);
        size = data.byteLength;
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
        const data = plan.data ?? await vault.read(plan.sourcePath);
        if (data.byteLength !== plan.size || await sha256Hex(data) !== plan.hash) throw new Error(`附件在同步时发生变化：${plan.sourcePath}`);
        await s3.ensureUploaded(plan.hash, data, plan.mime);
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
            await this.app.vault.delete(source);
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
    const candidates = new Set([...pendingAssets].map(normalizeVaultPath).filter(isAssetPath));
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
    const vault = createVaultAdapter(this.app.vault.adapter);
    const s3 = new S3Transport(this.settings(), this.logger);
    const username = this.settings().gitUsername.trim() || "unknown";
    this.startProgress("下载远端附件", entries.length);
    for (const [path, entry] of entries) {
      const localStat = await vault.stat(path);
      const localHashNameMatches = hashFromAssetPath(path) === entry.sha256 && localStat?.type === "file" && localStat.size === entry.size;
      const local = localHashNameMatches ? undefined : localStat?.type === "file" ? await vault.read(path) : undefined;
      const matches = localHashNameMatches || Boolean(local && await sha256Hex(local) === entry.sha256);
      if (matches) {
        this.advanceProgress(path);
        continue;
      }
      if (shouldProtectMismatchedLocalAttachment(localStat?.type === "file", entry.uploadedBy, username)) {
        this.logger.warn("Local attachment differs from same-user manifest entry", { path });
        this.advanceProgress(path);
        continue;
      }
      try {
        const data = await s3.download(entry.sha256);
        if (data.byteLength !== entry.size) throw new Error(`附件大小校验失败：${path}`);
        await vault.write(path, data);
      } catch (error) {
        if (error instanceof S3NotFoundError) {
          this.advanceProgress(path);
          continue;
        }
        throw error;
      }
      this.advanceProgress(path);
    }
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
    this.progress = { phase, current: 0, total, item: undefined };
    this.callbacks.onSnapshot(this.snapshot());
  }

  private advanceProgress(item?: string): void {
    if (!this.progress) return;
    this.progress = {
      ...this.progress,
      current: Math.min(this.progress.current + 1, this.progress.total),
      item
    };
    this.callbacks.onSnapshot(this.snapshot());
  }

  private isOffline(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /network|offline|fetch|timeout|failed to fetch|ECONN|ENOTFOUND/i.test(message);
  }
}
