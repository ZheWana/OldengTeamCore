import { requestUrl } from "obsidian";

export const UPDATE_INDEX_URL = "https://zhewana.cn/team-core-plugin/index.json";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"] as const;
type PluginFileName = typeof PLUGIN_FILES[number];

export interface PluginReleaseFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PluginRelease {
  version: string;
  minAppVersion: string;
  publishedAt: string;
  notes: string;
  files: Record<PluginFileName, PluginReleaseFile>;
}

export interface PluginReleaseIndex {
  schemaVersion: 1;
  pluginId: string;
  latest: PluginRelease;
  previous: PluginRelease | null;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function validatePluginReleaseIndex(input: unknown, pluginId: string): PluginReleaseIndex {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.pluginId !== pluginId) throw new Error("插件更新索引格式无效");
  const latest = validateRelease(input.latest, pluginId);
  const previous = input.previous === null ? null : validateRelease(input.previous, pluginId);
  if (previous && compareVersions(latest.version, previous.version) <= 0) throw new Error("插件更新索引的版本顺序无效");
  return { schemaVersion: 1, pluginId, latest, previous };
}

export class PluginUpdater {
  constructor(
    private readonly pluginId: string,
    private readonly indexUrl = UPDATE_INDEX_URL
  ) {}

  async fetchIndex(): Promise<PluginReleaseIndex> {
    const separator = this.indexUrl.includes("?") ? "&" : "?";
    const response = await requestUrl({
      url: `${this.indexUrl}${separator}checkedAt=${Date.now()}`,
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      throw: false
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`更新服务器返回 HTTP ${response.status}`);
    let parsed: unknown;
    try { parsed = JSON.parse(response.text); }
    catch { throw new Error("更新服务器返回了无效的 JSON"); }
    return validatePluginReleaseIndex(parsed, this.pluginId);
  }
}

function validateRelease(input: unknown, pluginId: string): PluginRelease {
  if (!isRecord(input)) throw new Error("插件版本信息格式无效");
  const version = expectVersion(input.version, "插件版本");
  const minAppVersion = expectVersion(input.minAppVersion, "Obsidian 最低版本");
  if (typeof input.publishedAt !== "string" || !Number.isFinite(Date.parse(input.publishedAt))) throw new Error("插件发布时间无效");
  if (typeof input.notes !== "string") throw new Error("插件更新说明无效");
  if (!isRecord(input.files)) throw new Error("插件文件清单无效");

  const files = {} as Record<PluginFileName, PluginReleaseFile>;
  for (const name of PLUGIN_FILES) {
    const value = input.files[name];
    if (!isRecord(value)) throw new Error(`插件文件 ${name} 的信息无效`);
    const expectedPath = `releases/${version}/${name}`;
    if (value.path !== expectedPath) throw new Error(`插件文件 ${name} 的路径无效`);
    if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error(`插件文件 ${name} 的 SHA-256 无效`);
    if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) throw new Error(`插件文件 ${name} 的大小无效`);
    files[name] = { path: expectedPath, sha256: value.sha256, size: value.size as number };
  }
  return { version, minAppVersion, publishedAt: input.publishedAt, notes: input.notes, files };
}

function parseVersion(value: string): ParsedVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`无效的版本号：${value}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

function expectVersion(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}无效`);
  try { parseVersion(value); }
  catch { throw new Error(`${label}无效`); }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
