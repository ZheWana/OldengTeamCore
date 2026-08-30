import type { TeamCoreSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { base64UrlDecode, base64UrlEncode } from "./crypto";
import { normalizeAuthorDisplayMappings } from "./author-display";

const IMPORT_VERSION = 1;

interface ImportBundle {
  version: 1;
  settings: Omit<TeamCoreSettings, "gitUsername" | "autoSync">;
}

function sharedSettings(settings: TeamCoreSettings): ImportBundle {
  const { gitUsername: _ignored, autoSync: _localAutoSync, ...general } = settings;
  return { version: IMPORT_VERSION, settings: general };
}

export function exportSettings(settings: TeamCoreSettings): string {
  return base64UrlEncode(JSON.stringify(sharedSettings(settings)));
}

export function importSettings(encoded: string, current: TeamCoreSettings): TeamCoreSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encoded.trim()));
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
  const merged: TeamCoreSettings = {
    ...DEFAULT_SETTINGS,
    ...current,
    ...input,
    autoSync: current.autoSync,
    gitUsername: current.gitUsername
  };
  if (typeof merged.gitUrl !== "string" || typeof merged.gitPassword !== "string" || typeof merged.s3Endpoint !== "string" || typeof merged.s3Bucket !== "string") throw new Error("配置字段无效");
  if (typeof merged.autoSync !== "boolean") throw new Error("自动同步开关无效");
  merged.authorDisplayMappings = normalizeAuthorDisplayMappings(merged.authorDisplayMappings);
  if (!Number.isFinite(merged.debounceMs) || merged.debounceMs < 1_000 || !Number.isFinite(merged.syncIntervalMs) || merged.syncIntervalMs < 10_000) throw new Error("同步时间必须为有效的毫秒数");
  return merged;
}

export function mergeSettings(data: unknown): TeamCoreSettings {
  const input = data && typeof data === "object" ? data as Partial<TeamCoreSettings> : {};
  const merged = {
    ...DEFAULT_SETTINGS,
    ...input,
    autoSync: typeof input.autoSync === "boolean" ? input.autoSync : DEFAULT_SETTINGS.autoSync,
    gitUsername: typeof input.gitUsername === "string" ? input.gitUsername : DEFAULT_SETTINGS.gitUsername
  };
  try {
    return { ...merged, authorDisplayMappings: normalizeAuthorDisplayMappings(input.authorDisplayMappings) };
  } catch {
    return { ...merged, authorDisplayMappings: {} };
  }
}
