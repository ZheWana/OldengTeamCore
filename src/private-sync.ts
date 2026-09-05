import { requestUrl, type RequestUrlParam } from "obsidian";
import { createSHA256 } from "hash-wasm";
import { base64UrlEncode, sha256Hex } from "./crypto";
import { mimeFromPath } from "./mime";
import { S3Transport, type ChunkUploadSource } from "./s3";
import type { Logger, PrivateSyncEntry, PrivateSyncState, TeamCoreSettings } from "./types";
import { normalizeVaultPath, readVaultInChunks, VAULT_TRANSFER_CHUNK_SIZE, type BinaryVault } from "./vault";
import { PRIVATE_FOLDER } from "./constants";

const REMOTE_ROOT = "oldeng-team-core-private/v1";
const REMOTE_INDEX = `${REMOTE_ROOT}/index.json`;

export interface PrivateSyncRemote {
  initialize(): Promise<void>;
  read(path: string): Promise<ArrayBuffer | undefined>;
  /**
   * Streams a large object into a caller-owned sink. Providers must reject a
   * range response they cannot validate rather than silently buffering it.
   */
  readInChunks?(path: string, expectedSize: number, onChunk: PrivateRemoteChunkTarget): Promise<void>;
  write(path: string, data: ArrayBuffer, contentType: string): Promise<void>;
  writeFromChunks?(path: string, sha256: string, size: number, contentType: string, source: ChunkUploadSource): Promise<void>;
  readIndex(): Promise<PrivateRemoteIndex>;
  writeIndex(data: ArrayBuffer, version: string | undefined): Promise<PrivateIndexWriteResult>;
}

export interface PrivateRemoteIndex {
  data: ArrayBuffer | undefined;
  /** ETag or provider generation used for compare-and-swap. */
  version: string | undefined;
}

export type PrivateIndexWriteResult = "written" | "conflict";

export interface PrivateSyncProgress {
  (current: number, total: number, path: string): void;
}

export interface PrivateRemoteChunkTarget {
  (chunk: ArrayBuffer, offset: number, total: number): Promise<void>;
}


interface PrivateRemoteManifest {
  version: 1;
  entries: Record<string, PrivateSyncEntry>;
}

interface LocalSnapshot extends Required<Pick<PrivateSyncEntry, "sha256" | "size" | "updatedAt">> {
  path: string;
}

interface PrivateRemoteUpload {
  path: string;
  entry: LocalSnapshot;
  objectKey: string;
}

type PrivateLocalApplication =
  | { kind: "download"; path: string; entry: PrivateSyncEntry; expectedLocal: LocalSnapshot | undefined }
  | { kind: "delete-local"; path: string; expectedLocal: LocalSnapshot | undefined };

/**
 * A side-effect-free reconciliation plan. Remote objects are immutable, so
 * uploads may safely precede the index CAS; local Vault mutations must wait
 * until the CAS succeeds, otherwise a retry can mistake its own download for
 * a user edit.
 */
interface PrivateSyncPlan {
  nextEntries: Record<string, PrivateSyncEntry>;
  remoteUploads: PrivateRemoteUpload[];
  localApplications: PrivateLocalApplication[];
  conflictsResolved: number;
  logicalRemoteDeletes: number;
}

interface PrivateLocalTransactionEntry {
  kind: PrivateLocalApplication["kind"];
  path: string;
  before?: PrivateStagedFile;
  target?: PrivateStagedFile;
}

interface PrivateLocalTransaction {
  version: 2;
  operations: PrivateLocalTransactionEntry[];
}

/** A transaction journal carries only verifiable staging metadata, never bytes. */
interface PrivateStagedFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PrivateSyncResult {
  state: PrivateSyncState;
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  conflictsResolved: number;
  /** Local changes retained by a non-destructive remote import. */
  preservedLocal: number;
}

export type PrivateSyncMode = "bidirectional" | "pull";

function isLive(entry: PrivateSyncEntry | undefined): entry is Required<Pick<PrivateSyncEntry, "sha256" | "size" | "updatedAt">> {
  return Boolean(entry && !entry.deletedAt && typeof entry.sha256 === "string" && typeof entry.size === "number" && typeof entry.updatedAt === "number");
}

function equalEntries(left: PrivateSyncEntry | undefined, right: PrivateSyncEntry | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameManifestEntries(left: Record<string, PrivateSyncEntry>, right: Record<string, PrivateSyncEntry>): boolean {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  return leftPaths.length === rightPaths.length
    && leftPaths.every((path, index) => path === rightPaths[index] && equalEntries(left[path], right[path]));
}

function sameContent(left: LocalSnapshot | undefined, right: PrivateSyncEntry | undefined): boolean {
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

function versionedRemoteFilePath(path: string, sha256: string): string {
  return `${remoteFilePath(path)}-${sha256.toLowerCase()}`;
}

function entryRemoteFilePath(path: string, entry: PrivateSyncEntry): string {
  return entry.objectKey ?? remoteFilePath(path);
}

function parseManifest(data: ArrayBuffer | undefined): PrivateRemoteManifest | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as Partial<PrivateRemoteManifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) throw new Error("invalid shape");
    const entries: Record<string, PrivateSyncEntry> = {};
    for (const [path, raw] of Object.entries(parsed.entries)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: 条目不是对象`);
      const entry = raw;
      const normalizedPath = privateRelativePath(path);
      if (normalizedPath !== path.replace(/\\/g, "/")) throw new Error(`${path}: 路径不是规范相对路径`);
      if (entries[normalizedPath]) throw new Error(`${path}: 规范化后路径重复`);
      const validHash = typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/i.test(entry.sha256);
      const validSize = Number.isSafeInteger(entry.size) && (entry.size ?? -1) >= 0;
      const validUpdated = Number.isFinite(entry.updatedAt) && (entry.updatedAt ?? 0) > 0;
      const validDeleted = Number.isFinite(entry.deletedAt) && (entry.deletedAt ?? 0) > 0;
      const validObjectKey = entry.objectKey === undefined || (typeof entry.objectKey === "string" && entry.objectKey.startsWith(`${REMOTE_ROOT}/files/`) && !entry.objectKey.includes(".."));
      if (entry.deletedAt !== undefined) {
        if (!validDeleted || entry.sha256 !== undefined || entry.size !== undefined || entry.updatedAt !== undefined || entry.objectKey !== undefined) {
          throw new Error(`${path}: 删除条目字段无效`);
        }
        entries[normalizedPath] = { deletedAt: entry.deletedAt };
        continue;
      }
      if (!validHash || !validSize || !validUpdated || !validObjectKey) throw new Error(`${path}: 活跃条目字段无效`);
      entries[normalizedPath] = {
        sha256: entry.sha256!.toLowerCase(),
        size: entry.size,
        updatedAt: entry.updatedAt,
        ...(entry.objectKey ? { objectKey: entry.objectKey } : {})
      };
    }
    return { version: 1, entries };
  } catch (error) {
    const detail = error instanceof Error ? `：${error.message}` : "";
    throw new Error(`私人笔记远端清单格式无效，已停止同步以保护本地数据${detail}`);
  }
}

/** A missing prior entry is never a deletion: all deletions require a tombstone. */
function ensureRemoteContinuity(remoteEntries: Record<string, PrivateSyncEntry>, previous: Record<string, PrivateSyncEntry>): void {
  for (const [path, previousEntry] of Object.entries(previous)) {
    if ((isLive(previousEntry) || previousEntry.deletedAt) && !remoteEntries[path]) {
      throw new Error(`私人笔记远端清单缺少已知路径：${path}；已停止同步以保护数据`);
    }
  }
}

function manifestData(entries: Record<string, PrivateSyncEntry>): ArrayBuffer {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)));
  const data = new TextEncoder().encode(`${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function scanPrivateFiles(vault: BinaryVault): Promise<Map<string, LocalSnapshot>> {
  const files = new Map<string, LocalSnapshot>();
  const visit = async (folder: string): Promise<void> => {
    const listed = await vault.list(folder).catch(() => undefined);
    if (!listed) return;
    for (const path of listed.files.map(normalizeVaultPath)) {
      const relative = privateRelativePath(path.slice(`${PRIVATE_FOLDER}/`.length));
      const stat = await vault.stat(path);
      if (!stat || stat.type !== "file") continue;
      // A baseline is allowed to inspect every file, but it must never retain
      // every file body in the JavaScript heap at the same time.
      files.set(relative, { path: relative, sha256: await hashPrivateFile(vault, path, stat.size), size: stat.size, updatedAt: stat.mtime });
    }
    for (const path of listed.folders.map(normalizeVaultPath)) await visit(path);
  };
  await visit(PRIVATE_FOLDER);
  return files;
}

async function readPrivateFile(vault: BinaryVault, path: string): Promise<LocalSnapshot | undefined> {
  const relative = privateRelativePath(path);
  const fullPath = `${PRIVATE_FOLDER}/${relative}`;
  const stat = await vault.stat(fullPath);
  if (!stat || stat.type !== "file") return undefined;
  return { path: relative, sha256: await hashPrivateFile(vault, fullPath, stat.size), size: stat.size, updatedAt: stat.mtime };
}

async function hashPrivateFile(vault: BinaryVault, path: string, size: number): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  await readVaultInChunks(vault, path, size, async (chunk) => {
    hasher.update(new Uint8Array(chunk));
  });
  return hasher.digest();
}

function sameLocalSnapshot(left: LocalSnapshot | undefined, right: LocalSnapshot | undefined): boolean {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size) || (!left && !right);
}

function expectedLocalSnapshot(path: string, observed: ReadonlyMap<string, LocalSnapshot | undefined>, previous: PrivateSyncEntry | undefined): LocalSnapshot | undefined {
  if (observed.has(path)) return observed.get(path);
  return isLive(previous) ? { path, sha256: previous.sha256, size: previous.size, updatedAt: previous.updatedAt } : undefined;
}

function planPrivateSync(
  remoteEntries: Record<string, PrivateSyncEntry>,
  local: ReadonlyMap<string, LocalSnapshot | undefined>,
  previous: Record<string, PrivateSyncEntry>,
  logger: Logger,
  fullLocalSnapshot: boolean
): PrivateSyncPlan {
  const paths = new Set([...Object.keys(previous), ...Object.keys(remoteEntries), ...local.keys()]);
  const nextEntries = { ...remoteEntries };
  const remoteUploads: PrivateRemoteUpload[] = [];
  const localApplications: PrivateLocalApplication[] = [];
  let conflictsResolved = 0;
  let logicalRemoteDeletes = 0;

  const planUpload = (path: string, entry: LocalSnapshot): void => {
    const objectKey = versionedRemoteFilePath(path, entry.sha256);
    remoteUploads.push({ path, entry, objectKey });
    nextEntries[path] = { sha256: entry.sha256, size: entry.size, updatedAt: Date.now(), objectKey };
  };
  const planRemoteDeletion = (path: string): void => {
    nextEntries[path] = { deletedAt: Date.now() };
    logicalRemoteDeletes += 1;
  };

  for (const path of [...paths].sort()) {
    const localObserved = local.has(path);
    const localEntry = local.get(path);
    const remoteEntry = remoteEntries[path];
    const previousEntry = previous[path];
    const localChanged = localObserved
      ? localEntry ? !sameContent(localEntry, previousEntry) : Boolean(isLive(previousEntry))
      : fullLocalSnapshot ? Boolean(isLive(previousEntry)) : false;
    const remoteChanged = !equalEntries(remoteEntry, previousEntry);
    const expectedLocal = expectedLocalSnapshot(path, local, previousEntry);

    if (localChanged && remoteChanged) {
      if (sameContent(localEntry, remoteEntry) || (!localEntry && remoteEntry?.deletedAt)) continue;
      conflictsResolved += 1;
      // A deletion has no trustworthy local timestamp. Preserve a concurrent
      // remote edit rather than creating a tombstone from ambiguous intent.
      if (!localEntry && isLive(remoteEntry)) {
        localApplications.push({ kind: "download", path, entry: remoteEntry, expectedLocal });
        logger.warn("Private sync conflict resolved with remote version", { path, reason: "local deletion and remote change" });
        continue;
      }
      if (localEntry && remoteEntry?.deletedAt) {
        planUpload(path, localEntry);
        logger.warn("Private sync conflict resolved with local version", { path, reason: "remote deletion and local change" });
        continue;
      }
      if ((localEntry?.updatedAt ?? 0) >= entryTime(remoteEntry)) {
        if (localEntry) planUpload(path, localEntry);
        else planRemoteDeletion(path);
        logger.warn("Private sync conflict resolved with newer local version", { path });
      } else if (isLive(remoteEntry)) {
        localApplications.push({ kind: "download", path, entry: remoteEntry, expectedLocal });
        logger.warn("Private sync conflict resolved with newer remote version", { path });
      } else {
        localApplications.push({ kind: "delete-local", path, expectedLocal });
        logger.warn("Private sync conflict resolved with newer remote deletion", { path });
      }
      continue;
    }

    if (localChanged) {
      if (localEntry) planUpload(path, localEntry);
      else planRemoteDeletion(path);
    } else if (remoteChanged) {
      if (isLive(remoteEntry)) localApplications.push({ kind: "download", path, entry: remoteEntry, expectedLocal });
      else if (remoteEntry?.deletedAt) localApplications.push({ kind: "delete-local", path, expectedLocal });
    }
  }
  return { nextEntries, remoteUploads, localApplications, conflictsResolved, logicalRemoteDeletes };
}

export class PrivateNotesSynchronizer {
  constructor(
    private readonly settings: TeamCoreSettings,
    private readonly logger: Logger,
    private readonly remote: PrivateSyncRemote = createPrivateRemote(settings, logger),
    private readonly transactionPath = "private-sync-transaction.json"
  ) {}

  async sync(vault: BinaryVault, state: PrivateSyncState, onProgress?: PrivateSyncProgress, fullScan = false): Promise<PrivateSyncResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await this.syncOnce(vault, state, onProgress, fullScan);
      if (result) return result;
      this.logger.warn("Private sync index changed during conditional commit; replanning", { attempt });
    }
    throw new Error("私人笔记同步清单在其他设备上连续更新，未覆盖远端数据，请稍后重试");
  }

  private async syncOnce(vault: BinaryVault, state: PrivateSyncState, onProgress: PrivateSyncProgress | undefined, fullScan: boolean): Promise<PrivateSyncResult | undefined> {
    await vault.mkdir(PRIVATE_FOLDER);
    await this.recoverLocalTransaction(vault);
    await this.remote.initialize();
    const pendingPaths = [...new Set(state.pendingPaths ?? [])].sort();
    // A missing baseline is an explicit recovery boundary. Every later normal
    // cycle reads only paths recorded from Vault events.
    const useFullScan = fullScan || state.baselineEstablished !== true;
    const [remoteIndex, local] = await Promise.all([
      this.remote.readIndex(),
      useFullScan
        ? scanPrivateFiles(vault)
        : Promise.all(pendingPaths.map(async (path) => [path, await readPrivateFile(vault, path)] as const))
          .then((entries) => new Map<string, LocalSnapshot | undefined>(entries))
    ]);
    const parsedManifest = parseManifest(remoteIndex.data);
    const remoteEntries = { ...(parsedManifest?.entries ?? {}) };
    const previous = state.version === 1 ? state.entries : {};
    ensureRemoteContinuity(remoteEntries, previous);
    const plan = planPrivateSync(remoteEntries, local, previous, this.logger, useFullScan);
    let current = 0;
    const total = Math.max(plan.remoteUploads.length + plan.localApplications.length + 1, 1);
    const advance = (path: string): void => { current += 1; onProgress?.(current, total, path); };
    let uploaded = 0;
    // Validate all required remote bytes before publishing the index or
    // changing local files. This makes a corrupt object fail as a no-op.
    await this.downloadAndStage(vault, plan.localApplications);
    // Phase 1: immutable object writes. These are harmless if a subsequent
    // index CAS loses a race and can be re-used by any future manifest.
    for (const upload of plan.remoteUploads) {
      const current = await readPrivateFile(vault, upload.path);
      if (!current || !sameLocalSnapshot(current, upload.entry)) {
        throw new Error(`私人笔记在上传期间已被修改：${upload.path}；已停止同步以保护本地内容，请重新同步`);
      }
      if (current.size > VAULT_TRANSFER_CHUNK_SIZE) {
        if (!this.remote.writeFromChunks) throw new Error(`当前私人同步服务不支持大文件上传：${upload.path}`);
        await this.remote.writeFromChunks(upload.objectKey, current.sha256, current.size, mimeFromPath(upload.path), (onChunk) =>
          readVaultInChunks(vault, `${PRIVATE_FOLDER}/${upload.path}`, current.size, onChunk)
        );
      } else {
        const data = await vault.read(`${PRIVATE_FOLDER}/${upload.path}`);
        if (data.byteLength !== current.size || await sha256Hex(data) !== current.sha256) throw new Error(`私人笔记在上传期间已被修改：${upload.path}`);
        await this.remote.write(upload.objectKey, data, mimeFromPath(upload.path));
      }
      uploaded += 1;
      advance(upload.path);
    }
    // Phase 2: publish the complete index atomically. No local file has been
    // changed yet, so a conflict retry always sees the user's original state.
    if (!sameManifestEntries(plan.nextEntries, remoteEntries)) {
      const indexWrite = await this.remote.writeIndex(manifestData(plan.nextEntries), remoteIndex.version);
      if (indexWrite === "conflict") return undefined;
      advance("私人笔记同步清单");
    }
    // Phase 3: materialize remote effects only after the remote authority is
    // established. Tombstones intentionally retain immutable objects; GC is a
    // separate delayed, reference-aware maintenance concern.
    const applied = await this.applyLocalTransaction(vault, plan.localApplications, advance, "同步");
    return {
      state: { version: 1, entries: plan.nextEntries, baselineEstablished: true, pendingPaths: [] },
      uploaded,
      downloaded: applied.downloaded,
      deletedRemote: plan.logicalRemoteDeletes,
      deletedLocal: applied.deletedLocal,
      conflictsResolved: plan.conflictsResolved,
      preservedLocal: 0
    };
  }

  private transactionStageRoot(): string {
    return `${this.transactionPath}.staging`;
  }

  private stagedPath(kind: "before" | "target", path: string): string {
    return `${this.transactionStageRoot()}/${kind}/${base64UrlEncode(privateRelativePath(path))}`;
  }

  private async verifyStagedFile(vault: BinaryVault, staged: PrivateStagedFile): Promise<void> {
    const stat = await vault.stat(staged.path).catch(() => null);
    // Targets have already been SHA-256 checked while bytes were received;
    // before-images were checked while copied. Re-reading a large staging file
    // here would defeat the Range-transfer memory bound.
    if (!stat || stat.type !== "file" || stat.size !== staged.size) {
      throw new Error(`私人笔记事务暂存文件无效：${staged.path}`);
    }
  }

  private async stageExistingPrivateFile(vault: BinaryVault, path: string, snapshot: LocalSnapshot): Promise<PrivateStagedFile> {
    const staged: PrivateStagedFile = { path: this.stagedPath("before", path), sha256: snapshot.sha256, size: snapshot.size };
    await vault.remove(staged.path).catch(() => undefined);
    const hasher = await createSHA256();
    hasher.init();
    await readVaultInChunks(vault, `${PRIVATE_FOLDER}/${path}`, snapshot.size, async (chunk) => {
      hasher.update(new Uint8Array(chunk));
      await vault.append(staged.path, chunk);
    });
    if (hasher.digest() !== snapshot.sha256) throw new Error(`私人笔记在事务准备期间已被修改：${path}`);
    return staged;
  }

  private async downloadAndStage(vault: BinaryVault, operations: readonly PrivateLocalApplication[]): Promise<void> {
    await vault.rmdir(this.transactionStageRoot(), true).catch(() => undefined);
    for (const operation of operations) {
      if (operation.kind !== "download") continue;
      const targetPath = this.stagedPath("target", operation.path);
      const expectedSize = operation.entry.size;
      const expectedHash = operation.entry.sha256;
      if (typeof expectedHash !== "string" || typeof expectedSize !== "number" || !Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error(`私人笔记远端条目无效：${operation.path}`);
      if (expectedSize > VAULT_TRANSFER_CHUNK_SIZE && this.remote.readInChunks) {
        const hasher = await createSHA256();
        hasher.init();
        let nextOffset = 0;
        await this.remote.readInChunks(entryRemoteFilePath(operation.path, operation.entry), expectedSize, async (chunk, offset, total) => {
          if (total !== expectedSize || offset !== nextOffset || !chunk.byteLength || offset + chunk.byteLength > expectedSize) {
            throw new Error(`私人笔记远端分片响应无效：${operation.path}`);
          }
          hasher.update(new Uint8Array(chunk));
          await vault.append(targetPath, chunk);
          nextOffset += chunk.byteLength;
        });
        if (nextOffset !== expectedSize || hasher.digest() !== expectedHash) throw new Error(`私人笔记远端文件校验失败：${operation.path}`);
        continue;
      }
      if (expectedSize > VAULT_TRANSFER_CHUNK_SIZE) {
        throw new Error(`当前私人同步服务不支持安全分片下载：${operation.path}；请改用支持 Range 的 WebDAV/S3 服务`);
      }
      const data = await this.remote.read(entryRemoteFilePath(operation.path, operation.entry));
      if (!data || await sha256Hex(data) !== expectedHash || data.byteLength !== expectedSize) throw new Error(`私人笔记远端文件校验失败：${operation.path}`);
      await vault.write(targetPath, data);
    }
  }

  private async stagedTarget(vault: BinaryVault, path: string, entry: PrivateSyncEntry): Promise<PrivateStagedFile> {
    if (typeof entry.sha256 !== "string" || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size)) throw new Error(`私人笔记下载计划无效：${path}`);
    const staged: PrivateStagedFile = { path: this.stagedPath("target", path), sha256: entry.sha256, size: entry.size };
    await this.verifyStagedFile(vault, staged);
    return staged;
  }

  private async replaceFromStage(vault: BinaryVault, staged: PrivateStagedFile, destination: string): Promise<void> {
    await this.verifyStagedFile(vault, staged);
    if (await vault.exists(destination)) await vault.remove(destination);
    const parent = normalizeVaultPath(destination).split("/").slice(0, -1).join("/");
    if (parent) await vault.mkdir(parent);
    await vault.rename(staged.path, destination);
  }

  /**
   * Applies a bounded, durable write transaction. Only planned paths are read
   * or journaled. A failed write is rolled back immediately; a crash leaves a
   * journal that is completed or rejected before any later reconciliation.
   */
  private async applyLocalTransaction(
    vault: BinaryVault,
    operations: readonly PrivateLocalApplication[],
    advance: (path: string) => void,
    phase: string
  ): Promise<{ downloaded: number; deletedLocal: number }> {
    const journalOperations: PrivateLocalTransactionEntry[] = [];
    for (const operation of operations) {
      const current = await readPrivateFile(vault, operation.path);
      if (!sameLocalSnapshot(current, operation.expectedLocal)) {
        throw new Error(`私人笔记在${phase}期间已被修改：${operation.path}；已停止写入以保护本地内容，请重新${phase}`);
      }
      const before = current
        ? await this.stageExistingPrivateFile(vault, operation.path, current)
        : undefined;
      const target = operation.kind === "download" ? await this.stagedTarget(vault, operation.path, operation.entry) : undefined;
      journalOperations.push({ kind: operation.kind, path: operation.path, ...(before ? { before } : {}), ...(target ? { target } : {}) });
    }
    const journal: PrivateLocalTransaction = {
      version: 2,
      operations: journalOperations
    };
    await vault.write(this.transactionPath, new TextEncoder().encode(JSON.stringify(journal)).buffer);
    let downloaded = 0;
    let deletedLocal = 0;
    try {
      for (const operation of operations) {
        const current = await readPrivateFile(vault, operation.path);
        if (!sameLocalSnapshot(current, operation.expectedLocal)) throw new Error(`私人笔记在${phase}期间已被修改：${operation.path}`);
        if (operation.kind === "download") {
          const target = journalOperations.find((entry) => entry.path === operation.path)?.target;
          if (!target) throw new Error(`私人笔记下载计划丢失：${operation.path}`);
          await this.replaceFromStage(vault, target, `${PRIVATE_FOLDER}/${operation.path}`);
          downloaded += 1;
        } else {
          const localPath = `${PRIVATE_FOLDER}/${operation.path}`;
          if (await vault.exists(localPath)) await vault.remove(localPath);
          deletedLocal += 1;
        }
        advance(operation.path);
      }
      await vault.remove(this.transactionPath);
      await vault.rmdir(this.transactionStageRoot(), true).catch(() => undefined);
      return { downloaded, deletedLocal };
    } catch (error) {
      let rollbackError: unknown;
      try {
        await this.rollbackLocalTransaction(vault, journal);
      } catch (rollback) {
        rollbackError = rollback;
      }
      if (rollbackError instanceof Error) {
        throw new Error(`私人笔记${phase}失败且自动回滚未完成：${rollbackError.message}；请勿继续同步并保留诊断日志`);
      }
      throw error;
    }
  }

  private async recoverLocalTransaction(vault: BinaryVault): Promise<void> {
    const data = await vault.read(this.transactionPath).catch(() => undefined);
    if (!data) {
      await vault.rmdir(this.transactionStageRoot(), true).catch(() => undefined);
      return;
    }
    let journal: PrivateLocalTransaction;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as PrivateLocalTransaction;
      if (parsed.version !== 2 || !Array.isArray(parsed.operations)) throw new Error("事务结构无效");
      journal = parsed;
      for (const operation of journal.operations) {
        privateRelativePath(operation.path);
        const validStaged = (staged: PrivateStagedFile | undefined, kind: "before" | "target"): boolean => !staged || (
          typeof staged.path === "string" && staged.path === this.stagedPath(kind, operation.path)
          && typeof staged.sha256 === "string" && /^[0-9a-f]{64}$/i.test(staged.sha256)
          && Number.isSafeInteger(staged.size) && staged.size >= 0
        );
        if ((operation.kind !== "download" && operation.kind !== "delete-local") || !validStaged(operation.before, "before") || !validStaged(operation.target, "target") || (operation.kind === "download" && !operation.target)) {
          throw new Error("事务条目无效");
        }
      }
    } catch (error) {
      throw new Error(`私人笔记本地事务日志无效，已停止同步以保护数据：${error instanceof Error ? error.message : String(error)}`);
    }
    // The journal is written only after remote authority has been published or
    // a read-only pull has fully verified its source bytes. Complete it only
    // when every path remains either at its before-image or its intended end.
    for (const operation of journal.operations) {
      const current = await readPrivateFile(vault, operation.path);
      const matches = (value: LocalSnapshot | undefined, expected: PrivateStagedFile | undefined): boolean =>
        Boolean(value && expected && value.sha256 === expected.sha256 && value.size === expected.size) || (!value && !expected);
      const intended = operation.kind === "download" ? operation.target : undefined;
      if (matches(current, intended)) continue;
      // A crash can happen after replaceFromStage removes an old destination
      // but before its rename. The verified target staging file remains the
      // authority in that narrow swap window.
      const interruptedReplacement = operation.kind === "download" && !current && Boolean(operation.before);
      if (!matches(current, operation.before) && !interruptedReplacement) throw new Error(`私人笔记事务恢复发现新的本地编辑：${operation.path}；已停止同步以保护数据`);
      if (operation.kind === "download") {
        if (!operation.target) throw new Error(`私人笔记事务缺少下载目标：${operation.path}`);
        await this.replaceFromStage(vault, operation.target, `${PRIVATE_FOLDER}/${operation.path}`);
      } else if (await vault.exists(`${PRIVATE_FOLDER}/${operation.path}`)) {
        await vault.remove(`${PRIVATE_FOLDER}/${operation.path}`);
      }
    }
    await vault.remove(this.transactionPath);
    await vault.rmdir(this.transactionStageRoot(), true).catch(() => undefined);
  }

  private async rollbackLocalTransaction(vault: BinaryVault, journal: PrivateLocalTransaction): Promise<void> {
    for (const operation of [...journal.operations].reverse()) {
      const current = await readPrivateFile(vault, operation.path);
      const currentMatchesTarget = operation.kind === "delete-local"
        ? current === undefined
        : Boolean(current && operation.target && current.sha256 === operation.target.sha256 && current.size === operation.target.size);
      const removedBeforeRename = operation.kind === "download" && !current && Boolean(operation.before);
      if (!currentMatchesTarget && !removedBeforeRename) continue;
      if (operation.before) await this.replaceFromStage(vault, operation.before, `${PRIVATE_FOLDER}/${operation.path}`);
      else if (await vault.exists(`${PRIVATE_FOLDER}/${operation.path}`)) await vault.remove(`${PRIVATE_FOLDER}/${operation.path}`);
    }
    await vault.remove(this.transactionPath);
    await vault.rmdir(this.transactionStageRoot(), true).catch(() => undefined);
  }

  /** Applies remote private notes without uploading local-only files or changing the remote manifest. */
  async pull(vault: BinaryVault, state: PrivateSyncState, onProgress?: PrivateSyncProgress, overwriteLocal = false): Promise<PrivateSyncResult> {
    await vault.mkdir(PRIVATE_FOLDER);
    await this.recoverLocalTransaction(vault);
    await this.remote.initialize();
    const [remoteIndex, local] = await Promise.all([this.remote.readIndex(), scanPrivateFiles(vault)]);
    const remoteEntries = { ...(parseManifest(remoteIndex.data)?.entries ?? {}) };
    const previous = state.version === 1 ? state.entries : {};
    ensureRemoteContinuity(remoteEntries, previous);
    const operations: PrivateLocalApplication[] = [];
    let preservedLocal = 0;
    const preservedPaths = new Set<string>();

    for (const path of Object.keys(remoteEntries).sort()) {
      const remoteEntry = remoteEntries[path];
      const localEntry = local.get(path);
      const previousEntry = previous[path];
      const localChanged = localEntry ? !sameContent(localEntry, previousEntry) : Boolean(isLive(previousEntry));
      if (isLive(remoteEntry)) {
        if (!sameContent(localEntry, remoteEntry) && !overwriteLocal && localChanged) {
          preservedLocal += 1;
          preservedPaths.add(path);
          this.logger.warn("Private remote import retained local change", { path });
        } else if (!sameContent(localEntry, remoteEntry)) {
          operations.push({ kind: "download", path, entry: remoteEntry, expectedLocal: localEntry });
        }
        continue;
      }
      // A remote tombstone only removes an unchanged file known to this
      // client. A local-only or locally edited note is retained for safety.
      if (remoteEntry.deletedAt && !overwriteLocal && localChanged) {
        preservedLocal += 1;
        preservedPaths.add(path);
        this.logger.warn("Private remote import retained local change", { path });
        continue;
      }
      if (remoteEntry.deletedAt && (overwriteLocal || isLive(previousEntry))) {
        operations.push({ kind: "delete-local", path, expectedLocal: localEntry });
      }
    }
    // A deliberate reset means the remote index is the complete desired local
    // set. Keep local-only files until all remote downloads have validated.
    if (overwriteLocal) {
      for (const [path, localEntry] of local) {
        if (!remoteEntries[path]) operations.push({ kind: "delete-local", path, expectedLocal: localEntry });
      }
    }
    // Local-only files are equally important retained changes. They are not
    // present in the remote loop above, but must remain pending for a later
    // bidirectional sync instead of being reported as fully synchronized.
    if (!overwriteLocal) {
      for (const path of local.keys()) {
        if (!remoteEntries[path]) {
          preservedLocal += 1;
          preservedPaths.add(path);
        }
      }
    }

    let current = 0;
    const total = Math.max(operations.length, 1);
    const advance = (path: string): void => { current += 1; onProgress?.(current, total, path); };
    // Fetch and validate every remote byte before applying any destructive
    // local change. A reset must not empty the Vault merely because one later
    // remote object is unavailable or corrupt.
    await this.downloadAndStage(vault, operations);
    const applied = await this.applyLocalTransaction(vault, operations, advance, "导入");
    if (!operations.length) onProgress?.(1, 1, "私人笔记已是最新");
    return {
      state: { version: 1, entries: remoteEntries, baselineEstablished: true, pendingPaths: [...new Set([...(state.pendingPaths ?? []), ...preservedPaths])].sort() },
      uploaded: 0,
      downloaded: applied.downloaded,
      deletedRemote: 0,
      deletedLocal: applied.deletedLocal,
      conflictsResolved: 0,
      preservedLocal
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

  async readInChunks(path: string, expectedSize: number, onChunk: PrivateRemoteChunkTarget): Promise<void> {
    let offset = 0;
    while (offset < expectedSize) {
      const end = Math.min(offset + VAULT_TRANSFER_CHUNK_SIZE, expectedSize) - 1;
      const response = await this.request("GET", path, undefined, undefined, { range: `bytes=${offset}-${end}` });
      if (response.status === 404) throw new Error(`私人笔记远端文件不存在：${path}`);
      if (response.status !== 206) throw new Error(`WebDAV 未支持私人笔记安全分片下载（HTTP ${response.status}）：${path}`);
      const length = end - offset + 1;
      const contentRange = response.headers["content-range"] ?? "";
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== end || Number(range[3]) !== expectedSize || response.arrayBuffer.byteLength !== length) {
        throw new Error(`WebDAV 私人笔记分片响应无效：${path}`);
      }
      await onChunk(response.arrayBuffer, offset, expectedSize);
      offset = end + 1;
    }
  }

  async readIndex(): Promise<PrivateRemoteIndex> {
    const response = await this.request("GET", REMOTE_INDEX);
    if (response.status === 404) return { data: undefined, version: undefined };
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV GET ${REMOTE_INDEX} 失败（HTTP ${response.status}）`);
    const version = response.headers.etag;
    if (!version) throw new Error("WebDAV 未返回 ETag，无法安全同步私人笔记");
    if (/^W\//i.test(version.trim())) throw new Error("WebDAV 仅返回弱 ETag，无法安全条件写入私人笔记清单");
    return { data: response.arrayBuffer, version };
  }

  async write(path: string, data: ArrayBuffer, contentType: string): Promise<void> {
    const response = await this.request("PUT", path, data, contentType);
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV PUT ${path} 失败（HTTP ${response.status}）`);
  }

  async writeFromChunks(path: string, sha256: string, size: number, contentType: string, source: ChunkUploadSource): Promise<void> {
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), this.root).toString();
    const headers: Record<string, string> = { "cache-control": "no-cache", "content-type": contentType };
    if (this.authorization) headers.authorization = this.authorization;
    const hasher = await createSHA256();
    hasher.init();
    let nextOffset = 0;
    let wakeConsumer: (() => void) | undefined;
    let cancelled = false;
    let producerFinished = false;
    let finishProducer: () => void;
    let failProducer: (error: unknown) => void;
    const producer = new Promise<void>((resolve, reject) => {
      finishProducer = resolve;
      failProducer = reject;
    });
    const cancelProducer = (error: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      wakeConsumer?.();
      wakeConsumer = undefined;
      failProducer(error);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          try {
            await source(async (chunk, offset, total) => {
              if (cancelled || total !== size || offset !== nextOffset || !chunk.byteLength || offset + chunk.byteLength > size) {
                throw new Error(`WebDAV 上传源在传输期间发生变化：${path}`);
              }
              while (!cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) {
                await new Promise<void>((resolve) => { wakeConsumer = resolve; });
              }
              if (cancelled) throw new Error(`WebDAV 大文件上传已取消：${path}`);
              hasher.update(new Uint8Array(chunk));
              controller.enqueue(new Uint8Array(chunk));
              nextOffset += chunk.byteLength;
            });
            if (nextOffset !== size || hasher.digest() !== sha256.toLowerCase()) throw new Error(`私人笔记在上传期间已被修改：${path}`);
            producerFinished = true;
            controller.close();
            finishProducer();
          } catch (error) {
            cancelProducer(error);
            controller.error(error);
          }
        })();
      },
      pull: () => {
        wakeConsumer?.();
        wakeConsumer = undefined;
      },
      cancel: () => {
        cancelProducer(new Error(`WebDAV 大文件上传已取消：${path}`));
      }
    });
    this.logger.debug("Private WebDAV streamed upload", { path, size });
    const request = { method: "PUT", headers, body: stream, duplex: "half" } as RequestInit & { duplex: string };
    // requestUrl accepts only buffered bodies, not a backpressured ReadableStream.
    let response: Response;
    try {
      response = await window.fetch(url, request);
    } catch (error) {
      cancelProducer(error);
      await producer.catch(() => undefined);
      throw error;
    }
    // A compliant client normally resolves fetch after consuming the request
    // body. Treat an early server response as a failed upload rather than
    // publishing an index that could reference an incomplete object.
    if (!producerFinished) {
      const error = new Error(`WebDAV 在完整上传前返回响应：${path}`);
      cancelProducer(error);
      await producer.catch(() => undefined);
      throw error;
    }
    await producer;
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV 大文件 PUT ${path} 失败（HTTP ${response.status}）`);
  }

  async writeIndex(data: ArrayBuffer, version: string | undefined): Promise<PrivateIndexWriteResult> {
    const condition: Record<string, string> = version ? { "if-match": version } : { "if-none-match": "*" };
    const response = await this.request("PUT", REMOTE_INDEX, data, "application/json", condition);
    if (response.status === 409 || response.status === 412) return "conflict";
    if (response.status < 200 || response.status >= 300) throw new Error(`WebDAV 条件写入私人同步清单失败（HTTP ${response.status}）`);
    return "written";
  }

  private async mkcol(path: string): Promise<void> {
    const response = await this.request("MKCOL", path);
    if (![200, 201, 204, 405].includes(response.status)) throw new Error(`WebDAV 无法创建私人同步目录（HTTP ${response.status}）`);
  }

  private async request(method: string, path: string, body?: ArrayBuffer, contentType?: string, extraHeaders: Record<string, string> = {}) {
    const url = new URL(path.split("/").map(encodeURIComponent).join("/"), this.root).toString();
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    if (this.authorization) headers.authorization = this.authorization;
    if (contentType) headers["content-type"] = contentType;
    Object.assign(headers, extraHeaders);
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
  readInChunks(path: string, expectedSize: number, onChunk: PrivateRemoteChunkTarget): Promise<void> {
    return this.transport.readObjectInChunks(path, expectedSize, onChunk);
  }
  write(path: string, data: ArrayBuffer, contentType: string): Promise<void> { return this.transport.writeObject(path, data, contentType); }
  writeFromChunks(path: string, sha256: string, size: number, contentType: string, source: ChunkUploadSource): Promise<void> {
    return this.transport.writeObjectFromChunks(path, sha256, size, contentType, source);
  }
  readIndex(): Promise<PrivateRemoteIndex> { return this.transport.readObjectWithVersion(REMOTE_INDEX); }
  writeIndex(data: ArrayBuffer, version: string | undefined): Promise<PrivateIndexWriteResult> {
    return this.transport.writeObjectIfUnchanged(REMOTE_INDEX, data, "application/json", version);
  }
}

export function createPrivateRemote(settings: TeamCoreSettings, logger: Logger): PrivateSyncRemote {
  return settings.privateSyncProvider === "s3"
    ? new S3PrivateRemote(settings, logger)
    : new WebDavPrivateRemote(settings, logger);
}
