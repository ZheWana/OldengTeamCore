import type { PrivateSyncEntry, PrivateSyncState, TeamCoreSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { base64UrlDecodeBytes, base64UrlEncodeBytes } from "./crypto";
import { normalizeAuthorDisplayMappings } from "./author-display";
import { normalizeVaultPath } from "./vault";
import { compressSync, decompressSync, strFromU8, strToU8 } from "fflate";

const IMPORT_VERSION = 1;
const COMPRESSED_PREFIX = "tc1.";
const PRIVATE_COMPRESSED_PREFIX = "tcp1.";

type SharedSettings = Pick<TeamCoreSettings,
  | "gitUrl"
  | "gitUsername"
  | "gitPassword"
  | "s3Endpoint"
  | "s3Region"
  | "s3Bucket"
  | "s3Prefix"
  | "s3AccessKey"
  | "s3SecretKey"
  | "attachmentStorageProvider"
  | "attachmentWebdavUrl"
  | "attachmentWebdavUsername"
  | "attachmentWebdavPassword"
  | "autoSync"
  | "debounceMs"
  | "syncIntervalMs"
  | "authorDisplayMappings">;

interface ImportBundle {
  version: 1;
  settings: Omit<SharedSettings, "gitUsername" | "autoSync">;
}

function selectSettings(settings: TeamCoreSettings): SharedSettings {
  return {
    gitUrl: settings.gitUrl,
    gitUsername: settings.gitUsername,
    gitPassword: settings.gitPassword,
    s3Endpoint: settings.s3Endpoint,
    s3Region: settings.s3Region,
    s3Bucket: settings.s3Bucket,
    s3Prefix: settings.s3Prefix,
    s3AccessKey: settings.s3AccessKey,
    s3SecretKey: settings.s3SecretKey,
    attachmentStorageProvider: settings.attachmentStorageProvider,
    attachmentWebdavUrl: settings.attachmentWebdavUrl,
    attachmentWebdavUsername: settings.attachmentWebdavUsername,
    attachmentWebdavPassword: settings.attachmentWebdavPassword,
    autoSync: settings.autoSync,
    debounceMs: settings.debounceMs,
    syncIntervalMs: settings.syncIntervalMs,
    authorDisplayMappings: settings.authorDisplayMappings
  };
}

function sharedSettings(settings: TeamCoreSettings): ImportBundle {
  const { gitUsername: _ignored, autoSync: _localAutoSync, ...general } = selectSettings(settings);
  return { version: IMPORT_VERSION, settings: general };
}

export function exportSettings(settings: TeamCoreSettings): string {
  const payload = compressSync(strToU8(JSON.stringify(sharedSettings(settings))));
  return `${COMPRESSED_PREFIX}${base64UrlEncodeBytes(payload)}`;
}

interface PrivateImportBundle {
  version: 1;
  settings: Pick<TeamCoreSettings,
    | "privateSyncProvider"
    | "privateSyncWithTeam"
    | "privateWebdavUrl"
    | "privateWebdavUsername"
    | "privateWebdavPassword"
    | "privateS3Endpoint"
    | "privateS3Region"
    | "privateS3Bucket"
    | "privateS3Prefix"
    | "privateS3AccessKey"
    | "privateS3SecretKey">;
}

function privateSettings(settings: TeamCoreSettings): PrivateImportBundle["settings"] {
  return {
    privateSyncProvider: settings.privateSyncProvider,
    privateSyncWithTeam: settings.privateSyncWithTeam,
    privateWebdavUrl: settings.privateWebdavUrl,
    privateWebdavUsername: settings.privateWebdavUsername,
    privateWebdavPassword: settings.privateWebdavPassword,
    privateS3Endpoint: settings.privateS3Endpoint,
    privateS3Region: settings.privateS3Region,
    privateS3Bucket: settings.privateS3Bucket,
    privateS3Prefix: settings.privateS3Prefix,
    privateS3AccessKey: settings.privateS3AccessKey,
    privateS3SecretKey: settings.privateS3SecretKey
  };
}

export function exportPrivateSettings(settings: TeamCoreSettings): string {
  const payload = compressSync(strToU8(JSON.stringify({ version: 1, settings: privateSettings(settings) } satisfies PrivateImportBundle)));
  return `${PRIVATE_COMPRESSED_PREFIX}${base64UrlEncodeBytes(payload)}`;
}

export function importPrivateSettings(encoded: string, current: TeamCoreSettings): TeamCoreSettings {
  let parsed: unknown;
  try {
    const value = encoded.trim();
    if (!value.startsWith(PRIVATE_COMPRESSED_PREFIX)) throw new Error("unsupported private configuration format");
    parsed = JSON.parse(strFromU8(decompressSync(base64UrlDecodeBytes(value.slice(PRIVATE_COMPRESSED_PREFIX.length)))));
  } catch {
    throw new Error("私人笔记配置字符串无法解析");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("私人笔记配置字符串格式无效");
  const bundle = parsed as Partial<PrivateImportBundle>;
  if (bundle.version !== 1 || !bundle.settings || typeof bundle.settings !== "object") throw new Error("不支持的私人笔记配置版本");
  const next = { ...current, ...bundle.settings, privateSyncEnabled: true };
  return normalizeSettings(next);
}

export function importSettings(encoded: string, current: TeamCoreSettings): TeamCoreSettings {
  let parsed: unknown;
  try {
    const value = encoded.trim();
    if (!value.startsWith(COMPRESSED_PREFIX)) throw new Error("unsupported configuration format");
    const compressed = value.slice(COMPRESSED_PREFIX.length);
    if (!compressed) throw new Error("empty configuration payload");
    parsed = JSON.parse(strFromU8(decompressSync(base64UrlDecodeBytes(compressed))));
  } catch {
    throw new Error("配置字符串无法解析");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("配置字符串格式无效");
  const bundle = parsed as Partial<ImportBundle>;
  if (bundle.version !== IMPORT_VERSION || !bundle.settings || typeof bundle.settings !== "object") throw new Error("不支持的配置版本");
  const input = bundle.settings as Partial<SharedSettings>;
  if (input.authorDisplayMappings !== undefined && (!input.authorDisplayMappings || typeof input.authorDisplayMappings !== "object" || Array.isArray(input.authorDisplayMappings))) {
    throw new Error("Git 作者显示名称映射无效");
  }
  const merged = selectSettings({
    ...DEFAULT_SETTINGS,
    ...selectSettings(current),
    ...input,
    autoSync: current.autoSync,
    gitUsername: current.gitUsername
  });
  if (typeof merged.gitUrl !== "string" || typeof merged.gitPassword !== "string" || typeof merged.s3Endpoint !== "string" || typeof merged.s3Bucket !== "string" || typeof merged.attachmentWebdavUrl !== "string") throw new Error("配置字段无效");
  if (typeof merged.autoSync !== "boolean") throw new Error("自动同步开关无效");
  merged.authorDisplayMappings = normalizeAuthorDisplayMappings(merged.authorDisplayMappings);
  if (!Number.isFinite(merged.debounceMs) || merged.debounceMs < 1_000 || !Number.isFinite(merged.syncIntervalMs) || merged.syncIntervalMs < 10_000) throw new Error("同步时间必须为有效的毫秒数");
  return normalizeSettings({ ...current, ...merged });
}

export function mergeSettings(data: unknown): TeamCoreSettings {
  const input = data && typeof data === "object" ? data as Partial<TeamCoreSettings> : {};
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    gitUrl: typeof input.gitUrl === "string" ? input.gitUrl : DEFAULT_SETTINGS.gitUrl,
    autoSync: typeof input.autoSync === "boolean" ? input.autoSync : DEFAULT_SETTINGS.autoSync,
    gitUsername: typeof input.gitUsername === "string" ? input.gitUsername : DEFAULT_SETTINGS.gitUsername,
    gitPassword: typeof input.gitPassword === "string" ? input.gitPassword : DEFAULT_SETTINGS.gitPassword,
    s3Endpoint: typeof input.s3Endpoint === "string" ? input.s3Endpoint : DEFAULT_SETTINGS.s3Endpoint,
    s3Region: typeof input.s3Region === "string" ? input.s3Region : DEFAULT_SETTINGS.s3Region,
    s3Bucket: typeof input.s3Bucket === "string" ? input.s3Bucket : DEFAULT_SETTINGS.s3Bucket,
    s3Prefix: typeof input.s3Prefix === "string" ? input.s3Prefix : DEFAULT_SETTINGS.s3Prefix,
    s3AccessKey: typeof input.s3AccessKey === "string" ? input.s3AccessKey : DEFAULT_SETTINGS.s3AccessKey,
    s3SecretKey: typeof input.s3SecretKey === "string" ? input.s3SecretKey : DEFAULT_SETTINGS.s3SecretKey,
    attachmentStorageProvider: input.attachmentStorageProvider === "webdav" ? "webdav" : "s3",
    attachmentWebdavUrl: typeof input.attachmentWebdavUrl === "string" ? input.attachmentWebdavUrl : DEFAULT_SETTINGS.attachmentWebdavUrl,
    attachmentWebdavUsername: typeof input.attachmentWebdavUsername === "string" ? input.attachmentWebdavUsername : DEFAULT_SETTINGS.attachmentWebdavUsername,
    attachmentWebdavPassword: typeof input.attachmentWebdavPassword === "string" ? input.attachmentWebdavPassword : DEFAULT_SETTINGS.attachmentWebdavPassword,
    debounceMs: typeof input.debounceMs === "number" ? input.debounceMs : DEFAULT_SETTINGS.debounceMs,
    syncIntervalMs: typeof input.syncIntervalMs === "number" ? input.syncIntervalMs : DEFAULT_SETTINGS.syncIntervalMs,
    authorDisplayMappings: input.authorDisplayMappings ?? DEFAULT_SETTINGS.authorDisplayMappings,
    privateSyncEnabled: typeof input.privateSyncEnabled === "boolean" ? input.privateSyncEnabled : DEFAULT_SETTINGS.privateSyncEnabled,
    privateSyncWithTeam: typeof input.privateSyncWithTeam === "boolean" ? input.privateSyncWithTeam : DEFAULT_SETTINGS.privateSyncWithTeam,
    privateSyncProvider: input.privateSyncProvider === "s3" ? "s3" : "webdav",
    privateWebdavUrl: typeof input.privateWebdavUrl === "string" ? input.privateWebdavUrl : DEFAULT_SETTINGS.privateWebdavUrl,
    privateWebdavUsername: typeof input.privateWebdavUsername === "string" ? input.privateWebdavUsername : DEFAULT_SETTINGS.privateWebdavUsername,
    privateWebdavPassword: typeof input.privateWebdavPassword === "string" ? input.privateWebdavPassword : DEFAULT_SETTINGS.privateWebdavPassword,
    privateS3Endpoint: typeof input.privateS3Endpoint === "string" ? input.privateS3Endpoint : DEFAULT_SETTINGS.privateS3Endpoint,
    privateS3Region: typeof input.privateS3Region === "string" ? input.privateS3Region : DEFAULT_SETTINGS.privateS3Region,
    privateS3Bucket: typeof input.privateS3Bucket === "string" ? input.privateS3Bucket : DEFAULT_SETTINGS.privateS3Bucket,
    privateS3Prefix: typeof input.privateS3Prefix === "string" ? input.privateS3Prefix : DEFAULT_SETTINGS.privateS3Prefix,
    privateS3AccessKey: typeof input.privateS3AccessKey === "string" ? input.privateS3AccessKey : DEFAULT_SETTINGS.privateS3AccessKey,
    privateS3SecretKey: typeof input.privateS3SecretKey === "string" ? input.privateS3SecretKey : DEFAULT_SETTINGS.privateS3SecretKey,
    privateSyncState: normalizePrivateSyncState(input.privateSyncState),
    installationId: normalizeInstallationId(input.installationId)
  });
}

function normalizePrivateSyncState(value: unknown): PrivateSyncState {
  if (!value || typeof value !== "object") return { version: 1, entries: {} };
  const input = value as Partial<PrivateSyncState>;
  if (input.version !== 1 || !input.entries || typeof input.entries !== "object" || Array.isArray(input.entries)) return { version: 1, entries: {} };
  const entries: Record<string, PrivateSyncEntry> = {};
  for (const [path, raw] of Object.entries(input.entries)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw;
    const validHash = entry.sha256 === undefined || (typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256));
    const validSize = entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0);
    const validUpdated = entry.updatedAt === undefined || (Number.isFinite(entry.updatedAt) && entry.updatedAt > 0);
    const validDeleted = entry.deletedAt === undefined || (Number.isFinite(entry.deletedAt) && entry.deletedAt > 0);
    const validObjectKey = entry.objectKey === undefined || (typeof entry.objectKey === "string" && entry.objectKey.startsWith("oldeng-team-core-private/v1/files/") && !entry.objectKey.includes(".."));
    if (!path || !validHash || !validSize || !validUpdated || !validDeleted || !validObjectKey || (!entry.sha256 && !entry.deletedAt)) continue;
    entries[path] = {
      ...(entry.sha256 ? { sha256: entry.sha256.toLowerCase() } : {}),
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt }),
      ...(entry.objectKey ? { objectKey: entry.objectKey } : {})
    };
  }
  const pendingPaths = Array.isArray(input.pendingPaths)
    ? [...new Set(input.pendingPaths
      .filter((path): path is string => typeof path === "string")
      .map((path) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter((path) => path.length > 0 && !path.startsWith("../") && !path.includes("/../")))].sort()
    : [];
  return { version: 1, entries, baselineEstablished: input.baselineEstablished === true, pendingPaths };
}

function normalizeInstallationId(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{48}$/i.test(value) ? value.toLowerCase() : "";
}

function normalizePendingPublicMoves(value: unknown): TeamCoreSettings["pendingPublicMoves"] {
  if (!Array.isArray(value)) return [];
  const moves = new Map<string, { from: string; to: string }>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const source = item as { from?: unknown; to?: unknown };
    if (typeof source.from !== "string" || typeof source.to !== "string") continue;
    const from = normalizeVaultPath(source.from);
    const to = normalizeVaultPath(source.to);
    if (!from || !to || from === to) continue;
    moves.set(from, { from, to });
  }
  return [...moves.values()].sort((left, right) => left.from.localeCompare(right.from));
}

function normalizeSettings(input: TeamCoreSettings): TeamCoreSettings {
  const merged: TeamCoreSettings = {
    ...DEFAULT_SETTINGS,
    ...input,
    privateSyncEnabled: typeof input.privateSyncEnabled === "boolean" ? input.privateSyncEnabled : false,
    privateSyncWithTeam: typeof input.privateSyncWithTeam === "boolean" ? input.privateSyncWithTeam : false,
    attachmentStorageProvider: input.attachmentStorageProvider === "webdav" ? "webdav" : "s3",
    privateSyncProvider: input.privateSyncProvider === "s3" ? "s3" : "webdav",
    privateSyncState: normalizePrivateSyncState(input.privateSyncState),
    installationId: normalizeInstallationId(input.installationId),
    pendingDeletionPaths: Array.isArray(input.pendingDeletionPaths)
      ? [...new Set(input.pendingDeletionPaths.filter((path): path is string => typeof path === "string").map(normalizeVaultPath).filter(Boolean))].sort()
      : [],
    pendingDeletionFolders: Array.isArray(input.pendingDeletionFolders)
      ? [...new Set(input.pendingDeletionFolders.filter((path): path is string => typeof path === "string").map(normalizeVaultPath).filter(Boolean))].sort()
      : [],
    pendingPublicMoves: normalizePendingPublicMoves(input.pendingPublicMoves),
    assetRetention: Array.isArray(input.assetRetention)
      ? input.assetRetention.filter((item): item is { sha256: string; size: number; markedAt: string } => Boolean(item && typeof item === "object"
        && typeof (item as { sha256?: unknown }).sha256 === "string" && /^[0-9a-f]{64}$/i.test((item as { sha256: string }).sha256)
        && Number.isSafeInteger((item as { size?: unknown }).size) && (item as { size: number }).size >= 0
        && typeof (item as { markedAt?: unknown }).markedAt === "string" && !Number.isNaN(Date.parse((item as { markedAt: string }).markedAt))))
        .map((item) => ({ sha256: item.sha256.toLowerCase(), size: item.size, markedAt: new Date(item.markedAt).toISOString() }))
      : []
  };
  try {
    return { ...merged, authorDisplayMappings: normalizeAuthorDisplayMappings(input.authorDisplayMappings) };
  } catch {
    return { ...merged, authorDisplayMappings: {} };
  }
}
