import { requestUrl, type RequestUrlParam } from "obsidian";
import { base64UrlEncode, sha256Hex } from "./crypto";
import { mimeFromPath } from "./mime";
import { S3Transport } from "./s3";
import type { Logger, PrivateSyncEntry, PrivateSyncState, TeamCoreSettings } from "./types";
import { normalizeVaultPath, type BinaryVault } from "./vault";
import { PRIVATE_FOLDER } from "./constants";

const REMOTE_ROOT = "oldeng-team-core-private/v1";
const REMOTE_INDEX = `${REMOTE_ROOT}/index.json`;

export interface PrivateSyncRemote {
  initialize(): Promise<void>;
  read(path: string): Promise<ArrayBuffer | undefined>;
  write(path: string, data: ArrayBuffer, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface PrivateSyncProgress {
  (current: number, total: number, path: string): void;
}

interface PrivateRemoteManifest {
  version: 1;
  entries: Record<string, PrivateSyncEntry>;
}

interface LocalEntry extends Required<Pick<PrivateSyncEntry, "sha256" | "size" | "updatedAt">> {
  path: string;
  data: ArrayBuffer;
}

type PrivateOperation =
  | { kind: "upload"; path: string; entry: LocalEntry }
  | { kind: "download"; path: string; entry: PrivateSyncEntry }
  | { kind: "delete-remote"; path: string }
  | { kind: "delete-local"; path: string };

export interface PrivateSyncResult {
  state: PrivateSyncState;
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  conflictsResolved: number;
}

export type PrivateSyncMode = "bidirectional" | "pull";

function isLive(entry: PrivateSyncEntry | undefined): entry is Required<Pick<PrivateSyncEntry, "sha256" | "size" | "updatedAt">> {
  return Boolean(entry && !entry.deletedAt && typeof entry.sha256 === "string" && typeof entry.size === "number" && typeof entry.updatedAt === "number");
}

function equalEntries(left: PrivateSyncEntry | undefined, right: PrivateSyncEntry | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameContent(left: LocalEntry | undefined, right: PrivateSyncEntry | undefined): boolean {
  return Boolean(left && isLive(right) && left.sha256 === right.sha256 && left.size === right.size);
}

function entryTime(entry: PrivateSyncEntry | undefined): number {
  return entry?.deletedAt ?? entry?.updatedAt ?? 0;
}

function privateRelativePath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) throw new Error(`私人笔记路径无效：${path}`);
  return normalized;
}

function remoteFilePath(path: string): string {
  return `${REMOTE_ROOT}/files/${base64UrlEncode(privateRelativePath(path))}`;
}

function parseManifest(data: ArrayBuffer | undefined): PrivateRemoteManifest | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Partial<PrivateRemoteManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) throw new Error("invalid shape");
    const entries: Record<string, PrivateSyncEntry> = {};
    for (const [path, raw] of Object.entries(parsed.entries)) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw;
      const validHash = entry.sha256 === undefined || (typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256));
      const validSize = entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0);
      const validUpdated = entry.updatedAt === undefined || (Number.isFinite(entry.updatedAt) && entry.updatedAt > 0);
      const validDeleted = entry.deletedAt === undefined || (Number.isFinite(entry.deletedAt) && entry.deletedAt > 0);
      if (!validHash || !validSize || !validUpdated || !validDeleted || (!entry.sha256 && !entry.deletedAt)) continue;
      entries[privateRelativePath(path)] = {
        ...(entry.sha256 ? { sha256: entry.sha256.toLowerCase() } : {}),
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt })
      };
    }
    return { version: 1, entries };
  } catch {
    throw new Error("私人笔记远端清单格式无效，已停止同步以保护本地数据");
  }
}

function manifestData(entries: Record<string, PrivateSyncEntry>): ArrayBuffer {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
  const data = new TextEncoder().encode(`${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function scanPrivateFiles(vault: BinaryVault): Promise<Map<string, LocalEntry>> {
  const files = new Map<string, LocalEntry>();
  const visit = async (folder: string): Promise<void> => {
    const listed = await vault.list(folder).catch(() => undefined);
    if (!listed) return;
    for (const path of listed.files.map(normalizeVaultPath)) {
      const relative = privateRelativePath(path.slice(`${PRIVATE_FOLDER}/`.length));
      const [stat, data] = await Promise.all([vault.stat(path), vault.read(path)]);
      if (!stat || stat.type !== "file") continue;
      files.set(relative, { path: relative, data, sha256: await sha256Hex(data), size: data.byteLength, updatedAt: stat.mtime });
    }
    await Promise.all(listed.folders.map((path) => visit(normalizeVaultPath(path))));
  };
  await visit(PRIVATE_FOLDER);
  return files;
}

export class PrivateNotesSynchronizer {
  constructor(
    private readonly settings: TeamCoreSettings,
    private readonly logger: Logger,
    private readonly remote: PrivateSyncRemote = createPrivateRemote(settings, logger)
  ) {}

  async sync(vault: BinaryVault, state: PrivateSyncState, onProgress?: PrivateSyncProgress): Promise<PrivateSyncResult> {
    await vault.mkdir(PRIVATE_FOLDER);
    await this.remote.initialize();
    const [remoteIndex, local] = await Promise.all([this.remote.read(REMOTE_INDEX), scanPrivateFiles(vault)]);
    const parsedManifest = parseManifest(remoteIndex);
    const remoteEntries = { ...(parsedManifest?.entries ?? {}) };
    const previous = state.version === 1 ? state.entries : {};
    const paths = new Set([...Object.keys(previous), ...Object.keys(remoteEntries), ...local.keys()]);
    const operations: PrivateOperation[] = [];
    const nextEntries = { ...remoteEntries };
    let conflictsResolved = 0;

    for (const path of [...paths].sort()) {
      const localEntry = local.get(path);
      const remoteEntry = remoteEntries[path];
      const previousEntry = previous[path];
      const localChanged = localEntry
        ? !sameContent(localEntry, previousEntry)
        : Boolean(isLive(previousEntry));
      const remoteChanged = !equalEntries(remoteEntry, previousEntry);

      if (localChanged && remoteChanged) {
        if (sameContent(localEntry, remoteEntry) || (!localEntry && remoteEntry?.deletedAt)) continue;
        conflictsResolved += 1;
        // A local deletion has no trustworthy timestamp once Obsidian has
        // removed the file, so preserve a concurrent remote edit by default.
        if (!localEntry && isLive(remoteEntry)) {
          operations.push({ kind: "download", path, entry: remoteEntry });
          this.logger.warn("Private sync conflict resolved with remote version", { path, reason: "local deletion and remote change" });
          continue;
        }
        if (localEntry && remoteEntry?.deletedAt) {
          operations.push({ kind: "upload", path, entry: localEntry });
          this.logger.warn("Private sync conflict resolved with local version", { path, reason: "remote deletion and local change" });
          continue;
        }
        if ((localEntry?.updatedAt ?? 0) >= entryTime(remoteEntry)) {
          if (localEntry) operations.push({ kind: "upload", path, entry: localEntry });
          else operations.push({ kind: "delete-remote", path });
          this.logger.warn("Private sync conflict resolved with newer local version", { path });
        } else if (isLive(remoteEntry)) {
          operations.push({ kind: "download", path, entry: remoteEntry });
          this.logger.warn("Private sync conflict resolved with newer remote version", { path });
        } else {
          operations.push({ kind: "delete-local", path });
          this.logger.warn("Private sync conflict resolved with newer remote deletion", { path });
        }
        continue;
      }

      if (localChanged) {
        if (localEntry) operations.push({ kind: "upload", path, entry: localEntry });
        else operations.push({ kind: "delete-remote", path });
      } else if (remoteChanged) {
        if (isLive(remoteEntry)) operations.push({ kind: "download", path, entry: remoteEntry });
        else if (remoteEntry?.deletedAt) operations.push({ kind: "delete-local", path });
      }
    }

    let current = 0;
    const total = Math.max(operations.length + 1, 1);
    const advance = (path: string): void => { current += 1; onProgress?.(current, total, path); };
    let uploaded = 0;
    let downloaded = 0;
    let deletedRemote = 0;
    let deletedLocal = 0;
    for (const operation of operations) {
      if (operation.kind === "upload") {
        await this.remote.write(remoteFilePath(operation.path), operation.entry.data, mimeFromPath(operation.path));
        nextEntries[operation.path] = { sha256: operation.entry.sha256, size: operation.entry.size, updatedAt: Date.now() };
        uploaded += 1;
      } else if (operation.kind === "download") {
        const data = await this.remote.read(remoteFilePath(operation.path));
        if (!data) throw new Error(`私人笔记远端文件不存在：${operation.path}`);
        const actual = await sha256Hex(data);
        if (actual !== operation.entry.sha256 || data.byteLength !== operation.entry.size) throw new Error(`私人笔记远端文件校验失败：${operation.path}`);
        await vault.write(`${PRIVATE_FOLDER}/${operation.path}`, data);
        downloaded += 1;
      } else if (operation.kind === "delete-remote") {
        await this.remote.remove(remoteFilePath(operation.path));
        nextEntries[operation.path] = { deletedAt: Date.now() };
        deletedRemote += 1;
      } else {
        const localPath = `${PRIVATE_FOLDER}/${operation.path}`;
        if (await vault.exists(localPath)) await vault.remove(localPath);
        deletedLocal += 1;
      }
      advance(operation.path);
    }
    await this.remote.write(REMOTE_INDEX, manifestData(nextEntries), "application/json");
    advance("私人笔记同步清单");
    return {
      state: { version: 1, entries: nextEntries },
      uploaded,
      downloaded,
      deletedRemote,
      deletedLocal,
      conflictsResolved
    };
  }

  /** Applies remote private notes without uploading local-only files or changing the remote manifest. */
  async pull(vault: BinaryVault, state: PrivateSyncState, onProgress?: PrivateSyncProgress): Promise<PrivateSyncResult> {
    await vault.mkdir(PRIVATE_FOLDER);
    await this.remote.initialize();
    const [remoteIndex, local] = await Promise.all([this.remote.read(REMOTE_INDEX), scanPrivateFiles(vault)]);
    const remoteEntries = { ...(parseManifest(remoteIndex)?.entries ?? {}) };
    const previous = state.version === 1 ? state.entries : {};
    const operations: PrivateOperation[] = [];

    for (const path of Object.keys(remoteEntries).sort()) {
      const remoteEntry = remoteEntries[path];
      const localEntry = local.get(path);
      const previousEntry = previous[path];
      if (isLive(remoteEntry)) {
        if (!sameContent(localEntry, remoteEntry)) operations.push({ kind: "download", path, entry: remoteEntry });
        continue;
      }
      // A remote tombstone only removes an unchanged file known to this
      // client. A local-only or locally edited note is retained for safety.
      if (remoteEntry.deletedAt && isLive(previousEntry) && !sameContent(localEntry, previousEntry)) continue;
      if (remoteEntry.deletedAt && isLive(previousEntry)) operations.push({ kind: "delete-local", path });
    }

    let current = 0;
    const total = Math.max(operations.length, 1);
    const advance = (path: string): void => { current += 1; onProgress?.(current, total, path); };
    let downloaded = 0;
    let deletedLocal = 0;
    for (const operation of operations) {
      if (operation.kind === "download") {
        const data = await this.remote.read(remoteFilePath(operation.path));
        if (!data) throw new Error(`私人笔记远端文件不存在：${operation.path}`);
        const actual = await sha256Hex(data);
        if (actual !== operation.entry.sha256 || data.byteLength !== operation.entry.size) throw new Error(`私人笔记远端文件校验失败：${operation.path}`);
        await vault.write(`${PRIVATE_FOLDER}/${operation.path}`, data);
        downloaded += 1;
      } else if (operation.kind === "delete-local") {
        const localPath = `${PRIVATE_FOLDER}/${operation.path}`;
        if (await vault.exists(localPath)) await vault.remove(localPath);
        deletedLocal += 1;
      }
      advance(operation.path);
    }
    if (!operations.length) onProgress?.(1, 1, "私人笔记已是最新");
    return {
      state: { version: 1, entries: remoteEntries },
      uploaded: 0,
      downloaded,
      deletedRemote: 0,
      deletedLocal,
      conflictsResolved: 0
    };
  }
}

class WebDavPrivateRemote implements PrivateSyncRemote {
  private readonly root: string;
  private readonly authorization: string | undefined;

  constructor(settings: TeamCoreSettings, private readonly logger: Logger) {
    const address = settings.privateWebdavUrl.trim();
    if (!address) throw new Error("私人笔记 WebDAV 地址未配置");
    try { this.root = new URL(address.endsWith("/") ? address : `${address}/`).toString(); }
    catch { throw new Error("私人笔记 WebDAV 地址无效"); }
    if (settings.privateWebdavUsername || settings.privateWebdavPassword) {
      const bytes = new TextEncoder().encode(`${settings.privateWebdavUsername}:${settings.privateWebdavPassword}`);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      this.authorization = `Basic ${btoa(binary)}`;
    }
  }

  async initialize(): Promise<void> {
    let collection = "";
    for (const segment of [...REMOTE_ROOT.split("/"), "files"]) {
      collection = collection ? `${collection}/${segment}` : segment;
      await this.mkcol(collection);
    }
  }

  async read(path: string): Promise<ArrayBuffer | undefined> {
    const response = await this.request("GET", path);
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV GET ${path} 失败（HTTP ${response.status}）`);
    return response.arrayBuffer;
  }

  async write(path: string, data: ArrayBuffer, contentType: string): Promise<void> {
    const response = await this.request("PUT", path, data, contentType);
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV PUT ${path} 失败（HTTP ${response.status}）`);
  }

  async remove(path: string): Promise<void> {
    const response = await this.request("DELETE", path);
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw new Error(`WebDAV DELETE ${path} 失败（HTTP ${response.status}）`);
  }

  private async mkcol(path: string): Promise<void> {
    const response = await this.request("MKCOL", path);
    if (![200, 201, 204, 405].includes(response.status)) throw new Error(`WebDAV 无法创建私人同步目录（HTTP ${response.status}）`);
  }

  private async request(method: string, path: string, body?: ArrayBuffer, contentType?: string) {
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), this.root).toString();
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    if (this.authorization) headers.authorization = this.authorization;
    if (contentType) headers["content-type"] = contentType;
    this.logger.debug("Private WebDAV request", { method, path, size: body?.byteLength });
    return requestUrl({ url, method, headers, body, throw: false } satisfies RequestUrlParam);
  }
}

class S3PrivateRemote implements PrivateSyncRemote {
  private readonly transport: S3Transport;

  constructor(settings: TeamCoreSettings, logger: Logger) {
    this.transport = new S3Transport({
      ...settings,
      s3Endpoint: settings.privateS3Endpoint,
      s3Region: settings.privateS3Region,
      s3Bucket: settings.privateS3Bucket,
      s3Prefix: settings.privateS3Prefix,
      s3AccessKey: settings.privateS3AccessKey,
      s3SecretKey: settings.privateS3SecretKey
    }, logger);
    if (!this.transport.enabled()) throw new Error("私人笔记 S3 配置不完整");
  }

  async initialize(): Promise<void> {}
  read(path: string): Promise<ArrayBuffer | undefined> { return this.transport.readObject(path); }
  write(path: string, data: ArrayBuffer, contentType: string): Promise<void> { return this.transport.writeObject(path, data, contentType); }
  remove(path: string): Promise<void> { return this.transport.deleteObject(path); }
}

export function createPrivateRemote(settings: TeamCoreSettings, logger: Logger): PrivateSyncRemote {
  return settings.privateSyncProvider === "s3"
    ? new S3PrivateRemote(settings, logger)
    : new WebDavPrivateRemote(settings, logger);
}
