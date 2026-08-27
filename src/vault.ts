import type { DataAdapter, TFile, Vault } from "obsidian";
import { ASSETS_PREFIX, PRIVATE_FOLDER, PRIVATE_PREFIX } from "./constants";
import type { ReferenceInfo } from "./types";

export interface BinaryVault {
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer): Promise<void>;
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

export function isManagedPath(path: string, configDir = ""): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized.length > 0
    && !isConfigPath(normalized, configDir)
    && !normalized.startsWith(ASSETS_PREFIX)
    && !isPrivatePath(normalized);
}

export function isConfigPath(path: string, configDir: string): boolean {
  const normalized = normalizeVaultPath(path);
  const config = normalizeVaultPath(configDir);
  return config.length > 0 && (normalized === config || normalized.startsWith(`${config}/`));
}

export function isAssetPath(path: string): boolean {
  return normalizeVaultPath(path).startsWith(ASSETS_PREFIX);
}

export function isPrivatePath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === PRIVATE_FOLDER || normalized.startsWith(PRIVATE_PREFIX);
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

export function collectMarkdownReferences(markdown: string, sourcePath: string): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    const cleaned = decodeURIComponent(value.trim().split(/[?#|]/, 1)[0]);
    if (!cleaned || cleaned.startsWith("http://") || cleaned.startsWith("https://")) return;
    const normalized = normalizeVaultPath(cleaned);
    if (normalized.startsWith(ASSETS_PREFIX)) found.add(normalized);
    else if (normalized.includes("/") || /\.(png|jpe?g|gif|webp|svg|pdf|zip|docx?|xlsx?|pptx?)$/i.test(normalized)) {
      const parent = normalizeVaultPath(sourcePath).split("/").slice(0, -1).join("/");
      const resolved = normalizeVaultPath(parent ? `${parent}/${normalized}` : normalized);
      if (resolved.startsWith(ASSETS_PREFIX)) found.add(resolved);
    }
  };
  for (const match of markdown.matchAll(/!\[\[[^\]]+\]\]|!\[\]\(([^)]+)\)|!\[[^\]]*\]\(([^)]+)\)/g)) {
    if (match[0].startsWith("![[")) add(match[0].slice(3, -2));
    else add(match[1] ?? match[2] ?? "");
  }
  for (const match of markdown.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add(match[1]);
  return [...found].sort();
}

function resolveReferencePath(value: string, sourcePath: string): string {
  const cleaned = decodeURIComponent(value.trim().split(/[?#|]/, 1)[0]);
  if (cleaned.replace(/^\/+/, "").startsWith(ASSETS_PREFIX)) return normalizeVaultPath(cleaned);
  const parent = normalizeVaultPath(sourcePath).split("/").slice(0, -1).join("/");
  return normalizeVaultPath(parent ? `${parent}/${cleaned}` : cleaned);
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
export function rewriteAssetReferences(markdown: string, sourcePath: string, oldPath: string, newPath: string): string {
  const expected = normalizeVaultPath(oldPath);
  const replaceWiki = (_match: string, bang: string, body: string): string => {
    const separator = body.indexOf("|");
    const target = separator < 0 ? body : body.slice(0, separator);
    const trailing = separator < 0 ? "" : body.slice(separator);
    const { path, suffix } = splitPathSuffix(target);
    if (resolveReferencePath(path, sourcePath) !== expected) return `${bang}[[${body}]]`;
    return `${bang}[[${replacementPath(path, sourcePath, newPath)}${suffix}${trailing}]]`;
  };
  const replaceMarkdown = (_match: string, prefix: string, body: string, suffix: string): string => {
    const wrapped = /^<([^>]+)>(.*)$/.exec(body);
    const title = wrapped ? undefined : /^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/.exec(body);
    const rawTarget = wrapped?.[1] ?? title?.[1] ?? body;
    const trailing = wrapped?.[2] ?? body.slice(rawTarget.length);
    const { path, suffix: fragment } = splitPathSuffix(rawTarget);
    if (resolveReferencePath(path, sourcePath) !== expected) return `${prefix}${body}${suffix}`;
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
