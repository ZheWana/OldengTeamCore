export type SyncState =
  | "uninitialized"
  | "synced"
  | "local-changes"
  | "syncing"
  | "conflict"
  | "offline"
  | "error";

export type PrivateSyncProvider = "webdav" | "s3";

export interface PrivateSyncEntry {
  sha256?: string;
  size?: number;
  updatedAt?: number;
  deletedAt?: number;
}

export interface PrivateSyncState {
  version: 1;
  entries: Record<string, PrivateSyncEntry>;
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
  autoSync: boolean;
  debounceMs: number;
  syncIntervalMs: number;
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
  autoSync: false,
  debounceMs: 60_000,
  syncIntervalMs: 300_000,
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
  privateSyncState: { version: 1, entries: {} }
};

export interface AssetManifestEntry {
  sha256: string;
  size: number;
  mime: string;
  uploadedAt: string;
  uploadedBy: string;
}

export interface AssetManifest {
  version: 1;
  files: Record<string, AssetManifestEntry>;
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
  progress?: SyncProgress;
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
