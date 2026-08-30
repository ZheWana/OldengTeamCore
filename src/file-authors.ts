import { FILE_AUTHORS_PATH } from "./constants";
import type { TFile, Vault } from "obsidian";
import { isPrivatePath, normalizeVaultPath, type BinaryVault } from "./vault";

const FILE_AUTHORS_VERSION = 1 as const;

export interface FileAuthorRegistry {
  version: typeof FILE_AUTHORS_VERSION;
  files: Record<string, string[]>;
}

export interface FileAuthorHistory {
  exists(): Promise<boolean>;
  fileAuthors(filepath: string): Promise<string[]>;
}

export interface FileAuthorProgress {
  current: number;
  total: number;
  path: string;
}

export function createEmptyFileAuthorRegistry(): FileAuthorRegistry {
  return { version: FILE_AUTHORS_VERSION, files: {} };
}

export function isAuthorableFilePath(rawPath: string): boolean {
  const path = normalizeVaultPath(rawPath);
  return path.endsWith(".md") && !isPrivatePath(path) && !path.startsWith(".team/");
}

export function listAuthorableMarkdownFiles(vault: Vault): TFile[] {
  return vault.getMarkdownFiles()
    .filter((file) => isAuthorableFilePath(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeAuthors(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`文件作者格式无效：${path}`);
  const authors = value.map((author) => {
    if (typeof author !== "string") throw new Error(`文件作者格式无效：${path}`);
    const normalized = author.trim();
    if (!normalized || normalized.length > 100) throw new Error(`文件作者名称无效：${path}`);
    return normalized;
  });
  const unique = [...new Set(authors)];
  if (!unique.length) throw new Error(`文件作者不能为空：${path}`);
  return unique;
}

export function validateFileAuthorRegistry(value: unknown): FileAuthorRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文件作者归属表格式无效：应为对象");
  const input = value as { version?: unknown; files?: unknown };
  if (input.version !== FILE_AUTHORS_VERSION || !input.files || typeof input.files !== "object" || Array.isArray(input.files)) {
    throw new Error("文件作者归属表版本或结构不受支持");
  }
  const files: Record<string, string[]> = {};
  for (const [rawPath, rawAuthors] of Object.entries(input.files as Record<string, unknown>)) {
    const path = normalizeVaultPath(rawPath);
    if (!isAuthorableFilePath(path)) throw new Error(`文件作者路径无效：${rawPath}`);
    files[path] = normalizeAuthors(rawAuthors, path);
  }
  return { version: FILE_AUTHORS_VERSION, files };
}

export function parseFileAuthorRegistry(content: string): FileAuthorRegistry {
  try {
    return validateFileAuthorRegistry(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`文件作者归属表 JSON 无效：${error.message}`);
    throw error;
  }
}

export function serializeFileAuthorRegistry(registry: FileAuthorRegistry): string {
  const valid = validateFileAuthorRegistry(registry);
  const files = Object.fromEntries(Object.entries(valid.files).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify({ version: FILE_AUTHORS_VERSION, files }, null, 2)}\n`;
}

export async function readFileAuthorRegistry(vault: BinaryVault): Promise<FileAuthorRegistry> {
  if (!await vault.exists(FILE_AUTHORS_PATH)) return createEmptyFileAuthorRegistry();
  return parseFileAuthorRegistry(new TextDecoder().decode(await vault.read(FILE_AUTHORS_PATH)));
}

export async function writeFileAuthorRegistry(vault: BinaryVault, registry: FileAuthorRegistry): Promise<void> {
  const content = new TextEncoder().encode(serializeFileAuthorRegistry(registry));
  const teamDirectory = await vault.stat(".team");
  if (teamDirectory && teamDirectory.type !== "folder") throw new Error("无法保存文件作者归属：.team 已被文件占用");
  if (!teamDirectory) await vault.mkdir(".team");
  await vault.write(FILE_AUTHORS_PATH, content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
}

export function setFileAuthors(registry: FileAuthorRegistry, paths: readonly string[], authors: readonly string[]): FileAuthorRegistry {
  const files = { ...validateFileAuthorRegistry(registry).files };
  for (const rawPath of paths) {
    const path = normalizeVaultPath(rawPath);
    files[path] = normalizeAuthors(authors, path);
  }
  return validateFileAuthorRegistry({ version: FILE_AUTHORS_VERSION, files });
}

export function clearFileAuthors(registry: FileAuthorRegistry, paths: readonly string[]): FileAuthorRegistry {
  const files = { ...validateFileAuthorRegistry(registry).files };
  for (const path of paths) delete files[normalizeVaultPath(path)];
  return { version: FILE_AUTHORS_VERSION, files };
}

export function assignedOrHistoricalAuthors(registry: FileAuthorRegistry, path: string, historical: readonly string[]): string[] {
  return registry.files[normalizeVaultPath(path)] ?? [...historical];
}

export function countResolvedDocumentAuthors(authorsByPath: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const authors of authorsByPath.values()) {
    for (const author of new Set(authors.map((name) => name.trim()).filter(Boolean))) {
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
  }
  return counts;
}

export class FileAuthorService {
  private registryPromise: Promise<FileAuthorRegistry> | undefined;
  private repositoryExistsPromise: Promise<boolean> | undefined;
  private readonly authorCache = new Map<string, Promise<string[]>>();

  constructor(
    private readonly vault: BinaryVault,
    private readonly history: FileAuthorHistory,
    private readonly onRegistryChanged?: () => void
  ) {}

  invalidate(): void {
    this.registryPromise = undefined;
    this.repositoryExistsPromise = undefined;
    this.authorCache.clear();
  }

  getRegistry(): Promise<FileAuthorRegistry> {
    if (!this.registryPromise) {
      const request = readFileAuthorRegistry(this.vault).catch((error: unknown) => {
        if (this.registryPromise === request) this.registryPromise = undefined;
        throw error;
      });
      this.registryPromise = request;
    }
    return this.registryPromise;
  }

  getAuthors(filepath: string): Promise<string[]> {
    const path = normalizeVaultPath(filepath);
    if (!isAuthorableFilePath(path)) return Promise.resolve([]);
    const cached = this.authorCache.get(path);
    if (cached) return cached;
    const request = this.resolveAuthors(path).catch((error: unknown) => {
      if (this.authorCache.get(path) === request) this.authorCache.delete(path);
      throw error;
    });
    this.authorCache.set(path, request);
    return request;
  }

  async getDocumentAuthorCounts(
    paths: readonly string[],
    onProgress?: (progress: FileAuthorProgress) => void,
    concurrency = 6
  ): Promise<Map<string, number>> {
    const normalizedPaths = [...new Set(paths.map(normalizeVaultPath))];
    const authorsByPath = new Map<string, string[]>();
    let nextIndex = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        const path = normalizedPaths[index];
        if (!path) return;
        authorsByPath.set(path, await this.getAuthors(path));
        completed += 1;
        onProgress?.({ current: completed, total: normalizedPaths.length, path });
      }
    };
    const workerCount = Math.min(Math.max(1, Math.trunc(concurrency)), normalizedPaths.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return countResolvedDocumentAuthors(authorsByPath);
  }

  async setAuthors(paths: readonly string[], authors: readonly string[]): Promise<FileAuthorRegistry> {
    const registry = setFileAuthors(await readFileAuthorRegistry(this.vault), paths, authors);
    await this.persistRegistry(registry);
    return registry;
  }

  async clearAuthors(paths: readonly string[]): Promise<FileAuthorRegistry> {
    const registry = clearFileAuthors(await readFileAuthorRegistry(this.vault), paths);
    await this.persistRegistry(registry);
    return registry;
  }

  private async resolveAuthors(path: string): Promise<string[]> {
    const registry = await this.getRegistry();
    const assigned = registry.files[path];
    if (assigned) return [...assigned];
    if (!await this.repositoryExists()) return [];
    return assignedOrHistoricalAuthors(registry, path, await this.history.fileAuthors(path));
  }

  private repositoryExists(): Promise<boolean> {
    this.repositoryExistsPromise ??= this.history.exists();
    return this.repositoryExistsPromise;
  }

  private async persistRegistry(registry: FileAuthorRegistry): Promise<void> {
    await writeFileAuthorRegistry(this.vault, registry);
    this.invalidate();
    this.registryPromise = Promise.resolve(registry);
    this.onRegistryChanged?.();
  }
}

function sameAuthors(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeFileAuthorRegistries(
  base: FileAuthorRegistry,
  ours: FileAuthorRegistry,
  theirs: FileAuthorRegistry
): FileAuthorRegistry | undefined {
  const before = validateFileAuthorRegistry(base).files;
  const local = validateFileAuthorRegistry(ours).files;
  const remote = validateFileAuthorRegistry(theirs).files;
  const files: Record<string, string[]> = {};
  const paths = new Set([...Object.keys(before), ...Object.keys(local), ...Object.keys(remote)]);
  for (const path of paths) {
    const baseAuthors = before[path];
    const ourAuthors = local[path];
    const theirAuthors = remote[path];
    let merged: string[] | undefined;
    if (sameAuthors(ourAuthors, theirAuthors)) merged = ourAuthors;
    else if (sameAuthors(ourAuthors, baseAuthors)) merged = theirAuthors;
    else if (sameAuthors(theirAuthors, baseAuthors)) merged = ourAuthors;
    else return undefined;
    if (merged) files[path] = merged;
  }
  return { version: FILE_AUTHORS_VERSION, files };
}
