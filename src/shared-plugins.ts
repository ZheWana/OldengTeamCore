import { PRIVATE_PREFIX } from "./constants";
import { normalizeVaultPath, type BinaryVault } from "./vault";

export const SHARED_PLUGINS_START = "# >>> Oldeng Team Core shared plugins";
export const SHARED_PLUGINS_END = "# <<< Oldeng Team Core shared plugins";
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface LocalCommunityPlugin {
  id: string;
  name: string;
  version?: string;
}

function configPath(configDir: string): string {
  return normalizeVaultPath(configDir) || ".obsidian";
}

function pluginPrefix(configDir: string): string {
  return `${configPath(configDir)}/plugins/`;
}

export function isSafeSharedPluginId(value: string): boolean {
  return value.length > 0 && value.length <= 100 && value !== "." && value !== ".." && PLUGIN_ID_PATTERN.test(value);
}

export function normalizeSharedPluginIds(ids: readonly string[]): string[] {
  const invalid = ids.find((id) => !isSafeSharedPluginId(id) || id === "team-core");
  if (invalid !== undefined) throw new Error(`共享插件 ID 无效或禁止共享：${invalid}`);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function isPluginPath(path: string, configDir: string): boolean {
  const normalized = normalizeVaultPath(path);
  const prefix = pluginPrefix(configDir);
  return normalized.startsWith(prefix) && normalized.slice(prefix.length).length > 0;
}

export function pluginIdFromPath(path: string, configDir: string): string | undefined {
  const normalized = normalizeVaultPath(path);
  const prefix = pluginPrefix(configDir);
  if (!normalized.startsWith(prefix)) return undefined;
  const remainder = normalized.slice(prefix.length);
  const id = remainder.split("/")[0];
  return isSafeSharedPluginId(id) ? id : undefined;
}

export function isPotentialPluginPath(path: string, configDir: string): boolean {
  const id = pluginIdFromPath(path, configDir);
  return Boolean(id && id !== "team-core");
}

export function isSharedPluginPath(path: string, configDir: string, ids: readonly string[]): boolean {
  const id = pluginIdFromPath(path, configDir);
  return Boolean(id && id !== "team-core" && ids.includes(id));
}

export function readSharedPluginIdsFromGitignore(content: string, configDir: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.indexOf(SHARED_PLUGINS_START);
  if (start < 0) return [];
  const end = lines.indexOf(SHARED_PLUGINS_END, start + 1);
  if (end < 0) throw new Error(".gitignore 中的共享插件区块不完整，请补齐结束标记后再同步");

  const prefix = pluginPrefix(configDir);
  const ids: string[] = [];
  for (const rawLine of lines.slice(start + 1, end)) {
    const line = rawLine.trim();
    if (!line.startsWith(`!${prefix}`) || !line.endsWith("/**")) continue;
    const id = line.slice(prefix.length + 1, -3).replace(/\/$/, "");
    if (!isSafeSharedPluginId(id)) throw new Error(`.gitignore 中的共享插件 ID 无效：${id}`);
    if (id === "team-core") throw new Error("team-core 不允许加入共享插件白名单");
    ids.push(id);
  }
  return normalizeSharedPluginIds(ids);
}

export function updateSharedPluginsInGitignore(content: string, configDir: string, ids: readonly string[]): string {
  const normalizedIds = normalizeSharedPluginIds(ids);
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  let lines = normalizedContent.split("\n");
  const start = lines.indexOf(SHARED_PLUGINS_START);
  if (start >= 0) {
    const end = lines.indexOf(SHARED_PLUGINS_END, start + 1);
    if (end < 0) throw new Error(".gitignore 中的共享插件区块不完整，请补齐结束标记后再保存");
    lines = [...lines.slice(0, start), ...lines.slice(end + 1)];
  }

  // This exact rule was written by older Team Core releases. Remove it so
  // the negative rules below can traverse the config directory again.
  const config = configPath(configDir);
  lines = lines.filter((line) => line.trim() !== `${config}/`);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const prefix = pluginPrefix(configDir);
  const block = [
    SHARED_PLUGINS_START,
    `!${config}/`,
    `${config}/*`,
    `!${prefix}`,
    `${config}/plugins/*`,
    ...normalizedIds.flatMap((id) => [`!${prefix}${id}/`, `!${prefix}${id}/**`]),
    SHARED_PLUGINS_END
  ];
  if (lines.length) lines.push("");
  lines.push(...block);
  return `${lines.join("\n")}\n`;
}

export async function readSharedPluginIds(vault: BinaryVault, configDir: string): Promise<string[]> {
  if (!(await vault.exists(".gitignore"))) return [];
  const content = new TextDecoder().decode(await vault.read(".gitignore"));
  return readSharedPluginIdsFromGitignore(content, configDir);
}

export async function writeSharedPluginIds(vault: BinaryVault, configDir: string, ids: readonly string[]): Promise<void> {
  let current = "";
  if (await vault.exists(".gitignore")) current = new TextDecoder().decode(await vault.read(".gitignore"));
  let next = updateSharedPluginsInGitignore(current, configDir, ids);
  const lines = next.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const entry of ["assets/", PRIVATE_PREFIX]) if (!lines.some((line) => line.trim() === entry)) lines.push(entry);
  next = `${lines.join("\n")}\n`;
  if (next === current.replace(/\r\n?/g, "\n")) return;
  const encoded = new TextEncoder().encode(next);
  await vault.write(".gitignore", encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
}

export async function listLocalCommunityPlugins(vault: BinaryVault, configDir: string): Promise<LocalCommunityPlugin[]> {
  const root = pluginPrefix(configDir).replace(/\/$/, "");
  if (!(await vault.exists(root))) return [];
  const entries = await vault.list(root);
  const plugins: LocalCommunityPlugin[] = [];
  for (const folder of entries.folders) {
    const id = normalizeVaultPath(folder).split("/").pop() ?? "";
    if (!isSafeSharedPluginId(id) || id === "team-core") continue;
    let name = id;
    let version: string | undefined;
    const manifestPath = `${root}/${id}/manifest.json`;
    if (await vault.exists(manifestPath)) {
      try {
        const manifest = JSON.parse(new TextDecoder().decode(await vault.read(manifestPath))) as { name?: unknown; version?: unknown };
        if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name.trim();
        if (typeof manifest.version === "string" && manifest.version.trim()) version = manifest.version.trim();
      } catch {
        // The folder can still be shared; keep its stable directory ID visible.
      }
    }
    plugins.push({ id, name, version });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
