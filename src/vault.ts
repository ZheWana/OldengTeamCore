import type { DataAdapter, TFile, Vault } from "obsidian";
import { ASSETS_PREFIX, PRIVATE_FOLDER, PRIVATE_PREFIX, TRASH_FOLDER, TRASH_PREFIX } from "./constants";
import type { ReferenceInfo } from "./types";

export interface BinaryVault {
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer): Promise<void>;
  append(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive?: boolean): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
}

export function normalizeVaultPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function isManagedPath(path: string, configDir: string, sharedPluginIds: readonly string[] = []): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized.length || normalized.startsWith(ASSETS_PREFIX) || isPrivatePath(normalized) || isTrashPath(normalized)) return false;
  if (!isConfigPath(normalized, configDir)) return true;
  const config = normalizeVaultPath(configDir);
  if (!config) return false;
  const prefix = `${config}/plugins/`;
  if (!normalized.startsWith(prefix)) return false;
  const pluginId = normalized.slice(prefix.length).split("/")[0];
  return pluginId !== "team-core" && sharedPluginIds.includes(pluginId);
}

export function isConfigPath(path: string, configDir: string): boolean {
  const normalized = normalizeVaultPath(path);
  const config = normalizeVaultPath(configDir);
  return config.length > 0 && (normalized === config || normalized.startsWith(`${config}/`));
}

export function isAssetPath(path: string): boolean {
  return normalizeVaultPath(path).startsWith(ASSETS_PREFIX);
}

export const PRIVATE_ASSETS_PREFIX = `${PRIVATE_FOLDER}/${ASSETS_PREFIX}`;

export function isPrivateAssetPath(path: string): boolean {
  return normalizeVaultPath(path).startsWith(PRIVATE_ASSETS_PREFIX);
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]);

export function isImageAttachmentPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  const extension = normalized.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Keep the attachment area out of Obsidian's indexing and search results.
 * This is a presentation-only setting; synchronization still handles assets
 * through the attachment manifest and S3 transport.
 */
export function ensureAssetsExcluded(vault: Vault): boolean {
  const configurable = vault as Vault & {
    getConfig?: (key: string) => unknown;
    setConfig?: (key: string, value: unknown) => void;
  };
  if (typeof configurable.getConfig !== "function" || typeof configurable.setConfig !== "function") return false;
  const configured = configurable.getConfig("userIgnoreFilters");
  const filters = Array.isArray(configured)
    ? (configured as unknown[]).filter((filter): filter is string => typeof filter === "string")
    : [];
  const required = [ASSETS_PREFIX.slice(0, -1), PRIVATE_ASSETS_PREFIX.slice(0, -1)];
  const missing = required.filter((path) => !filters.includes(path));
  if (!missing.length) return false;
  filters.push(...missing);
  configurable.setConfig("userIgnoreFilters", filters);
  return true;
}

/** Returns true only for the root attachment folder, not nested folders. */
export function isRootAssetsPath(path: string): boolean {
  return normalizeVaultPath(path) === ASSETS_PREFIX.slice(0, -1);
}

export function isHiddenAssetsFolderPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === ASSETS_PREFIX.slice(0, -1) || normalized === PRIVATE_ASSETS_PREFIX.slice(0, -1);
}

export function isPrivatePath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === PRIVATE_FOLDER || normalized.startsWith(PRIVATE_PREFIX);
}

export function isTrashPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === TRASH_FOLDER || normalized.startsWith(TRASH_PREFIX);
}

export const CONTENT_ADDRESSED_ASSET_PREFIX = "tc-sha256-";
const CONTENT_ADDRESSED_ASSET_PATTERN = /^tc-sha256-([0-9a-f]{64})(?:\.([a-z0-9][a-z0-9_-]*))?$/;
const LEGACY_CONTENT_ADDRESSED_ASSET_PATTERN = /^([0-9a-f]{64})(?:\.([a-z0-9][a-z0-9_-]*))?$/i;

export function hashFromAssetPath(path: string): string | undefined {
  const filename = normalizeVaultPath(path).split("/").pop() ?? "";
  return CONTENT_ADDRESSED_ASSET_PATTERN.exec(filename)?.[1];
}

export function legacyHashFromAssetPath(path: string): string | undefined {
  const filename = normalizeVaultPath(path).split("/").pop() ?? "";
  return LEGACY_CONTENT_ADDRESSED_ASSET_PATTERN.exec(filename)?.[1].toLowerCase();
}

export function assetPathForHash(hash: string, extension?: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("Invalid attachment hash");
  const cleanExtension = (extension ?? "").replace(/^\.+/, "").replace(/[^a-z0-9_-]+/gi, "").toLowerCase();
  return `${ASSETS_PREFIX}${CONTENT_ADDRESSED_ASSET_PREFIX}${hash.toLowerCase()}${cleanExtension ? `.${cleanExtension}` : ""}`;
}

export function pastedImageExtension(filename: string, mime: string): string {
  const named = filename.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(named)) return named;
  return ({
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/tiff": "tiff",
    "image/webp": "webp"
  } as Record<string, string>)[mime.toLowerCase()] ?? "png";
}

export function pastedImageTargetPath(hash: string, extension: string, sourcePath: string): string {
  const sharedPath = assetPathForHash(hash, extension);
  return isPrivatePath(sourcePath) ? `${PRIVATE_FOLDER}/${sharedPath}` : sharedPath;
}

export async function pruneEmptyManagedFolders(vault: BinaryVault, configDir: string): Promise<string[]> {
  const removed: string[] = [];
  const protectedFolder = (path: string): boolean => path === ".git"
    || path.startsWith(".git/")
    || isConfigPath(path, configDir)
    || isPrivatePath(path)
    || isTrashPath(path)
    || path === ASSETS_PREFIX.slice(0, -1)
    || isAssetPath(path);
  const visit = async (path: string): Promise<void> => {
    const listed = await vault.list(path);
    for (const folder of listed.folders.map(normalizeVaultPath).sort((a, b) => b.length - a.length)) {
      if (protectedFolder(folder)) continue;
      await visit(folder);
      const after = await vault.list(folder);
      if (!after.files.length && !after.folders.length) {
        await vault.rmdir(folder, true);
        removed.push(folder);
      }
    }
  };
  await visit("");
  return removed.sort();
}

/**
 * Lists every file that a confirmed remote overwrite may replace. This uses
 * the adapter instead of Obsidian's index because dot-prefixed Team Core files
 * and excluded attachment folders may not have a TFile entry.
 */
export async function listRemoteOverwriteFiles(vault: BinaryVault, configDir: string): Promise<string[]> {
  const files: string[] = [];
  const preserved = (path: string): boolean => {
    const normalized = normalizeVaultPath(path);
    return normalized === ".git"
      || normalized.startsWith(".git/")
      || isConfigPath(normalized, configDir)
      || isPrivatePath(normalized)
      || isTrashPath(normalized);
  };
  const visit = async (path: string): Promise<void> => {
    const listed = await vault.list(path);
    for (const file of listed.files.map(normalizeVaultPath)) {
      if (!preserved(file)) files.push(file);
    }
    for (const folder of listed.folders.map(normalizeVaultPath)) {
      if (!preserved(folder)) await visit(folder);
    }
  };
  await visit("");
  return files.sort();
}

export function createVaultAdapter(adapter: DataAdapter): BinaryVault {
  const ensureParent = async (path: string): Promise<void> => {
    const parts = normalizeVaultPath(path).split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  };
  return {
    read: (path) => adapter.readBinary(normalizeVaultPath(path)),
    write: async (path, data) => {
      const normalized = normalizeVaultPath(path);
      await ensureParent(normalized);
      await adapter.writeBinary(normalized, data);
    },
    append: async (path, data) => {
      const normalized = normalizeVaultPath(path);
      await ensureParent(normalized);
      await adapter.appendBinary(normalized, data);
    },
    exists: (path) => adapter.exists(normalizeVaultPath(path)),
    stat: async (path) => {
      const stat = await adapter.stat(normalizeVaultPath(path));
      return stat ? { type: stat.type, size: stat.size, mtime: stat.mtime } : null;
    },
    list: (path) => adapter.list(normalizeVaultPath(path)),
    mkdir: async (path) => {
      const normalized = normalizeVaultPath(path);
      if (!normalized) return;
      const parts = normalized.split("/");
      let current = "";
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) await adapter.mkdir(current);
      }
    },
    remove: (path) => adapter.remove(normalizeVaultPath(path)),
    rmdir: (path, recursive = false) => adapter.rmdir(normalizeVaultPath(path), recursive),
    rename: (path, newPath) => adapter.rename(normalizeVaultPath(path), normalizeVaultPath(newPath))
  };
}

function resolveReferencePath(value: string, sourcePath: string): string {
  const cleaned = decodeURIComponent(value.trim().split(/[?#|]/, 1)[0]);
  const normalized = normalizeVaultPath(cleaned);
  if (normalized.startsWith(ASSETS_PREFIX) || normalized.startsWith(PRIVATE_ASSETS_PREFIX)) return normalized;
  const parent = normalizeVaultPath(sourcePath).split("/").slice(0, -1).join("/");
  return normalizeVaultPath(parent ? `${parent}/${cleaned}` : cleaned);
}

function collectReferences(markdown: string, sourcePath: string, accepts: (path: string) => boolean): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    const cleaned = value.trim().split(/[?#|]/, 1)[0];
    if (!cleaned || cleaned.startsWith("http://") || cleaned.startsWith("https://")) return;
    const resolved = resolveReferencePath(cleaned, sourcePath);
    if (accepts(resolved)) found.add(resolved);
  };
  for (const match of markdown.matchAll(/!\[\[[^\]]+\]\]|!\[\]\(([^)]+)\)|!\[[^\]]*\]\(([^)]+)\)/g)) {
    if (match[0].startsWith("![[")) add(match[0].slice(3, -2));
    else add(match[1] ?? match[2] ?? "");
  }
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add(match[1]);
  return [...found].sort();
}

export function collectMarkdownReferences(markdown: string, sourcePath: string): string[] {
  return collectReferences(markdown, sourcePath, isAssetPath);
}

export function collectPrivateAttachmentReferences(markdown: string, sourcePath: string): string[] {
  return collectReferences(markdown, sourcePath, isPrivateAssetPath);
}

function splitPathSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0 ? { path: value, suffix: "" } : { path: value.slice(0, index), suffix: value.slice(index) };
}

function relativePath(sourcePath: string, destinationPath: string): string {
  const from = normalizeVaultPath(sourcePath).split("/").slice(0, -1);
  const to = normalizeVaultPath(destinationPath).split("/");
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || to[to.length - 1] || destinationPath;
}

function replacementPath(original: string, sourcePath: string, destinationPath: string): string {
  if (original.startsWith("/")) return `/${destinationPath}`;
  return original.startsWith(ASSETS_PREFIX) ? destinationPath : relativePath(sourcePath, destinationPath);
}

/**
 * Rewrites only links that resolve to oldPath. This complements FileManager.renameFile
 * when a vault has disabled Obsidian's automatic link-update preference.
 */
export function rewriteAssetReferences(markdown: string, sourcePath: string, oldPath: string, newPath: string, referenceSourcePath = sourcePath): string {
  const expected = normalizeVaultPath(oldPath);
  const replaceWiki = (_match: string, bang: string, body: string): string => {
    const separator = body.indexOf("|");
    const target = separator < 0 ? body : body.slice(0, separator);
    const trailing = separator < 0 ? "" : body.slice(separator);
    const { path, suffix } = splitPathSuffix(target);
    if (resolveReferencePath(path, referenceSourcePath) !== expected) return `${bang}[[${body}]]`;
    return `${bang}[[${replacementPath(path, sourcePath, newPath)}${suffix}${trailing}]]`;
  };
  const replaceMarkdown = (_match: string, prefix: string, body: string, suffix: string): string => {
    const wrapped = /^<([^>]+)>(.*)$/.exec(body);
    const title = wrapped ? undefined : /^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/.exec(body);
    const rawTarget = wrapped?.[1] ?? title?.[1] ?? body;
    const trailing = wrapped?.[2] ?? body.slice(rawTarget.length);
    const { path, suffix: fragment } = splitPathSuffix(rawTarget);
    if (resolveReferencePath(path, referenceSourcePath) !== expected) return `${prefix}${body}${suffix}`;
    const replacement = `${replacementPath(path, sourcePath, newPath)}${fragment}`;
    return `${prefix}${wrapped ? `<${replacement}>${trailing}` : `${replacement}${trailing}`}${suffix}`;
  };

  return markdown
    .replace(/(!?)\[\[([^\]]+)\]\]/g, replaceWiki)
    .replace(/(!?\[[^\]]*\]\()([^)]+)(\))/g, replaceMarkdown);
}

export async function scanReferences(vault: Vault): Promise<Map<string, string[]>> {
  const references = new Map<string, string[]>();
  const files = vault.getMarkdownFiles();
  for (const file of files) {
    const content = await vault.read(file);
    for (const asset of collectMarkdownReferences(content, file.path)) {
      const users = references.get(asset) ?? [];
      users.push(file.path);
      references.set(asset, users);
    }
  }
  return references;
}

export async function listAssets(vault: Vault): Promise<TFile[]> {
  return vault.getFiles().filter((file) => isAssetPath(file.path));
}

export async function buildReferenceAudit(vault: Vault): Promise<ReferenceInfo[]> {
  const references = await scanReferences(vault);
  return (await listAssets(vault)).map((file) => {
    const users = references.get(file.path) ?? [];
    return { path: file.path, references: users.sort(), count: users.length, orphan: users.length === 0 };
  });
}
