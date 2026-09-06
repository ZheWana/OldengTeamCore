import { FileSystemAdapter, Platform, TFile, TFolder, type App, type Editor } from "obsidian";
import { createSHA256 } from "hash-wasm";
import { FILE_AUTHORS_PATH, MANIFEST_PATH, DEFAULT_BRANCH, PRIVATE_FOLDER } from "./constants";
import { sha256Hex } from "./crypto";
import { GitRepository, isPushReconciliationError, type ConflictEditorSession, type ConflictResolution } from "./git";
import { PluginLogger } from "./logger";
import { createEmptyManifest, readManifest, removeManifestEntry, updateManifestEntry, validateManifest, writeManifest } from "./manifest";
import { createAttachmentStore } from "./attachment-store";
import { S3_CHUNKED_DOWNLOAD_THRESHOLD, S3NotFoundError } from "./s3";
import { PrivateNotesSynchronizer, type PrivateSyncResult } from "./private-sync";
import { mimeFromPath } from "./mime";
import type { AssetManifest, AssetManifestEntry, AssetRetentionRecord, LocalChangeCategory, LocalChangeItem, LocalChangeSnapshot, LocalChangeStatus, Logger, PendingPublicMove, PrivateSyncState, SyncProgress, SyncSnapshot, SyncState, TeamCoreSettings } from "./types";
import { assetPathForHash, collectMarkdownReferences, collectPrivateAttachmentReferences, createVaultAdapter, ensureAssetsExcluded, hashFromAssetPath, isAssetPath, isConfigPath, isManagedPath, isPrivateAssetPath, isPrivatePath, isTrashPath, legacyHashFromAssetPath, listRemoteOverwriteFiles, normalizeVaultPath, pastedImageExtension, pastedImageTargetPath, planFastRemoteReset, pruneEmptyManagedFolders, readVaultInChunks, rewriteAssetReferences, VAULT_TRANSFER_CHUNK_SIZE, type BinaryVault } from "./vault";
import { applySharedPluginState as applySharedPluginStateToVault, isCommunityPluginStatePath, readCommunityPluginIds, readSharedPluginIds, readSharedPluginState, SHARED_PLUGIN_STATE_PATH, writeSharedPluginIds, writeSharedPluginState } from "./shared-plugins";

const MAX_PUSH_RECONCILIATION_RETRIES = 2;
export interface SyncCallbacks {
  onSnapshot(snapshot: SyncSnapshot): void;
  onNotice(message: string): void;
  onRestartRequired(): void;
  onPrivateSyncState(state: PrivateSyncState): void | Promise<void>;
  onPendingDeletionPaths?(paths: string[]): void | Promise<void>;
  onPendingDeletionFolders?(folders: string[]): void | Promise<void>;
  onPendingPublicMoves?(moves: PendingPublicMove[]): void | Promise<void>;
  confirmRemoteDeletions?(groups: RemoteDeletionGroups): Promise<RemoteDeletionDecision>;
  onAssetRetention?(records: AssetRetentionRecord[]): void | Promise<void>;
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

/** Deletions have materially different user impact: knowledge content versus team environment. */
export interface RemoteDeletionGroups {
  knowledgePaths: string[];
  configurationPaths: string[];
  /** Folder roots captured by Obsidian's delete event, for whole-folder undo. */
  folders: string[];
  moves: PendingPublicMove[];
}

export interface RemoteDeletionDecision {
  confirmed: boolean;
  /** Deleted paths selected for restoration from the current Git HEAD. */
  restorePaths: string[];
}

export interface PublicFolderDeletionPaths {
  managedPaths: string[];
  assetPaths: string[];
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

export function classifyPublicLocalChange(path: string, configDir: string): LocalChangeCategory {
  const normalized = normalizeVaultPath(path);
  if (normalized === MANIFEST_PATH) return "attachments";
  if (normalized === ".gitignore" || normalized === FILE_AUTHORS_PATH || normalized === SHARED_PLUGIN_STATE_PATH
    || isConfigPath(normalized, configDir)) return "settings";
  if (normalized.endsWith(".md")) return "documents";
  return "other";
}

export function groupRemoteDeletionPaths(paths: readonly string[], configDir: string, folders: readonly string[] = []): RemoteDeletionGroups {
  const knowledgePaths: string[] = [];
  const configurationPaths: string[] = [];
  for (const candidate of [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort()) {
    if (candidate === ".gitignore" || candidate === FILE_AUTHORS_PATH || candidate === SHARED_PLUGIN_STATE_PATH
      || isConfigPath(candidate, configDir)) configurationPaths.push(candidate);
    else knowledgePaths.push(candidate);
  }
  const allPaths = new Set([...knowledgePaths, ...configurationPaths]);
  const normalizedFolders = [...new Set(folders.map(normalizeVaultPath).filter(Boolean))]
    .filter((folder) => [...allPaths].some((path) => path === folder || path.startsWith(`${folder}/`)))
    .sort();
  return { knowledgePaths, configurationPaths, folders: normalizedFolders, moves: [] };
}

/** Coalesce a chain such as A → B → C into one user-visible A → C move. */
export function mergePendingPublicMove(moves: readonly PendingPublicMove[], sourcePath: string, targetPath: string): PendingPublicMove[] {
  const from = normalizeVaultPath(sourcePath);
  const to = normalizeVaultPath(targetPath);
  if (!from || !to || from === to) return [...moves];
  const next = new Map(moves.map((move) => [move.from, move]));
  let origin = from;
  for (const move of next.values()) {
    if (move.to === from) {
      origin = move.from;
      next.delete(move.from);
      break;
    }
  }
  next.set(origin, { from: origin, to });
  return [...next.values()].filter((move) => move.from !== move.to).sort((left, right) => left.from.localeCompare(right.from));
}

/** Classify a deleted folder's already-indexed descendants in one batch. */
export function classifyPublicFolderDeletionPaths(paths: readonly string[], configDir: string, sharedPluginIds: readonly string[]): PublicFolderDeletionPaths {
  const managedPaths: string[] = [];
  const assetPaths: string[] = [];
  for (const path of [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort()) {
    if (isAssetPath(path)) assetPaths.push(path);
    else if (isManagedPath(path, configDir, sharedPluginIds)) managedPaths.push(path);
  }
  return { managedPaths, assetPaths };
}

export function classifyPrivateLocalChange(relativePath: string): LocalChangeCategory {
  const normalized = normalizeVaultPath(relativePath);
  if (isPrivateAssetPath(`${PRIVATE_FOLDER}/${normalized}`)) return "attachments";
  if (normalized.endsWith(".md")) return "documents";
  return "other";
}

type AttachmentReferenceCollector = (markdown: string, sourcePath: string) => string[];

async function sha256VaultFile(vault: BinaryVault, path: string, size: number): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  await readVaultInChunks(vault, path, size, async (chunk) => {
    hasher.update(new Uint8Array(chunk));
  });
  return hasher.digest();
}

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

export function shouldProtectMismatchedLocalAttachment(
  localFileExists: boolean,
  uploadedBy: string,
  uploadedFrom: string | undefined,
  installationId: string,
  username: string
): boolean {
  if (!localFileExists) return false;
  // New manifest entries carry a durable installation identity. Only legacy
  // entries without that field fall back to the mutable Git display name.
  return uploadedFrom ? uploadedFrom === installationId : uploadedBy === username;
}

export function shouldTrackVaultEvent(path: string, configDir: string, sharedPluginIds: readonly string[]): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized !== MANIFEST_PATH
    && !isPrivatePath(normalized)
    && (isAssetPath(normalized) || isManagedPath(normalized, configDir, sharedPluginIds));
}

/** Private Vault events are local-only unless the optional private sync is enabled. */
export function shouldTrackPrivateSyncEvent(settings: Pick<TeamCoreSettings, "privateSyncEnabled">): boolean {
  return settings.privateSyncEnabled;
}

/**
 * Vault events and internal writers already identify every managed change in
 * a normal cycle. Use those signals to avoid a redundant whole-vault status
 * scan before staging; the staging operation itself still performs the one
 * authoritative scan when a commit is actually required.
 */
export function shouldCommitManagedChanges(signals: {
  pendingNotes: number;
  attachmentsChanged: boolean;
  gitignoreChanged: boolean;
  sharedPluginStateChanged: boolean;
  recoveryCommitPending?: boolean;
}): boolean {
  return signals.pendingNotes > 0
    || signals.attachmentsChanged
    || signals.gitignoreChanged
    || signals.sharedPluginStateChanged
    || Boolean(signals.recoveryCommitPending);
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
  /** Cached result of the durable HEAD ↔ index public-change journal. */
  private hasPublicStagedChanges = false;
  /** Latest immediate public-index write, awaited by an explicit manual sync. */
  private publicStagePersistence: Promise<void> = Promise.resolve();
  private publicStateCheckGeneration = 0;
  private privateSyncDirty = false;
  /** Persisted, generation-aware private-note event journal. */
  private privatePendingPaths = new Set<string>();
  /** A recovery/import boundary may deliberately request one complete scan. */
  private privateFullScanPending = false;
  /** Serializes durable private event-journal updates. */
  private privateStatePersistence: Promise<void> = Promise.resolve();
  private internalMarkdownWrites = new Set<string>();
  private internalAssetWrites = new Set<string>();
  private internalDraftNoteMoves = new Set<string>();
  private fileMoveRevisions = new WeakMap<TFile, number>();
  private pendingDraftPublications = new Map<symbol, { file: TFile; originalPath: string }>();
  private pendingNotePrivatizations = new Map<symbol, { file: TFile; originalPath: string }>();
  private internalCommunityPluginWriteDepth = 0;
  private debounceTimer: number | undefined;
  private periodicTimer: number | undefined;
  private privateDebounceTimer: number | undefined;
  private privatePeriodicTimer: number | undefined;
  private running: Promise<void> | undefined;
  private lastError = "";
  private lastSyncAt: number | undefined;
  private currentAuthor: string | undefined;
  private progress: SyncProgress | undefined;
  private fullAttachmentScanPending = false;
  private sharedPluginIds: string[] = [];
  private restartRequiredAfterSync = false;
  /** A full attachment reconciliation is scheduled only at recovery boundaries. */
  private recoveryAttachmentCheckComplete = false;
  /** A full public worktree recovery runs once at startup or after an explicit recovery boundary. */
  private publicRecoveryCheckComplete = false;
  /** Forces one authoritative stage/commit after Git restores lost event state. */
  private recoveryCommitPending = false;
  private syncRunSequence = 0;
  private activeSyncRunId: number | undefined;
  /** Paths whose remote bytes could not be materialized in the current session. */
  private remoteAttachmentIssues = new Map<string, string>();
  readonly logger: Logger;

  constructor(private readonly app: App, private readonly settings: () => TeamCoreSettings, private readonly callbacks: SyncCallbacks, logger?: Logger) {
    this.logger = logger ?? new PluginLogger();
    for (const path of settings().privateSyncState.pendingPaths ?? []) this.privatePendingPaths.add(path);
    this.privateFullScanPending = settings().privateSyncState.baselineEstablished !== true;
    this.privateSyncDirty = this.privatePendingPaths.size > 0 || this.privateFullScanPending;
  }

  private createVault(): BinaryVault {
    return createVaultAdapter(this.app.vault.adapter);
  }

  private createRepository(vault: BinaryVault = this.createVault(), settings: TeamCoreSettings = this.settings(), sharedPluginIds: readonly string[] = this.sharedPluginIds): GitRepository {
    return new GitRepository(vault, settings, this.logger, this.app.vault.configDir, sharedPluginIds);
  }

  start(): void {
    this.stop();
    const settings = this.settings();
    if (!settings.autoSync) return;
    if (this.hasPublicStagedChanges || this.pendingFiles.size || this.pendingAssets.size || (this.privateSyncDirty && settings.privateSyncEnabled && settings.privateSyncWithTeam)) {
      this.debounceTimer = window.setTimeout(() => void this.flushDebounce(), this.settings().debounceMs);
    }
    if (this.privateSyncDirty && settings.privateSyncEnabled && !settings.privateSyncWithTeam) {
      this.privateDebounceTimer = window.setTimeout(() => void this.flushPrivateDebounce(), settings.debounceMs);
    }
    this.periodicTimer = window.setInterval(() => void this.runCycle(false), settings.syncIntervalMs);
    if (settings.privateSyncEnabled && !settings.privateSyncWithTeam) {
      this.privatePeriodicTimer = window.setInterval(() => void this.syncPrivateNotes().catch(() => undefined), settings.syncIntervalMs);
    }
  }

  stop(): void {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    if (this.periodicTimer !== undefined) window.clearInterval(this.periodicTimer);
    if (this.privateDebounceTimer !== undefined) window.clearTimeout(this.privateDebounceTimer);
    if (this.privatePeriodicTimer !== undefined) window.clearInterval(this.privatePeriodicTimer);
    this.debounceTimer = undefined;
    this.periodicTimer = undefined;
    this.privateDebounceTimer = undefined;
    this.privatePeriodicTimer = undefined;
  }

  markFileChanged(file: TFile): void {
    const path = normalizeVaultPath(file.path);
    if (this.internalAssetWrites.delete(path)) return;
    if (isPrivatePath(path)) {
      if (!shouldTrackPrivateSyncEvent(this.settings())) return;
      this.queuePrivatePaths([this.privateRelativePath(path)]);
      this.schedulePrivateSync();
      return;
    }
    if (isCommunityPluginStatePath(path, this.app.vault.configDir)) {
      if (this.internalCommunityPluginWriteDepth > 0) return;
      this.stagePublicEvent(SHARED_PLUGIN_STATE_PATH);
      return;
    }
    // Attachments are managed through S3 rather than Git, but their Vault
    // events still need to enter the attachment preparation queue.
    if (!shouldTrackVaultEvent(path, this.app.vault.configDir, this.sharedPluginIds)) return;
    if (isAssetPath(path)) {
      this.pendingAssets.add(path);
      this.scheduleSync();
      return;
    }
    if (this.internalMarkdownWrites.delete(path)) return;
    // Markdown paths remain in this small queue only so attachment-reference
    // rewriting can inspect the note incrementally. Public Git state itself
    // is staged immediately and never inferred from this queue.
    if (path.endsWith(".md")) this.pendingFiles.add(path);
    this.stagePublicEvent(path);
  }

  markManagedPathChanged(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (!isManagedPath(normalized, this.app.vault.configDir, this.sharedPluginIds)) return;
    if (normalized.endsWith(".md")) this.pendingFiles.add(normalized);
    this.stagePublicEvent(normalized);
  }

  markFileDeleted(file: TFile): void {
    const path = normalizeVaultPath(file.path);
    this.forgetPendingPublicMoves(path);
    if (path === MANIFEST_PATH) {
      this.fullAttachmentScanPending = true;
      this.stagePublicEvent(path);
      return;
    }
    this.rememberPendingDeletion(path);
    this.markFileChanged(file);
  }

  /** Serialize immediate public staging with all Git-mutating sync operations. */
  private stagePublicEvent(path: string): void {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return;
    const task = this.runExclusive(async () => {
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      if (!(await git.exists())) return false;
      await git.stageManagedEventPath(normalized);
      return git.hasStagedPublicChanges();
    }).then((hasStagedChanges) => {
      this.hasPublicStagedChanges = hasStagedChanges;
      if (hasStagedChanges && this.state !== "syncing" && this.state !== "conflict") this.setState("local-changes");
      this.scheduleSync();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Immediate public staging failed", { path: normalized, error: message });
      this.callbacks.onNotice(`无法记录本地公共修改：${message}`);
    });
    this.publicStagePersistence = task.catch(() => undefined);
  }

  private rememberPendingDeletion(path: string): void {
    this.rememberPendingDeletions([path]);
  }

  private rememberPendingDeletions(paths: readonly string[]): void {
    const candidates = paths.map(normalizeVaultPath).filter((path) => path && !isPrivatePath(path));
    if (!candidates.length) return;
    const current = this.settings().pendingDeletionPaths ?? [];
    const next = [...new Set([...current, ...candidates])].sort();
    if (next.length === current.length && next.every((path, index) => path === current[index])) return;
    this.settings().pendingDeletionPaths = next;
    void this.callbacks.onPendingDeletionPaths?.(next);
  }

  private rememberPendingDeletionFolder(path: string): void {
    const folder = normalizeVaultPath(path);
    if (!folder || isPrivatePath(folder)) return;
    const current = this.settings().pendingDeletionFolders ?? [];
    const next = [...new Set([...current, folder])].sort();
    if (next.length === current.length && next.every((candidate, index) => candidate === current[index])) return;
    this.settings().pendingDeletionFolders = next;
    void this.callbacks.onPendingDeletionFolders?.(next);
  }

  private async discardPendingDeletionPaths(paths: readonly string[]): Promise<void> {
    const handled = new Set(paths.map(normalizeVaultPath).filter(Boolean));
    if (!handled.size) return;
    const currentPaths = this.settings().pendingDeletionPaths ?? [];
    const nextPaths = currentPaths.filter((path) => !handled.has(normalizeVaultPath(path)));
    if (nextPaths.length !== currentPaths.length) {
      this.settings().pendingDeletionPaths = nextPaths;
      await this.callbacks.onPendingDeletionPaths?.(nextPaths);
    }
    const currentFolders = this.settings().pendingDeletionFolders ?? [];
    const nextFolders = currentFolders.filter((folder) => nextPaths.some((path) => path === folder || path.startsWith(`${folder}/`)));
    if (nextFolders.length !== currentFolders.length) {
      this.settings().pendingDeletionFolders = nextFolders;
      await this.callbacks.onPendingDeletionFolders?.(nextFolders);
    }
  }

  private isPublicSyncPath(path: string): boolean {
    const normalized = normalizeVaultPath(path);
    return isAssetPath(normalized) || isManagedPath(normalized, this.app.vault.configDir, this.sharedPluginIds);
  }

  private rememberPendingPublicMove(sourcePath: string, targetPath: string): void {
    if (!this.isPublicSyncPath(sourcePath) || !this.isPublicSyncPath(targetPath)) return;
    const next = mergePendingPublicMove(this.settings().pendingPublicMoves ?? [], sourcePath, targetPath);
    this.settings().pendingPublicMoves = next;
    void this.callbacks.onPendingPublicMoves?.(next);
  }

  private forgetPendingPublicMoves(path: string): void {
    const normalized = normalizeVaultPath(path);
    const current = this.settings().pendingPublicMoves ?? [];
    const next = current.filter((move) => move.from !== normalized && move.to !== normalized);
    if (next.length === current.length) return;
    this.settings().pendingPublicMoves = next;
    void this.callbacks.onPendingPublicMoves?.(next);
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
    if (isPrivatePath(previous) && isPrivatePath(current)) {
      if (!shouldTrackPrivateSyncEvent(this.settings())) return;
      this.queuePrivatePaths([this.privateRelativePath(previous), this.privateRelativePath(current)]);
      this.schedulePrivateSync();
      return;
    }
    if (previous === MANIFEST_PATH) {
      this.fullAttachmentScanPending = true;
      this.stagePublicEvent(MANIFEST_PATH);
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
      this.rememberPendingPublicMove(previous, current);
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
    if (isManagedPath(previous, this.app.vault.configDir, this.sharedPluginIds) && !isPrivatePath(previous) && previous !== MANIFEST_PATH) {
      this.rememberPendingPublicMove(previous, current);
      if (previous.endsWith(".md")) this.pendingFiles.add(previous);
      this.stagePublicEvent(previous);
    }
    this.markFileChanged(file);
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

  markFolderDeleted(folder: TFolder): void {
    const normalized = normalizeVaultPath(folder.path);
    if (isPrivatePath(normalized)) {
      if (!shouldTrackPrivateSyncEvent(this.settings())) return;
      const relative = this.privateRelativePath(normalized);
      const known = Object.keys(this.settings().privateSyncState.entries)
        .filter((path) => !relative || path === relative || path.startsWith(`${relative}/`));
      this.queuePrivatePaths(known, !known.length);
      this.schedulePrivateSync();
      return;
    }
    const descendants: string[] = [];
    const visit = (current: TFolder): void => {
      for (const child of current.children) {
        if (child instanceof TFile) descendants.push(normalizeVaultPath(child.path));
        else if (child instanceof TFolder) visit(child);
      }
    };
    visit(folder);
    const classified = classifyPublicFolderDeletionPaths(descendants, this.app.vault.configDir, this.sharedPluginIds);
    this.rememberPendingDeletionFolder(normalized);
    // An empty folder has no Git entry to stage. Preserve the root as a
    // fallback only for adapter-visible managed/asset folders whose children
    // were unavailable at event time.
    if (!classified.managedPaths.length && !classified.assetPaths.length) {
      if (!this.isPublicSyncPath(normalized)) return;
      this.rememberPendingDeletions([normalized]);
      if (isAssetPath(normalized)) this.pendingAssets.add(normalized);
      else this.stagePublicEvent(normalized);
      this.fullAttachmentScanPending ||= isAssetPath(normalized);
    } else {
      this.rememberPendingDeletions([...classified.managedPaths, ...classified.assetPaths]);
      for (const path of classified.managedPaths) this.stagePublicEvent(path);
      for (const path of classified.assetPaths) this.pendingAssets.add(path);
      this.fullAttachmentScanPending ||= classified.assetPaths.length > 0;
    }
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
    // This is Team Core's own write, so it must not depend on a Vault modify
    // event arriving later.  data.json remains outside isManagedPath and is
    // never staged by this path.
    if (this.state !== "uninitialized") this.stagePublicEvent(".gitignore");
  }

  private scheduleSync(): void {
    const generation = ++this.publicStateCheckGeneration;
    void this.refreshPublicEventState(generation);
    if (!this.settings().autoSync) return;
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => void this.flushDebounce(), this.settings().debounceMs);
  }

  /** Keep the public status bar strictly aligned with an event-scoped Git read. */
  private async refreshPublicEventState(generation: number): Promise<void> {
    const paths = [...this.pendingFiles];
    if (!paths.length || this.state === "uninitialized") return;
    try {
      const vault = this.createVault();
      const git = this.createRepository(vault);
      if (!(await git.exists()) || generation !== this.publicStateCheckGeneration) return;
      const hasGitChanges = await git.hasManagedPathChanges(paths);
      if (generation !== this.publicStateCheckGeneration || this.state === "conflict" || this.state === "syncing" || this.state === "error" || this.state === "offline") return;
      if (hasGitChanges) {
        this.setState("local-changes");
      } else if (!this.recoveryCommitPending && !(this.privateSyncDirty && this.settings().privateSyncEnabled)) {
        this.setState("synced");
      }
    } catch (error) {
      // A background state probe must not turn a save event into a visible
      // synchronization failure. The explicit sync path will report errors.
      this.logger.debug("Unable to refresh event-scoped Git state", { error: String(error) });
    }
  }

  private schedulePrivateSync(): void {
    const settings = this.settings();
    if (!shouldTrackPrivateSyncEvent(settings)) {
      this.privateSyncDirty = false;
      return;
    }
    if (settings.privateSyncWithTeam) {
      if (this.state !== "conflict") this.setState("local-changes");
      this.scheduleSync();
      return;
    }
    if (this.state !== "conflict") this.setState("local-changes");
    if (!settings.autoSync) return;
    if (this.privateDebounceTimer !== undefined) window.clearTimeout(this.privateDebounceTimer);
    this.privateDebounceTimer = window.setTimeout(() => void this.flushPrivateDebounce(), settings.debounceMs);
  }

  private privateRelativePath(path: string): string {
    const normalized = normalizeVaultPath(path);
    return normalized === PRIVATE_FOLDER ? "" : normalized.slice(`${PRIVATE_FOLDER}/`.length);
  }

  /**
   * Record the exact private paths before scheduling. The callback persists the
   * journal immediately; a crash or plugin reload therefore falls back to a
   * bounded per-path reconciliation instead of a full private-tree hash.
   */
  private queuePrivatePaths(paths: readonly string[], requireFullScan = false): void {
    for (const path of paths) {
      const normalized = normalizeVaultPath(path);
      if (normalized) this.privatePendingPaths.add(normalized);
    }
    this.privateFullScanPending ||= requireFullScan;
    this.privateSyncDirty = this.privatePendingPaths.size > 0 || this.privateFullScanPending;
    const current = this.settings().privateSyncState;
    void this.persistPrivateSyncState({
      version: 1,
      entries: current.entries,
      baselineEstablished: current.baselineEstablished,
      pendingPaths: [...this.privatePendingPaths].sort()
    });
  }

  private persistPrivateSyncState(state: PrivateSyncState): Promise<void> {
    this.privateStatePersistence = this.privateStatePersistence
      .catch(() => undefined)
      .then(() => Promise.resolve(this.callbacks.onPrivateSyncState(state)));
    return this.privateStatePersistence;
  }

  /** Wait until no event has appended a newer private-path journal batch. */
  private async flushPrivateStatePersistence(): Promise<void> {
    while (true) {
      const pending = this.privateStatePersistence;
      await pending;
      if (pending === this.privateStatePersistence) return;
    }
  }

  async flushDebounce(): Promise<void> {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.hasPublicStagedChanges || this.pendingFiles.size || this.pendingAssets.size || (this.privateSyncDirty && this.settings().privateSyncWithTeam)) await this.runCycle(true);
  }

  private async flushPrivateDebounce(): Promise<void> {
    if (this.privateDebounceTimer !== undefined) window.clearTimeout(this.privateDebounceTimer);
    this.privateDebounceTimer = undefined;
    if (this.privateSyncDirty && this.settings().privateSyncEnabled && !this.settings().privateSyncWithTeam) {
      await this.syncPrivateNotes();
    }
  }

  async runManual(): Promise<void> {
    await this.publicStagePersistence;
    this.logger.debug("Manual synchronization requested", {
      state: this.state,
      pendingFiles: this.pendingFiles.size,
      pendingAssets: this.pendingAssets.size,
      privateSyncEnabled: this.settings().privateSyncEnabled,
      privateSyncDirty: this.privateSyncDirty
    });
    if (this.debounceTimer !== undefined && (this.hasPublicStagedChanges || this.pendingFiles.size || this.pendingAssets.size || (this.privateSyncDirty && this.settings().privateSyncWithTeam))) {
      await this.flushDebounce();
      return;
    }
    await this.runCycle(true);
  }

  async syncPrivateNotes(): Promise<void> {
    if (!this.settings().privateSyncEnabled) throw new Error("请先在设置中启用“私人笔记多端同步”");
    await this.runExclusive(async () => {
      this.progress = undefined;
      this.setState("syncing");
      try {
        await this.executePrivateNotesSync(this.createVault());
        this.lastError = "";
        this.progress = undefined;
        await this.refreshState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.progress = undefined;
        this.setState(this.isOffline(error) ? "offline" : "error");
        this.logger.error("Private note synchronization failed", { error: this.lastError });
        throw error;
      }
    });
  }

  async pullPrivateNotes(overwrite = false): Promise<void> {
    if (!this.settings().privateSyncEnabled) throw new Error("请先在设置中启用“私人笔记多端同步”");
    await this.runExclusive(async () => {
      this.progress = undefined;
      this.setState("syncing");
      try {
        const vault = this.createVault();
        const result = await this.executePrivateNotesPull(vault, overwrite);
        this.recordPrivatePullResult(result);
        this.lastError = "";
        this.progress = undefined;
        await this.refreshState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.progress = undefined;
        this.setState(this.isOffline(error) ? "offline" : "error");
        this.logger.error("Private note remote pull failed", { error: this.lastError, overwrite });
        throw error;
      }
    });
  }

  async normalizeAllAttachments(): Promise<void> {
    this.fullAttachmentScanPending = true;
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    await this.runCycle(true);
    if (this.fullAttachmentScanPending) await this.runCycle(true);
  }

  /**
   * Copies the complete verified public attachment set to the currently
   * selected provider. Provider changes are intentionally explicit: a Git
   * manifest names bytes by hash but cannot move those bytes between stores.
   */
  async migratePublicAttachmentsToConfiguredStore(): Promise<number> {
    return this.runExclusive(async () => {
      const previousState = this.state;
      this.setState("syncing");
      try {
        const vault = this.createVault();
        const store = createAttachmentStore(this.settings(), this.logger);
        if (!store.enabled()) throw new Error("公共附件对象存储配置不完整");
        const manifest = await readManifest(vault);
        const entries = Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right));
        this.startProgress("迁移公共附件", Math.max(entries.length, 1));
        for (const [path, entry] of entries) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || file.stat.size !== entry.size || hashFromAssetPath(path) !== entry.sha256) {
            throw new Error(`无法迁移附件，本地文件缺失或与清单不一致：${path}`);
          }
          const actualHash = await sha256VaultFile(vault, path, file.stat.size);
          if (actualHash !== entry.sha256) throw new Error(`无法迁移附件，本地文件哈希不一致：${path}`);
          if (entry.size > VAULT_TRANSFER_CHUNK_SIZE) {
            await store.ensureUploadedFromChunks(entry.sha256, entry.size, entry.mime, (onChunk) => readVaultInChunks(vault, path, entry.size, onChunk));
          } else {
            const data = await vault.read(path);
            await store.ensureUploaded(entry.sha256, data, entry.mime);
          }
          this.advanceProgress(path);
        }
        if (!entries.length) this.advanceProgress("没有需要迁移的公共附件");
        this.progress = undefined;
        this.lastError = "";
        this.setState(previousState === "syncing" ? "synced" : previousState);
        return entries.length;
      } catch (error) {
        this.progress = undefined;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setState(this.isOffline(error) ? "offline" : "error");
        throw error;
      }
    });
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
      await git.configureWorktreeMode();
      const conflicts = await git.conflictedFiles();
      if (conflicts.length) {
        this.lastError = `待解决的 Git 冲突：${conflicts.join(", ")}`;
        this.setState("conflict");
        return;
      }
      await this.recoverLocalWorktree(git, vault);
      await this.reconcilePendingPublicMoves(git);
      this.pruneRemoteAttachmentIssues(await readManifest(vault));
      if (!this.finishRemoteAttachmentState()) return;
      // Git is the authority for public changes. Event queues are only an
      // optimization and may outlive the change they described after a
      // reload, external repair, or a mode-only normalization. Once the
      // complete Git status is clean, discard those stale signals so the
      // status bar cannot report a phantom local change.
      const hasGitChanges = await git.hasStagedPublicChanges();
      this.hasPublicStagedChanges = hasGitChanges;
      if (!hasGitChanges) {
        this.pendingFiles.clear();
        this.pendingAssets.clear();
        this.fullAttachmentScanPending = false;
        this.recoveryCommitPending = false;
      }
      const hasPrivateLocalChanges = this.privateSyncDirty && this.settings().privateSyncEnabled;
      this.logger.debug("Authoritative synchronization state evaluated", {
        syncRunId: this.activeSyncRunId,
        gitChanges: hasGitChanges,
        privateChanges: hasPrivateLocalChanges,
        pendingFiles: this.pendingFiles.size,
        pendingAssets: this.pendingAssets.size,
        fullAttachmentScanPending: this.fullAttachmentScanPending,
        recoveryCommitPending: this.recoveryCommitPending,
        privatePendingPaths: this.privatePendingPaths.size,
        privateFullScanPending: this.privateFullScanPending,
        finalState: hasGitChanges || hasPrivateLocalChanges ? "local-changes" : "synced"
      });
      this.setState(hasGitChanges || hasPrivateLocalChanges ? "local-changes" : "synced");
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
      this.recordSharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
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
    const settings = this.settings();
    const localChangeAreas: Array<"public" | "private"> = [];
    if (this.hasPublicStagedChanges || this.pendingFiles.size || this.pendingAssets.size || this.recoveryCommitPending || this.fullAttachmentScanPending) localChangeAreas.push("public");
    if (this.privateSyncDirty && settings.privateSyncEnabled) localChangeAreas.push("private");
    return { state: this.state, lastError: this.lastError || undefined, lastSyncAt: this.lastSyncAt, currentAuthor: this.currentAuthor, pendingFiles: [...this.pendingFiles].sort(), pendingAssets: [...this.pendingAssets].sort(), localChangeAreas, progress: this.progress ? { ...this.progress } : undefined };
  }

  /**
   * Produces the local-changes view model. Before reading the index it performs
   * one bounded reconciliation of whitelisted plugin folders, because those
   * plugins can bypass Obsidian's Vault events. It never contacts a remote,
   * commits, or scans notes/assets/private notes.
   */
  async getLocalChangeSnapshot(): Promise<LocalChangeSnapshot> {
    await this.reconcileSharedPluginChangesForLocalView();
    const settings = this.settings();
    const vault = this.createVault();
    const repository = this.createRepository(vault, settings);
    const publicChanges = new Map<string, LocalChangeItem>();
    const addPublic = (path: string, status: LocalChangeStatus): void => {
      const normalized = normalizeVaultPath(path);
      if (!normalized) return;
      const existing = publicChanges.get(normalized);
      if (existing && existing.status !== "pending") return;
      publicChanges.set(normalized, {
        path: normalized,
        area: "public",
        category: classifyPublicLocalChange(normalized, this.app.vault.configDir),
        status
      });
    };
    if (await repository.exists()) {
      for (const change of await repository.listPublicStagedChanges()) addPublic(change.path, change.status);
    } else {
      // Until a repository exists there is no Git fact to show. The captured
      // event queue is the only useful initialization preview.
      for (const path of this.pendingFiles) addPublic(path, "pending");
      for (const path of this.pendingAssets) {
        const normalized = normalizeVaultPath(path);
        if (!normalized) continue;
        publicChanges.set(normalized, { path: normalized, area: "public", category: "attachments", status: "pending" });
      }
    }

    const privateChanges = new Map<string, LocalChangeItem>();
    if (settings.privateSyncEnabled) {
      const pendingPaths = new Set([
        ...(settings.privateSyncState.pendingPaths ?? []),
        ...this.privatePendingPaths
      ].map(normalizeVaultPath).filter(Boolean));
      for (const relativePath of pendingPaths) {
        const previous = settings.privateSyncState.entries[relativePath];
        const fullPath = `${PRIVATE_FOLDER}/${relativePath}`;
        const exists = await vault.exists(fullPath);
        const status: LocalChangeStatus = exists
          ? (previous?.sha256 ? "modified" : "added")
          : (previous?.sha256 ? "deleted" : "pending");
        privateChanges.set(fullPath, {
          path: fullPath,
          area: "private",
          category: classifyPrivateLocalChange(relativePath),
          status
        });
      }
      if (settings.privateSyncState.baselineEstablished !== true) {
        privateChanges.set(PRIVATE_FOLDER, {
          path: PRIVATE_FOLDER,
          area: "private",
          category: "other",
          status: "pending"
        });
      }
    }
    const sort = (left: LocalChangeItem, right: LocalChangeItem): number => left.path.localeCompare(right.path);
    const snapshot: LocalChangeSnapshot = {
      publicChanges: [...publicChanges.values()].sort(sort),
      privateChanges: [...privateChanges.values()].sort(sort),
      privateSyncEnabled: settings.privateSyncEnabled
    };
    return snapshot;
  }

  private async reconcileSharedPluginChangesForLocalView(): Promise<void> {
    const changed = await this.runExclusive(async () => {
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault);
      if (!(await git.exists())) return false;
      const staged = await git.stageSharedPluginWorktreeChanges();
      this.hasPublicStagedChanges = await git.hasStagedPublicChanges();
      return staged.length > 0;
    });
    if (!changed) return;
    this.logger.debug("Local changes view staged direct shared-plugin changes");
    if (this.state !== "syncing" && this.state !== "conflict") this.setState("local-changes");
    // This only schedules the user's already-enabled automatic mode; the view
    // itself never performs a network operation or creates a commit.
    this.scheduleSync();
  }

  /** Revert one row from the local-changes view without creating a Git commit. */
  async discardLocalChange(change: LocalChangeItem): Promise<"restored" | "removed"> {
    if (change.path === PRIVATE_FOLDER) throw new Error("私人笔记尚未建立同步基线，无法按单文件撤销");
    if (change.area === "private") {
      return this.runExclusive(async () => {
        const settings = this.settings();
        if (!settings.privateSyncEnabled) throw new Error("未启用私人笔记多端同步");
        const relativePath = this.privateRelativePath(change.path);
        const result = await new PrivateNotesSynchronizer(settings, this.logger, undefined, this.privateTransactionPath())
          .restoreBaselinePath(this.createVault(), settings.privateSyncState, relativePath);
        this.privatePendingPaths.delete(relativePath);
        this.privateSyncDirty = this.privatePendingPaths.size > 0 || this.privateFullScanPending;
        await this.persistPrivateSyncState({ ...settings.privateSyncState, pendingPaths: [...this.privatePendingPaths].sort() });
        return result;
      });
    }
    return this.runExclusive(async () => {
      const vault = this.createVault();
      const git = this.createRepository(vault);
      if (!(await git.exists())) throw new Error("本地 Git 仓库尚未初始化");
      const result = await git.discardManagedPathChange(change.path);
      if (!result) throw new Error("此类附件变更请通过附件审计或删除确认恢复");
      this.pendingFiles.delete(normalizeVaultPath(change.path));
      this.pendingAssets.delete(normalizeVaultPath(change.path));
      await this.discardPendingDeletionPaths([change.path]);
      this.hasPublicStagedChanges = await git.hasStagedPublicChanges();
      return result;
    });
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
      if (settings.privateSyncEnabled && settings.privateSyncWithTeam) {
        await this.executePrivateNotesSync(vault);
      }
      this.progress = undefined;
      if (this.finishRemoteAttachmentState()) this.setState("synced");
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

  async cloneRemote(force = false): Promise<boolean> {
    if (this.debounceTimer !== undefined) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.setState("syncing");
    this.startProgress(force ? "等待重新同步" : "等待远端导入", 1);
    return this.runExclusive(() => this.executeCloneRemote(force));
  }

  private async executeCloneRemote(force: boolean): Promise<boolean> {
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
      const sharedPluginChanged = this.sharedPluginIds.length > 0
        || this.recordSharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
      if (sharedPluginChanged) this.restartRequiredAfterSync = true;
      this.startProgress("检查远端附件", 1);
      const remoteManifest = await readManifest(vault);
      this.advanceProgress(MANIFEST_PATH);
      await this.materializeRemoteAttachments(createEmptyManifest(), remoteManifest);
      this.startProgress("整理本地目录", 1);
      await pruneEmptyManagedFolders(vault, this.app.vault.configDir);
      this.advanceProgress();
      if (this.settings().privateSyncEnabled && this.settings().privateSyncWithTeam) {
        this.recordPrivatePullResult(await this.executePrivateNotesPull(vault, force));
      }
      this.lastSyncAt = Date.now();
      this.progress = undefined;
      this.pendingFiles.clear();
      this.pendingAssets.clear();
      if (this.finishRemoteAttachmentState()) this.setState(this.privateSyncDirty ? "local-changes" : "synced");
      if (sharedPluginChanged) this.notifyRestartRequired();
      return sharedPluginChanged;
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
    const plan = await planFastRemoteReset(adapter, this.app.vault.configDir);
    const cleanupItems = plan.files.length + plan.directories.length + (plan.hasGitDirectory ? 1 : 0);
    this.startProgress("清理本地知识库", Math.max(cleanupItems, 1));
    for (const path of plan.files) {
      await adapter.remove(path);
      this.advanceProgress(path);
    }
    for (const path of plan.directories) {
      await adapter.rmdir(path, true);
      this.advanceProgress(path);
    }
    if (plan.hasGitDirectory) {
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
      const attachmentStore = createAttachmentStore(this.settings(), this.logger);
      if (!attachmentStore.enabled()) throw new Error("公共附件对象存储配置不完整，未执行任何删除");

      this.startProgress("检查远端清空范围", 2);
      const remote = await git.remoteInfo();
      this.advanceProgress("Git main");
      this.advanceProgress(attachmentStore.managedObjectLocation());
      const remoteMainOid = remote.heads[DEFAULT_BRANCH];
      const remoteBranchExists = Boolean(remoteMainOid);

      this.startProgress("删除远端附件", 1);
      const deletedObjects = await attachmentStore.clearManagedObjects((key) => this.advanceProgress(key));
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
      return { deletedS3Objects: deletedObjects, deletedGitBranch: remoteBranchExists };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.progress = undefined;
      this.setState(this.isOffline(error) ? "offline" : "error");
      this.logger.error("Remote clear failed", { error: this.lastError });
      throw error;
    }
  }

  private async executeCycle(): Promise<void> {
    const syncRunId = ++this.syncRunSequence;
    const previousSyncRunId = this.activeSyncRunId;
    this.activeSyncRunId = syncRunId;
    this.logger.debug("Synchronization cycle started", {
      syncRunId,
      previousSyncRunId,
      state: this.state,
      pendingFiles: this.pendingFiles.size,
      pendingAssets: this.pendingAssets.size,
      privateSyncDirty: this.privateSyncDirty,
      privatePendingPaths: this.privatePendingPaths.size
    });
    this.progress = undefined;
    this.setState("syncing");
    // Consume only the captured generation. Events arriving after this point,
    // including another edit to the same path, remain queued for the next run.
    const pendingNotes = takePendingPaths(this.pendingFiles);
    const pendingAssets = takePendingPaths(this.pendingAssets);
    const forceFullAttachmentScan = this.fullAttachmentScanPending;
    if (forceFullAttachmentScan) this.fullAttachmentScanPending = false;
    const recoveryCommitPending = this.recoveryCommitPending;
    this.recoveryCommitPending = false;
    try {
      const settings = this.settings();
      const vault = this.createVault();
      this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
      const git = this.createRepository(vault, settings);
      if (!(await git.exists())) {
        this.logger.debug("Synchronization cycle stopped: Git is uninitialized", { syncRunId });
        this.recoveryCommitPending ||= recoveryCommitPending;
        if (settings.privateSyncEnabled && settings.privateSyncWithTeam) {
          await this.executePrivateNotesSync(vault);
        }
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
      const gitignoreChanged = await git.ensureGitignore();
      const sharedPluginStateChanged = await this.syncSharedPluginStateBeforeCommit(vault);
      if (gitignoreChanged) await git.stageManagedEventPath(".gitignore");
      if (sharedPluginStateChanged) await git.stageManagedEventPath(SHARED_PLUGIN_STATE_PATH);
      // A shared community plugin can update its own config directly and
      // bypass Obsidian's Vault events. Reconcile only its whitelisted folder
      // at the normal sync boundary; this is intentionally not a vault scan.
      const directSharedPluginChanges = await git.stageSharedPluginWorktreeChanges();
      if (directSharedPluginChanges.length) {
        this.logger.debug("Staged direct shared-plugin configuration changes", {
          syncRunId,
          paths: directSharedPluginChanges
        });
      }
      if (this.pendingDraftPublications.size || this.pendingNotePrivatizations.size) {
        for (const path of pendingNotes) this.pendingFiles.add(path);
        for (const path of pendingAssets) this.pendingAssets.add(path);
        if (forceFullAttachmentScan) this.fullAttachmentScanPending = true;
        this.logger.debug("Synchronization deferred: pending note transition", { syncRunId, pendingDraftPublications: this.pendingDraftPublications.size, pendingNotePrivatizations: this.pendingNotePrivatizations.size });
        this.deferForLocalChanges();
        return;
      }
      const pendingMoves = await this.reconcilePendingPublicMoves(git, syncRunId);
      const movedSourcePaths = new Set(pendingMoves.map((move) => normalizeVaultPath(move.from)));
      const manifestForDeletionCheck = await readManifest(vault);
      const deletedManagedPaths = (await git.listPublicStagedChanges())
        .filter((change) => change.status === "deleted")
        .map((change) => change.path);
      const deletedAssetPaths = [...new Set([
        ...(this.settings().pendingDeletionPaths ?? []),
        ...[...pendingAssets].filter((path) => !this.app.vault.getAbstractFileByPath(path))
      ].map(normalizeVaultPath).filter(Boolean))].filter((path) => (
        isAssetPath(path)
        && !this.app.vault.getAbstractFileByPath(path)
        && Boolean(manifestForDeletionCheck.files[path])
      ));
      let deletionCandidates = [...new Set([...deletedManagedPaths, ...deletedAssetPaths])]
        .filter((path) => !movedSourcePaths.has(path))
        .sort();
      const recordedDeletionPaths = this.settings().pendingDeletionPaths ?? [];
      const staleDeletionPaths = recordedDeletionPaths.filter((path) => !deletionCandidates.includes(normalizeVaultPath(path)));
      if (staleDeletionPaths.length) {
        await this.discardPendingDeletionPaths(staleDeletionPaths);
        this.logger.debug("Discarded stale public deletion events", {
          syncRunId,
          recorded: recordedDeletionPaths.length,
          actual: deletionCandidates.length
        });
      }
      // Small, ordinary deletions remain low-friction. A move is always shown
      // separately because Git represents it as a delete plus an add.
      const requiresDeletionConfirmation = deletionCandidates.length > 3;
      if (requiresDeletionConfirmation || pendingMoves.length) {
        const deletionGroups = groupRemoteDeletionPaths(
          requiresDeletionConfirmation ? deletionCandidates : [],
          this.app.vault.configDir,
          this.settings().pendingDeletionFolders ?? []
        );
        deletionGroups.moves = pendingMoves;
        this.logger.warn("Synchronization requires change confirmation", { syncRunId, ...deletionGroups, deletionCandidateCount: deletionCandidates.length });
        const decision = this.callbacks.confirmRemoteDeletions
          ? await this.callbacks.confirmRemoteDeletions(deletionGroups)
          : { confirmed: false, restorePaths: [] };
        if (!decision.confirmed) {
          for (const path of pendingNotes) this.pendingFiles.add(path);
          for (const path of pendingAssets) this.pendingAssets.add(path);
          this.setState("local-changes");
          return;
        }
        if (decision.restorePaths.length) {
          const restored = await this.restoreDeletedPublicPaths(git, vault, decision.restorePaths);
          const restoredPaths = new Set(restored.restoredPaths);
          for (const path of restoredPaths) {
            pendingNotes.delete(path);
            pendingAssets.delete(path);
          }
          deletionCandidates = deletionCandidates.filter((path) => !restoredPaths.has(path));
          await this.discardPendingDeletionPaths(decision.restorePaths);
          const unavailable = restored.unavailablePaths.length;
          this.callbacks.onNotice(unavailable
            ? `已撤回 ${restored.restoredPaths.length} 项删除；另有 ${unavailable} 项没有可恢复的 Git 版本，请从 Obsidian 回收站恢复。`
            : `已撤回 ${restored.restoredPaths.length} 项删除，其余已确认的更改将继续同步。`);
          this.logger.debug("Selected public deletions restored", {
            syncRunId,
            requested: decision.restorePaths.length,
            restored: restored.restoredPaths,
            unavailable: restored.unavailablePaths
          });
        }
      }
      const changed = await this.prepareAttachments(pendingNotes, pendingAssets, forceFullAttachmentScan);
      if (changed) await git.stageManagedEventPath(MANIFEST_PATH);
      this.logger.debug("Synchronization inputs prepared", { syncRunId, capturedPendingNotes: pendingNotes.size, capturedPendingAssets: pendingAssets.size, attachmentsChanged: changed, forceFullAttachmentScan, recoveryCommitPending });
      const handledPaths = new Set([...deletionCandidates, ...pendingMoves.map((move) => normalizeVaultPath(move.from))]);
      await this.discardPendingDeletionPaths([...handledPaths]);
      if (pendingMoves.length) {
        this.settings().pendingPublicMoves = [];
        await this.callbacks.onPendingPublicMoves?.([]);
      }
      if (await git.hasStagedPublicChanges()) {
        this.startProgress("提交本地更改", 1);
        await git.commitStaged(`Update vault`);
        this.hasPublicStagedChanges = false;
        this.advanceProgress();
      }
      const manifestBeforeRemote = await readManifest(vault);
      this.startProgress("拉取远端更改", 1);
      await git.fetch();
      this.advanceProgress();
      const initialReconciliation = await this.mergeFetchedRemote(git, vault, manifestBeforeRemote);
      if (initialReconciliation.deferred) {
        this.logger.debug("Synchronization deferred: local work appeared before merge", { syncRunId, pendingFiles: this.pendingFiles.size, pendingAssets: this.pendingAssets.size, fullAttachmentScanPending: this.fullAttachmentScanPending, recoveryCommitPending: this.recoveryCommitPending });
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
        this.logger.debug("Synchronization deferred during push reconciliation", { syncRunId });
        this.deferForLocalChanges();
        return;
      }
      if (pushResult.conflicts.length) {
        this.enterConflict(pushResult.conflicts);
        return;
      }
      await this.collectExpiredAttachmentRetention(vault);
      this.startProgress("更新本地同步状态", 1);
      const active = this.app.workspace.getActiveFile();
      if (active) this.currentAuthor = (await git.log(active.path, 1))[0]?.author;
      this.advanceProgress("作者信息");
      if (settings.privateSyncEnabled && settings.privateSyncWithTeam) {
        await this.executePrivateNotesSync(vault);
      }
      this.lastSyncAt = Date.now();
      this.progress = undefined;
      const queuedChanges = this.hasPublicStagedChanges
        || this.pendingFiles.size > 0
        || this.pendingAssets.size > 0
        || this.fullAttachmentScanPending
        || (this.privateSyncDirty && settings.privateSyncEnabled && settings.privateSyncWithTeam);
      this.logger.debug("Synchronization cycle completed", { syncRunId, queuedChanges, pendingFiles: this.pendingFiles.size, pendingAssets: this.pendingAssets.size, fullAttachmentScanPending: this.fullAttachmentScanPending, privateSyncDirty: this.privateSyncDirty, finalState: queuedChanges ? "local-changes" : "synced" });
      if (this.finishRemoteAttachmentState()) {
        this.setState(queuedChanges ? "local-changes" : "synced");
        if (!queuedChanges) this.notifyRestartRequired();
      }
    } catch (error) {
      for (const path of pendingNotes) this.pendingFiles.add(path);
      for (const path of pendingAssets) this.pendingAssets.add(path);
      if (forceFullAttachmentScan) this.fullAttachmentScanPending = true;
      this.recoveryCommitPending ||= recoveryCommitPending;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.isOffline(error)) this.setState("offline");
      else {
        this.setState("error");
        this.callbacks.onNotice(`Oldeng Team Core 同步失败：${this.lastError}`);
      }
      this.logger.error("Synchronization failed", { error: this.lastError });
    } finally {
      if (this.activeSyncRunId === syncRunId) this.activeSyncRunId = previousSyncRunId;
    }
  }

  private async mergeFetchedRemote(git: GitRepository, vault: BinaryVault, manifestBeforeRemote: AssetManifest): Promise<RemoteReconciliationResult> {
    // A note may be edited while fetch is in flight. Defer the merge so the
    // next cycle commits that event-derived edit before checkout can
    // materialize remote data. Full worktree recovery is an explicit startup
    // boundary, not part of every incremental merge.
    if (this.hasPublicStagedChanges || this.pendingFiles.size || this.pendingAssets.size || this.fullAttachmentScanPending || this.recoveryCommitPending) {
      return { conflicts: [], deferred: true };
    }
    this.startProgress("合并远端更改", 1);
    const previousSharedPluginIds = [...this.sharedPluginIds];
    const merge = await git.mergeRemote();
    this.advanceProgress();
    if (merge.conflicts.length) return { conflicts: merge.conflicts, deferred: false };
    this.sharedPluginIds = await readSharedPluginIds(vault, this.app.vault.configDir);
    const enabledStateChanged = await this.applySharedPluginState(vault);
    this.recordSharedPluginChange(previousSharedPluginIds, this.sharedPluginIds, enabledStateChanged);
    await this.materializeRemoteAttachments(manifestBeforeRemote, await readManifest(vault));
    await pruneEmptyManagedFolders(vault, this.app.vault.configDir);
    return { conflicts: [], deferred: false };
  }

  private async executePrivateNotesSync(vault: BinaryVault): Promise<void> {
    const settings = this.settings();
    if (!settings.privateSyncEnabled) return;
    this.startProgress("同步私人笔记", 1);
    await this.flushPrivateStatePersistence();
    const pendingForRun = takePendingPaths(this.privatePendingPaths);
    const fullScanForRun = this.privateFullScanPending;
    this.privateFullScanPending = false;
    const runState = { ...settings.privateSyncState, pendingPaths: [...pendingForRun].sort() };
    let result: PrivateSyncResult;
    try {
      result = await new PrivateNotesSynchronizer(settings, this.logger, undefined, this.privateTransactionPath()).sync(vault, runState, (current, total, path) => {
        this.updateProgress("同步私人笔记", current, total, path);
      }, fullScanForRun);
    } catch (error) {
      for (const path of pendingForRun) this.privatePendingPaths.add(path);
      this.privateFullScanPending ||= fullScanForRun;
      this.privateSyncDirty = this.privatePendingPaths.size > 0 || this.privateFullScanPending;
      await this.persistPrivateSyncState({ ...settings.privateSyncState, pendingPaths: [...this.privatePendingPaths].sort() });
      throw error;
    }
    this.privateSyncDirty = this.privatePendingPaths.size > 0 || this.privateFullScanPending;
    await this.persistPrivateSyncState({ ...result.state, pendingPaths: [...this.privatePendingPaths].sort() });
    this.logger.debug("Private note synchronization completed", {
      uploaded: result.uploaded,
      downloaded: result.downloaded,
      deletedRemote: result.deletedRemote,
      deletedLocal: result.deletedLocal,
      conflictsResolved: result.conflictsResolved
    });
  }

  private async executePrivateNotesPull(vault: BinaryVault, overwriteLocal = false): Promise<PrivateSyncResult> {
    const settings = this.settings();
    if (!settings.privateSyncEnabled) throw new Error("请先在设置中启用“私人笔记多端同步”");
    this.startProgress("从远端导入私人笔记", 1);
    await this.flushPrivateStatePersistence();
    const pendingBeforePull = takePendingPaths(this.privatePendingPaths);
    let result: PrivateSyncResult;
    try {
      result = await new PrivateNotesSynchronizer(settings, this.logger, undefined, this.privateTransactionPath()).pull(
        vault,
        settings.privateSyncState,
        (current, total, path) => this.updateProgress("从远端导入私人笔记", current, total, path),
        overwriteLocal
      );
    } catch (error) {
      for (const path of pendingBeforePull) this.privatePendingPaths.add(path);
      await this.persistPrivateSyncState({ ...settings.privateSyncState, pendingPaths: [...this.privatePendingPaths].sort() });
      throw error;
    }
    this.privateFullScanPending = false;
    // A confirmed destructive reset intentionally drops the event generation
    // it replaced. Safe import retains it, alongside changes that arrived
    // while the import was running.
    if (!overwriteLocal) for (const path of pendingBeforePull) this.privatePendingPaths.add(path);
    for (const path of result.state.pendingPaths ?? []) this.privatePendingPaths.add(path);
    this.privateSyncDirty = this.privatePendingPaths.size > 0;
    await this.persistPrivateSyncState({ ...result.state, pendingPaths: [...this.privatePendingPaths].sort() });
    this.logger.debug("Private note remote pull completed", { downloaded: result.downloaded, deletedLocal: result.deletedLocal, preservedLocal: result.preservedLocal, overwriteLocal });
    return result;
  }

  /** A safe import must keep retained local data visible until the user syncs or resets it. */
  private recordPrivatePullResult(result: PrivateSyncResult): void {
    this.privateSyncDirty = this.privatePendingPaths.size > 0 || result.preservedLocal > 0;
    if (result.preservedLocal) {
      this.callbacks.onNotice(`已保留 ${result.preservedLocal} 个本地私人笔记改动；使用“重置私人笔记并重新同步”才会以远端覆盖本地。`);
    }
  }

  private privateTransactionPath(): string {
    return `${normalizeVaultPath(this.app.vault.configDir)}/plugins/team-core/private-sync-transaction.json`;
  }

  /**
   * Rename events are only scheduling hints. Verify them against the durable
   * Git index before exposing a prompt, including during startup, so a move
   * that was later undone cannot survive in data.json indefinitely.
   */
  private async reconcilePendingPublicMoves(git: GitRepository, syncRunId?: number): Promise<PendingPublicMove[]> {
    const recorded = this.settings().pendingPublicMoves ?? [];
    if (!recorded.length) return [];
    const actual = await git.actualPublicMoves(recorded);
    const unchanged = actual.length === recorded.length
      && actual.every((move, index) => move.from === recorded[index]?.from && move.to === recorded[index]?.to);
    if (unchanged) return actual;
    this.settings().pendingPublicMoves = actual;
    await this.callbacks.onPendingPublicMoves?.(actual);
    this.logger.debug("Discarded stale public move events", {
      syncRunId,
      recorded: recorded.length,
      actual: actual.length
    });
    return actual;
  }

  private async ensureSharedPluginState(vault: BinaryVault): Promise<void> {
    const existing = await readSharedPluginState(vault);
    if (existing !== undefined) return;
    const enabled = (await readCommunityPluginIds(vault, this.app.vault.configDir)).filter((id) => this.sharedPluginIds.includes(id));
    await writeSharedPluginState(vault, enabled);
  }

  private async syncSharedPluginStateBeforeCommit(vault: BinaryVault): Promise<boolean> {
    const enabled = (await readCommunityPluginIds(vault, this.app.vault.configDir)).filter((id) => this.sharedPluginIds.includes(id));
    const before = await vault.read(SHARED_PLUGIN_STATE_PATH).catch(() => undefined);
    await writeSharedPluginState(vault, enabled);
    const after = await vault.read(SHARED_PLUGIN_STATE_PATH).catch(() => undefined);
    if (!before || !after || before.byteLength !== after.byteLength) return before !== after;
    const left = new Uint8Array(before);
    const right = new Uint8Array(after);
    return !left.every((value, index) => value === right[index]);
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

  private recordSharedPluginChange(before: readonly string[], after: readonly string[], enabledStateChanged = false): boolean {
    const changed = enabledStateChanged || before.length !== after.length || !before.every((id, index) => id === after[index]);
    if (changed) this.restartRequiredAfterSync = true;
    return changed;
  }

  private notifyRestartRequired(): void {
    if (!this.restartRequiredAfterSync) return;
    this.restartRequiredAfterSync = false;
    this.callbacks.onRestartRequired();
  }

  private deferForLocalChanges(): void {
    this.progress = undefined;
    this.lastError = "";
    this.logger.debug("Synchronization deferred; refreshing authoritative state", { syncRunId: this.activeSyncRunId, pendingFiles: this.pendingFiles.size, pendingAssets: this.pendingAssets.size, privateSyncDirty: this.privateSyncDirty });
    // Do not publish the intermediate state before the authoritative Git read.
    // A no-op/deferred cycle must settle directly on "synced"; otherwise the
    // status bar can remain stuck at "待同步" until the next plugin reload.
    void this.refreshState();
  }

  /**
   * Establishes a single authoritative recovery boundary after startup or an
   * unexpected dirty-worktree guard. Vault events are fast but ephemeral; Git
   * status is the source of truth when those events may have been missed.
   */
  private async recoverLocalWorktree(git: GitRepository, vault: BinaryVault): Promise<boolean> {
    let recoveredPublicChanges = false;
    if (!this.publicRecoveryCheckComplete) {
      this.publicRecoveryCheckComplete = true;
      const recovery = await git.recoverManagedWorktree();
      if (recovery.hasChanges) {
        await git.stageManagedChanges();
        for (const path of recovery.changedManagedPaths) if (path.endsWith(".md")) this.pendingFiles.add(path);
        this.hasPublicStagedChanges = await git.hasStagedPublicChanges();
      }
      recoveredPublicChanges = recovery.hasChanges;
    }
    this.recoveryCommitPending = false;

    if (!this.recoveryAttachmentCheckComplete) {
      this.recoveryAttachmentCheckComplete = true;
      if (await this.requiresAttachmentReconciliation(vault)) this.fullAttachmentScanPending = true;
    }
    return recoveredPublicChanges || this.fullAttachmentScanPending;
  }

  /**
   * Authoritative recovery validation. It intentionally hashes every public
   * attachment once: a same-sized external overwrite can otherwise retain a
   * valid-looking content-addressed filename and evade event recovery.
   */
  private async requiresAttachmentReconciliation(vault: BinaryVault): Promise<boolean> {
    const manifest = await readManifest(vault);
    for (const [path, entry] of Object.entries(manifest.files)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || hashFromAssetPath(path) !== entry.sha256 || file.stat.size !== entry.size) return true;
    }
    for (const file of this.app.vault.getFiles()) {
      const path = normalizeVaultPath(file.path);
      if (!isAssetPath(path)) continue;
      const expectedHash = hashFromAssetPath(path);
      const entry = manifest.files[path];
      if (!expectedHash || !entry || entry.sha256 !== expectedHash || entry.size !== file.stat.size) return true;
      if (await sha256VaultFile(vault, path, file.stat.size) !== entry.sha256) return true;
    }
    return false;
  }

  private enterConflict(conflicts: string[], notify = true): void {
    this.progress = undefined;
    this.lastError = `待解决的 Git 冲突：${conflicts.join(", ")}`;
    if (notify) this.callbacks.onNotice(`检测到 Git 冲突：${conflicts.join(", ")}。已停止推送，请先解决冲突。`);
    this.setState("conflict");
  }

  /** Restore only explicitly selected deleted public paths from the local Git HEAD. */
  private async restoreDeletedPublicPaths(git: GitRepository, vault: BinaryVault, paths: readonly string[]): Promise<{ restoredPaths: string[]; unavailablePaths: string[] }> {
    const requested = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort();
    const assetPaths = requested.filter(isAssetPath);
    const managedPaths = requested.filter((path) => !isAssetPath(path) && path !== MANIFEST_PATH);
    const restored = new Set(await git.restoreManagedPathsFromHead(managedPaths));
    const unavailable = new Set(requested.filter((path) => !isAssetPath(path) && path !== MANIFEST_PATH && !restored.has(path)));

    const shouldRestoreManifest = requested.includes(MANIFEST_PATH);
    if (assetPaths.length || shouldRestoreManifest) {
      const headManifestBytes = await git.readHeadFile(MANIFEST_PATH);
      if (!headManifestBytes) {
        for (const path of assetPaths) unavailable.add(path);
        if (shouldRestoreManifest) unavailable.add(MANIFEST_PATH);
      } else {
        let headManifest: AssetManifest;
        try {
          headManifest = validateManifest(JSON.parse(new TextDecoder().decode(headManifestBytes)));
        } catch (error) {
          throw new Error(`无法恢复删除的附件：Git 历史中的附件清单无效（${error instanceof Error ? error.message : String(error)}）`);
        }
        const currentManifest = await readManifest(vault);
        let nextManifest = shouldRestoreManifest ? headManifest : currentManifest;
        if (shouldRestoreManifest) restored.add(MANIFEST_PATH);
        const materializationBefore: AssetManifest = { version: nextManifest.version, files: { ...nextManifest.files } };
        for (const path of assetPaths) {
          const entry = headManifest.files[path];
          if (!entry) {
            unavailable.add(path);
            continue;
          }
          nextManifest = updateManifestEntry(nextManifest, path, entry);
          delete materializationBefore.files[path];
          restored.add(path);
        }
        if (JSON.stringify(currentManifest) !== JSON.stringify(nextManifest) || shouldRestoreManifest) {
          await writeManifest(vault, nextManifest);
        }
        if (assetPaths.some((path) => restored.has(path))) await this.materializeRemoteAttachments(materializationBefore, nextManifest);
      }
    }
    return {
      restoredPaths: [...restored].sort(),
      unavailablePaths: [...unavailable].sort()
    };
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
    // Full scans are explicit normalization/recovery boundaries. Re-hash all
    // assets there, including valid-looking hash-named files, so a same-sized
    // external overwrite cannot escape content verification.
    const candidates = discovered;
    this.logger.debug("Attachment candidates selected", { count: candidates.size, fullScan: forceFullScan, pendingAssets: pendingAssets.size, pendingNotes: pendingNotes.size });
    if (!candidates.size) {
      const manifestMissing = !(await vault.exists(MANIFEST_PATH));
      await this.recordRetiredAttachments(manifest, next);
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
        size = file.stat.size;
        this.logger.debug("Attachment hash started", { path: normalizedSource, expectedSize: size, chunked: size > VAULT_TRANSFER_CHUNK_SIZE });
        if (size > VAULT_TRANSFER_CHUNK_SIZE) {
          hash = await sha256VaultFile(vault, normalizedSource, size);
        } else {
          data = await vault.read(normalizedSource);
          hash = await sha256Hex(data);
          size = data.byteLength;
        }
        this.logger.debug("Attachment hash completed", { path: normalizedSource, size, durationMs: Date.now() - readStartedAt, hash });
      }
      const targetPath = assetPathForHash(hash, file.extension);
      const objectId = `${hash}:${size}`;
      const requiresUpload = !knownObjects.has(objectId);
      if (requiresUpload) knownObjects.add(objectId);
      plans.push({ sourcePath: normalizedSource, targetPath, hash, size, mime: mimeFromPath(targetPath), data, requiresUpload });
      this.advanceProgress(normalizedSource);
    }

    const uploads = plans.filter((plan) => plan.requiresUpload);
    if (uploads.length) {
      const attachmentStore = createAttachmentStore(this.settings(), this.logger);
      if (!attachmentStore.enabled()) throw new Error("公共附件对象存储配置不完整");
      this.startProgress("上传新附件", uploads.length);
      for (const plan of uploads) {
        const uploadStartedAt = Date.now();
        this.logger.debug("Attachment upload started", { path: plan.sourcePath, hash: plan.hash, size: plan.size, mime: plan.mime });
        if (plan.size > VAULT_TRANSFER_CHUNK_SIZE) {
          await attachmentStore.ensureUploadedFromChunks(plan.hash, plan.size, plan.mime, (onChunk) => readVaultInChunks(vault, plan.sourcePath, plan.size, onChunk));
        } else {
          const data = plan.data ?? await vault.read(plan.sourcePath);
          if (data.byteLength !== plan.size || await sha256Hex(data) !== plan.hash) {
            this.logger.error("Attachment changed before upload", { path: plan.sourcePath, expectedSize: plan.size, actualSize: data.byteLength, hash: plan.hash });
            throw new Error(`附件在同步时发生变化：${plan.sourcePath}`);
          }
          await attachmentStore.ensureUploaded(plan.hash, data, plan.mime);
        }
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
    await this.recordRetiredAttachments(manifest, next);
    if (manifestChanged) await writeManifest(vault, next);
    return manifestChanged || linksChanged;
  }

  private async recordRetiredAttachments(before: AssetManifest, after: AssetManifest): Promise<void> {
    const referenced = new Set(Object.values(after.files).map((entry) => `${entry.sha256}:${entry.size}`));
    const now = new Date().toISOString();
    const existing = this.settings().assetRetention ?? [];
    const additions = Object.values(before.files)
      .filter((entry) => !referenced.has(`${entry.sha256}:${entry.size}`))
      .map((entry) => ({ sha256: entry.sha256, size: entry.size, markedAt: now } satisfies AssetRetentionRecord));
    const merged = new Map(existing.map((entry) => [`${entry.sha256}:${entry.size}`, entry]));
    for (const entry of additions) if (!merged.has(`${entry.sha256}:${entry.size}`)) merged.set(`${entry.sha256}:${entry.size}`, entry);
    const next = [...merged.values()].sort((left, right) => left.markedAt.localeCompare(right.markedAt));
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      this.settings().assetRetention = next;
      await this.callbacks.onAssetRetention?.(next);
    }
  }

  private async collectExpiredAttachmentRetention(vault: BinaryVault): Promise<void> {
    const records = this.settings().assetRetention ?? [];
    if (!records.length) return;
    const manifest = await readManifest(vault);
    const referenced = new Set(Object.values(manifest.files).map((entry) => `${entry.sha256}:${entry.size}`));
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const expired = records.filter((entry) => Date.parse(entry.markedAt) <= cutoff && !referenced.has(`${entry.sha256}:${entry.size}`));
    if (!expired.length) return;
      const store = createAttachmentStore(this.settings(), this.logger);
    const git = this.createRepository(vault);
    const historical = await git.historicalAttachmentObjects();
    const collectible = expired.filter((entry) => !historical.has("*") && !historical.has(`${entry.sha256}:${entry.size}`));
    for (const entry of collectible) await store.removeObject(entry.sha256);
    const next = records.filter((entry) => !collectible.includes(entry));
    this.settings().assetRetention = next;
    await this.callbacks.onAssetRetention?.(next);
    this.logger.debug("Expired public attachment retention records collected", { count: collectible.length, protectedByHistory: expired.length - collectible.length });
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
        await this.createTransferredAttachment(attachment.targetPath, attachment.data);
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
        if (await this.removeTransferredAttachment(source, "Unable to remove published private attachment")) removedSources.add(attachment.sourcePath);
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      this.assertStableNoteMove(file, currentPath, moveRevision);
      this.advanceProgress(currentPath);
      this.progress = undefined;
      this.lastError = "";
      this.pendingFiles.add(currentPath);
      for (const attachment of plan.attachments) this.pendingAssets.add(attachment.targetPath);
      this.recordPrivateMigration();
      this.scheduleSync();
      if (plan.attachments.length) {
        this.callbacks.onNotice(`私人草稿已发布，并整理 ${plan.attachments.length} 个附件。`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (plan) {
        for (const attachment of plan.attachments) {
          if (removedSources.has(attachment.sourcePath) && !(await vault.exists(attachment.sourcePath))) {
            await this.restoreTransferredAttachment(attachment.sourcePath, attachment.data).catch(() => undefined);
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
        await this.discardTransferredAttachment(targetPath).catch(() => undefined);
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
        await this.createTransferredAttachment(attachment.targetPath, attachment.data);
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
        if (await this.removeTransferredAttachment(source, "Unable to remove privatized public attachment")) removedSources.add(attachment.sourcePath);
        this.assertStableNoteMove(file, currentPath, moveRevision);
      }

      this.assertStableNoteMove(file, currentPath, moveRevision);
      this.advanceProgress(currentPath);
      this.progress = undefined;
      this.lastError = "";
      this.pendingFiles.add(normalizeVaultPath(originalPath));
      for (const sourcePath of removedSources) this.pendingAssets.add(sourcePath);
      this.recordPrivateMigration();
      this.scheduleSync();
      if (plan.attachments.length) {
        this.callbacks.onNotice(`笔记已移入“私人笔记”，并整理 ${plan.attachments.length} 个附件。`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (plan) {
        for (const attachment of plan.attachments) {
          if (removedSources.has(attachment.sourcePath) && !(await vault.exists(attachment.sourcePath))) {
            await this.restoreTransferredAttachment(attachment.sourcePath, attachment.data).catch(() => undefined);
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
        await this.discardTransferredAttachment(targetPath).catch(() => undefined);
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

  /** Both public-to-private and private-to-public moves must suppress identical vault events. */
  private async createTransferredAttachment(path: string, data: ArrayBuffer): Promise<void> {
    this.internalAssetWrites.add(path);
    try {
      await this.createVault().mkdir(path.split("/").slice(0, -1).join("/"));
      await this.app.vault.createBinary(path, data);
    } finally {
      this.internalAssetWrites.delete(path);
    }
  }

  /** Restores a failed migration source without queuing a synthetic sync event. */
  private async restoreTransferredAttachment(path: string, data: ArrayBuffer): Promise<void> {
    this.internalAssetWrites.add(path);
    try {
      await this.createVault().mkdir(path.split("/").slice(0, -1).join("/"));
      await this.app.vault.createBinary(path, data);
    } finally {
      this.internalAssetWrites.delete(path);
    }
  }

  /** Removes a failed migration target without queuing a synthetic sync event. */
  private async discardTransferredAttachment(path: string): Promise<void> {
    this.internalAssetWrites.add(path);
    try {
      const target = this.app.vault.getAbstractFileByPath(path);
      if (target instanceof TFile) await this.app.fileManager.trashFile(target);
      else if (await this.createVault().exists(path)) await this.createVault().remove(path);
    } finally {
      this.internalAssetWrites.delete(path);
    }
  }

  private async removeTransferredAttachment(file: TFile, warning: string): Promise<boolean> {
    const path = normalizeVaultPath(file.path);
    this.internalAssetWrites.add(path);
    try {
      await this.app.fileManager.trashFile(file);
      return true;
    } catch (error) {
      this.logger.warn(warning, { path, error: String(error) });
      return false;
    } finally {
      this.internalAssetWrites.delete(path);
    }
  }

  private recordPrivateMigration(): void {
    if (!shouldTrackPrivateSyncEvent(this.settings())) return;
    // Attachment moves may affect several references and can occur before the
    // final Vault events arrive, so recover once rather than guessing paths.
    this.queuePrivatePaths([], true);
    this.schedulePrivateSync();
  }

  private manifestEntry(plan: AttachmentPlan): AssetManifestEntry {
    return {
      sha256: plan.hash,
      size: plan.size,
      mime: plan.mime,
      uploadedAt: new Date().toISOString(),
      uploadedBy: this.settings().gitUsername.trim() || "unknown",
      ...(this.settings().installationId ? { uploadedFrom: this.settings().installationId } : {})
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
    this.pruneRemoteAttachmentIssues(after);
    const entries = Object.entries(after.files).filter(([path, entry]) => {
      const previous = before.files[path];
      const localFileExists = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
      return this.remoteAttachmentIssues.has(path) || shouldMaterializeRemoteAttachment(previous, entry, localFileExists);
    });
    if (!entries.length) return;
    const vault = this.createVault();
    const attachmentStore = createAttachmentStore(this.settings(), this.logger);
    if (!attachmentStore.enabled()) throw new Error("公共附件对象存储配置不完整");
    const username = this.settings().gitUsername.trim() || "unknown";
    const installationId = this.settings().installationId;
    this.startProgress("下载远端附件", entries.length);
    for (const [path, entry] of entries) {
      try {
        const localStat = await vault.stat(path);
        const localHashNameMatches = hashFromAssetPath(path) === entry.sha256 && localStat?.type === "file" && localStat.size === entry.size;
        let matches = localHashNameMatches;
        if (!matches && localStat?.type === "file" && entry.size <= S3_CHUNKED_DOWNLOAD_THRESHOLD) {
          const local = await vault.read(path);
          matches = await sha256Hex(local) === entry.sha256;
        }
        if (matches) {
          this.remoteAttachmentIssues.delete(path);
          this.advanceProgress(path);
          continue;
        }
        if (shouldProtectMismatchedLocalAttachment(localStat?.type === "file", entry.uploadedBy, entry.uploadedFrom, installationId, username)) {
          this.remoteAttachmentIssues.set(path, `本地附件与远端清单不一致，已保留本地文件：${path}`);
          this.logger.warn("Local attachment differs from same-user manifest entry", { path, hash: entry.sha256 });
          this.advanceProgress(path);
          continue;
        }
        const downloadStartedAt = Date.now();
        this.logger.debug("Attachment download started", { path, hash: entry.sha256, expectedSize: entry.size });
        if (entry.size > S3_CHUNKED_DOWNLOAD_THRESHOLD) {
          const temporaryPath = `${this.app.vault.configDir}/plugins/team-core/.downloads/${entry.sha256}.part`;
          if (await vault.exists(temporaryPath)) await vault.remove(temporaryPath);
          this.internalAssetWrites.add(path);
          try {
            await attachmentStore.downloadInChunks(entry.sha256, entry.size, (chunk) => vault.append(temporaryPath, chunk));
            this.logger.debug("Attachment Vault write started", { path, size: entry.size });
            await vault.rename(temporaryPath, path);
          } finally {
            this.internalAssetWrites.delete(path);
            if (await vault.exists(temporaryPath)) await vault.remove(temporaryPath);
          }
          this.logger.debug("Attachment Vault write completed", { path, size: entry.size, durationMs: Date.now() - downloadStartedAt });
          this.logger.debug("Attachment download completed", { path, hash: entry.sha256, size: entry.size, durationMs: Date.now() - downloadStartedAt });
        } else {
          const data = await attachmentStore.download(entry.sha256);
          if (data.byteLength !== entry.size) throw new Error(`附件大小校验失败：${path}`);
          this.logger.debug("Attachment Vault write started", { path, size: data.byteLength });
          await vault.write(path, data);
          this.logger.debug("Attachment Vault write completed", { path, size: data.byteLength, durationMs: Date.now() - downloadStartedAt });
          this.logger.debug("Attachment download completed", { path, hash: entry.sha256, size: data.byteLength, durationMs: Date.now() - downloadStartedAt });
        }
        this.remoteAttachmentIssues.delete(path);
      } catch (error) {
        if (error instanceof S3NotFoundError) {
          this.remoteAttachmentIssues.set(path, `远端附件对象暂不可用：${path}（${entry.sha256}）`);
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
  }

  /** Git may be up to date while attachment bytes are still temporarily unavailable. */
  private pruneRemoteAttachmentIssues(manifest: AssetManifest): void {
    for (const path of this.remoteAttachmentIssues.keys()) {
      if (!manifest.files[path]) this.remoteAttachmentIssues.delete(path);
    }
  }

  /** Git may be up to date while attachment bytes are still temporarily unavailable. */
  private finishRemoteAttachmentState(): boolean {
    if (!this.remoteAttachmentIssues.size) {
      this.lastError = "";
      return true;
    }
    const [path, message] = [...this.remoteAttachmentIssues.entries()].sort(([left], [right]) => left.localeCompare(right))[0];
    this.lastError = `${message}。将在下次同步重试；请确认上传该附件的设备或对象存储仍可访问。`;
    this.logger.error("Remote attachment materialization incomplete", { path, issues: this.remoteAttachmentIssues.size });
    this.setState("error");
    return false;
  }

  private setState(state: SyncState): void {
    const previous = this.state;
    this.state = state;
    this.logger.debug("Synchronization state changed", { syncRunId: this.activeSyncRunId, from: previous, to: state, pendingFiles: this.pendingFiles.size, pendingAssets: this.pendingAssets.size, privateSyncDirty: this.privateSyncDirty, privatePendingPaths: this.privatePendingPaths.size, privateSyncEnabled: this.settings().privateSyncEnabled, progress: this.progress ? { phase: this.progress.phase, current: this.progress.current, total: this.progress.total } : undefined });
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
