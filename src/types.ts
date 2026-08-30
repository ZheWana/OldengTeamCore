export type SyncState =
  | "uninitialized"
  | "synced"
  | "local-changes"
  | "syncing"
  | "conflict"
  | "offline"
  | "error";

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
  syncIntervalMs: 300_000
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
