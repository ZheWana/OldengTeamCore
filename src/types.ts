export type SyncState =
  | "uninitialized"
  | "synced"
  | "local-changes"
  | "syncing"
  | "conflict"
  | "offline"
  | "error";

export type PrivateSyncProvider = "webdav" | "s3";
export type AttachmentStorageProvider = "webdav" | "s3";

export interface PrivateSyncEntry {
  sha256?: string;
  size?: number;
  updatedAt?: number;
  deletedAt?: number;
  /** Immutable remote object path. Legacy entries use their original path. */
  objectKey?: string;
}

export interface PrivateSyncState {
  version: 1;
  entries: Record<string, PrivateSyncEntry>;
  /** A complete local baseline has been established at least once. */
  baselineEstablished?: boolean;
  /**
   * Local paths changed since the last confirmed private-sync baseline. This
   * journal survives a plugin reload so routine synchronization can inspect
   * only changed files instead of hashing the whole private workspace.
   */
  pendingPaths?: string[];
}

export interface TeamCoreSettings {
  gitUrl: string;
  gitUsername: string;
  gitPassword: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKey: string;
  s3SecretKey: string;
  /** Shared public-attachment object store. Existing installs stay on S3. */
  attachmentStorageProvider: AttachmentStorageProvider;
  attachmentWebdavUrl: string;
  attachmentWebdavUsername: string;
  attachmentWebdavPassword: string;
  autoSync: boolean;
  /** Sliding quiet window before an automatic sync is allowed to start. */
  autoSyncIdleMs: number;
  authorDisplayMappings: Record<string, string>;
  privateSyncEnabled: boolean;
  privateSyncWithTeam: boolean;
  privateSyncProvider: PrivateSyncProvider;
  privateWebdavUrl: string;
  privateWebdavUsername: string;
  privateWebdavPassword: string;
  privateS3Endpoint: string;
  privateS3Region: string;
  privateS3Bucket: string;
  privateS3Prefix: string;
  privateS3AccessKey: string;
  privateS3SecretKey: string;
  privateSyncState: PrivateSyncState;
  /** Stable, local-only installation identity. It is never shared in configuration bundles. */
  installationId: string;
  /** Public paths deleted locally and awaiting explicit remote-impact confirmation. */
  pendingDeletionPaths: string[];
  /** Deleted public folders, retained so confirmation can restore a whole folder at once. */
  pendingDeletionFolders: string[];
  /** Public Vault rename events awaiting an explicit sync-impact acknowledgement. */
  pendingPublicMoves: PendingPublicMove[];
  /**
   * Local-only checkpoint for the pull-first public synchronization transaction.
   * It deliberately references a Git stash rather than carrying note bytes in
   * data.json, so an interrupted operation can be recovered without copying
   * the knowledge base into plugin settings.
   */
  publicSyncTransaction?: PublicSyncTransaction;
}

export const DEFAULT_SETTINGS: TeamCoreSettings = {
  gitUrl: "",
  gitUsername: "",
  gitPassword: "",
  s3Endpoint: "",
  s3Region: "",
  s3Bucket: "",
  s3Prefix: "",
  s3AccessKey: "",
  s3SecretKey: "",
  attachmentStorageProvider: "s3",
  attachmentWebdavUrl: "",
  attachmentWebdavUsername: "",
  attachmentWebdavPassword: "",
  autoSync: false,
  autoSyncIdleMs: 60_000,
  authorDisplayMappings: {},
  privateSyncEnabled: false,
  privateSyncWithTeam: false,
  privateSyncProvider: "webdav",
  privateWebdavUrl: "",
  privateWebdavUsername: "",
  privateWebdavPassword: "",
  privateS3Endpoint: "",
  privateS3Region: "",
  privateS3Bucket: "",
  privateS3Prefix: "",
  privateS3AccessKey: "",
  privateS3SecretKey: "",
  privateSyncState: { version: 1, entries: {}, baselineEstablished: false, pendingPaths: [] },
  installationId: "",
  pendingDeletionPaths: [],
  pendingDeletionFolders: [],
  pendingPublicMoves: [],
  publicSyncTransaction: undefined
};

export interface PendingPublicMove {
  from: string;
  to: string;
}

export interface PublicSyncTransaction {
  version: 1;
  id: string;
  /** HEAD when the temporary stash was created. */
  baseOid: string;
  /** Git's temporary-stash lifecycle; persisted before each non-idempotent step. */
  phase: "preparing" | "stashed" | "remote-merged" | "restoring" | "conflict" | "restored";
  startedAt: string;
  stashOid?: string;
  /** Fetched/integrated remote HEAD used as the three-way replay target. */
  remoteOid?: string;
  /** Durable, unreferenced merge commit whose tree is safe to materialize idempotently. */
  mergedOid?: string;
}

export interface AssetManifestEntry {
  sha256: string;
  size: number;
  mime: string;
  uploadedAt: string;
  uploadedBy: string;
  /** Stable installation ID of the uploader, when produced by a current client. */
  uploadedFrom?: string;
}

export interface AssetManifest {
  version: 1;
  files: Record<string, AssetManifestEntry>;
  /**
   * Shared deletion tombstones for content-addressed attachment objects.
   * These belong to the Git-tracked manifest rather than plugin-local state,
   * so every member uses the same 30-day recovery window.
   */
  retired: Record<string, AssetRetentionRecord>;
}

export interface AssetRetentionRecord {
  sha256: string;
  size: number;
  markedAt: string;
}

export interface CommitSummary {
  oid: string;
  shortOid: string;
  parents: string[];
  message: string;
  author: string;
  email: string;
  timestamp: number;
  files?: string[];
}

export interface CommitDocumentChange {
  path: string;
  status: "added" | "modified" | "deleted";
  previousLineCount?: number;
  currentLineCount?: number;
}

export interface CommitPluginChange {
  name: string;
  version?: string;
  changedFileCount: number;
}

/**
 * Human-facing categories for one commit. Paths remain in the Git layer so
 * callers can render document names without exposing implementation files.
 */
export interface CommitChangeDetails {
  markdownPaths: string[];
  documentChanges: CommitDocumentChange[];
  pluginNames: string[];
  pluginChanges: CommitPluginChange[];
  attachmentDocumentPaths: string[];
  hasUnassociatedAttachmentChanges: boolean;
  sharedPluginStateChanged: boolean;
  fileAuthorsChanged: boolean;
  sharedPluginRulesChanged: boolean;
  hasOtherChanges: boolean;
}

export interface ReferenceInfo {
  path: string;
  references: string[];
  count: number;
  orphan: boolean;
}

export interface SyncSnapshot {
  state: SyncState;
  lastError?: string;
  lastSyncAt?: number;
  currentAuthor?: string;
  pendingFiles: string[];
  pendingAssets?: string[];
  /** Areas currently reporting local changes; derived from Git/private journal. */
  localChangeAreas?: Array<"public" | "private">;
  progress?: SyncProgress;
}

export type LocalChangeArea = "public" | "private";
export type LocalChangeCategory = "documents" | "attachments" | "settings" | "other";
export type LocalChangeStatus = "added" | "modified" | "deleted" | "pending";

/** One local change awaiting either public Git or private-note synchronization. */
export interface LocalChangeItem {
  path: string;
  area: LocalChangeArea;
  category: LocalChangeCategory;
  status: LocalChangeStatus;
}

/** Read-only view model for the local-changes page. */
export interface LocalChangeSnapshot {
  publicChanges: LocalChangeItem[];
  privateChanges: LocalChangeItem[];
  privateSyncEnabled: boolean;
}

export interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  item?: string;
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}
