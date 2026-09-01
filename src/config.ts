import type { TeamCoreSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { base64UrlDecodeBytes, base64UrlEncodeBytes } from "./crypto";
import { normalizeAuthorDisplayMappings } from "./author-display";
import { compressSync, decompressSync, strFromU8, strToU8 } from "fflate";

const IMPORT_VERSION = 1;
const COMPRESSED_PREFIX = "tc1.";

interface ImportBundle {
  version: 1;
  settings: Omit<TeamCoreSettings, "gitUsername" | "autoSync">;
}

function selectSettings(settings: TeamCoreSettings): TeamCoreSettings {
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
  const input = bundle.settings as Partial<TeamCoreSettings>;
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
  if (typeof merged.gitUrl !== "string" || typeof merged.gitPassword !== "string" || typeof merged.s3Endpoint !== "string" || typeof merged.s3Bucket !== "string") throw new Error("配置字段无效");
  if (typeof merged.autoSync !== "boolean") throw new Error("自动同步开关无效");
  merged.authorDisplayMappings = normalizeAuthorDisplayMappings(merged.authorDisplayMappings);
  if (!Number.isFinite(merged.debounceMs) || merged.debounceMs < 1_000 || !Number.isFinite(merged.syncIntervalMs) || merged.syncIntervalMs < 10_000) throw new Error("同步时间必须为有效的毫秒数");
  return merged;
}

export function mergeSettings(data: unknown): TeamCoreSettings {
  const input = data && typeof data === "object" ? data as Partial<TeamCoreSettings> : {};
  const merged = selectSettings({
    ...DEFAULT_SETTINGS,
    ...input,
    autoSync: typeof input.autoSync === "boolean" ? input.autoSync : DEFAULT_SETTINGS.autoSync,
    gitUsername: typeof input.gitUsername === "string" ? input.gitUsername : DEFAULT_SETTINGS.gitUsername
  });
  try {
    return { ...merged, authorDisplayMappings: normalizeAuthorDisplayMappings(input.authorDisplayMappings) };
  } catch {
    return { ...merged, authorDisplayMappings: {} };
  }
}
