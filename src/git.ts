import git, { STAGE, TREE, walk, type GitProgressEvent, type MergeDriverParams } from "isomorphic-git";
import diff3Merge from "diff3";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { AssetManifest, CommitChangeDetails, CommitDocumentChange, CommitPluginChange, Logger, CommitSummary, PendingPublicMove, TeamCoreSettings } from "./types";
import { collectMarkdownReferences, isAssetPath, isManagedPath, isPrivatePath, normalizeVaultPath, type BinaryVault } from "./vault";
import { DEFAULT_BRANCH, FILE_AUTHORS_PATH, MANIFEST_PATH, PRIVATE_FOLDER } from "./constants";
import { mergeAssetManifests, serializeManifest, validateManifest } from "./manifest";
import { isPotentialPluginPath, isSharedPluginPath, mergeSharedPluginIds, mergeSharedPluginState, parseSharedPluginState, pluginIdFromPath, readSharedPluginIds, readSharedPluginIdsFromGitignore, readSharedPluginState, SHARED_PLUGIN_STATE_PATH, serializeSharedPluginState, stripSharedPluginsFromGitignore, updateSharedPluginsInGitignore, writeSharedPluginIds } from "./shared-plugins";
import { mergeFileAuthorRegistries, parseFileAuthorRegistry, serializeFileAuthorRegistry } from "./file-authors";

const CONFLICT_STATE_PATH = ".git/team-core-conflict.json";
const LINEBREAKS = /^.*(\r?\n|$)/gm;
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface GitConflictState {
  version: 1;
  localOid: string;
  remoteOid: string;
  files: string[];
  detectedAt: string;
  /** Pull-first replay conflicts leave HEAD on the integrated remote commit. */
  mode?: "branch-merge" | "index-replay";
  headOid?: string;
  transactionId?: string;
}

interface GitFileVersion {
  oid: string;
  data: Uint8Array;
}

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array | ArrayBuffer;
}

interface GitHttpResponse {
  url: string;
  method?: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

export interface GitRemoteInfo {
  heads: Record<string, string>;
  tags: Record<string, string>;
  defaultBranch?: string;
}

/** Authoritative, startup/recovery view of worktree changes. */
export interface ManagedWorktreeRecovery {
  changedManagedPaths: string[];
  hasBoundaryRepair: boolean;
  hasChanges: boolean;
}

/** A public, managed path whose worktree or index differs from HEAD. */
export interface PublicWorktreeChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** Whether the current index can safely be parked while fetched remote work is merged. */
export interface PullFirstStashAssessment {
  remoteChanged: boolean;
  canStash: boolean;
  reason?: string;
}

export interface TeamCoreReplayPlan {
  remoteOid: string;
  mergedOid?: string;
  conflicts: string[];
}

export interface ConflictFileVersion {
  path: string;
  base?: string;
  local?: string;
  remote?: string;
}

export interface ConflictEditorSession {
  baseOid: string;
  localOid: string;
  remoteOid: string;
  files: ConflictFileVersion[];
}

export interface ConflictResolution {
  path: string;
  content?: string;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

export function normalizeRemoteInfo(value: unknown): GitRemoteInfo {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const refs = input.refs && typeof input.refs === "object" ? input.refs as Record<string, unknown> : {};
  return {
    heads: stringMap(input.heads ?? refs.heads),
    tags: stringMap(input.tags ?? refs.tags),
    defaultBranch: typeof input.HEAD === "string" ? input.HEAD : typeof refs.HEAD === "string" ? refs.HEAD : undefined
  };
}

export function normalizeGitUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function conflictFilesFromError(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const input = error as { conflictedFiles?: unknown; data?: { filepaths?: unknown } };
  const value = input.data?.filepaths ?? input.conflictedFiles;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path): path is string => typeof path === "string" && path.length > 0))].sort();
}

export function isNonFastForwardPushError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const input = error as { code?: unknown; message?: unknown; data?: { reason?: unknown } };
  return (input.code === "PushRejectedError" && input.data?.reason === "not-fast-forward")
    || (typeof input.message === "string" && /push rejected.*not a simple fast-forward/i.test(input.message));
}

export function isPushReconciliationError(error: unknown): boolean {
  if (isNonFastForwardPushError(error)) return true;
  if (!error || typeof error !== "object") return false;
  const input = error as { code?: unknown; caller?: unknown; data?: { what?: unknown } };
  // A server can advance after fetch to an OID the client has not downloaded.
  // isomorphic-git reports that race as NotFoundError before it can classify
  // the update as non-fast-forward.
  return input.code === "NotFoundError"
    && input.caller === "git.push"
    && typeof input.data?.what === "string"
    && /^[0-9a-f]{40}$/i.test(input.data.what);
}

function textMerge({ branches, contents }: MergeDriverParams): { cleanMerge: boolean; mergedText: string } {
  const [baseContent, ourContent, theirContent] = contents;
  const ours = ourContent.match(LINEBREAKS) ?? [];
  const base = baseContent.match(LINEBREAKS) ?? [];
  const theirs = theirContent.match(LINEBREAKS) ?? [];
  const result = diff3Merge(ours, base, theirs);
  let cleanMerge = true;
  let mergedText = "";
  for (const item of result) {
    if ("ok" in item) mergedText += item.ok.join("");
    else {
      cleanMerge = false;
      mergedText += `<<<<<<< ${branches[1]}\n${item.conflict.a.join("")}=======\n${item.conflict.b.join("")}>>>>>>> ${branches[2]}\n`;
    }
  }
  return { cleanMerge, mergedText };
}

function parseManifestContent(value: string): AssetManifest | undefined {
  try {
    return validateManifest(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function countTextLines(text: string): number {
  if (!text.length) return 0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function teamCoreMergeDriver(params: MergeDriverParams, configDir: string): { cleanMerge: boolean; mergedText: string } {
  if (params.path === MANIFEST_PATH || params.path === "assets-manifest.json") {
    const [base, ours, theirs] = params.contents.map(parseManifestContent);
    if (base && ours && theirs) {
      const merged = mergeAssetManifests(base, ours, theirs);
      if (merged) return { cleanMerge: true, mergedText: serializeManifest(merged) };
    }
  }
  if (params.path === ".gitignore") {
    try {
      const ids = params.contents.map((content) => readSharedPluginIdsFromGitignore(content, configDir));
      const unmanaged = textMerge({
        ...params,
        contents: params.contents.map((content) => stripSharedPluginsFromGitignore(content, configDir))
      });
      if (!unmanaged.cleanMerge) return unmanaged;
      return {
        cleanMerge: true,
        mergedText: updateSharedPluginsInGitignore(unmanaged.mergedText, configDir, mergeSharedPluginIds(ids[0], ids[1], ids[2]))
      };
    } catch {
      return textMerge(params);
    }
  }
  if (params.path === SHARED_PLUGIN_STATE_PATH || params.path === "shared-plugins.json") {
    try {
      const [base, ours, theirs] = params.contents.map(parseSharedPluginState);
      return { cleanMerge: true, mergedText: mergeSharedPluginState(base, ours, theirs) };
    } catch {
      return textMerge(params);
    }
  }
  if (params.path === FILE_AUTHORS_PATH || params.path === "file-authors.json") {
    try {
      const [base, ours, theirs] = params.contents.map(parseFileAuthorRegistry);
      const merged = mergeFileAuthorRegistries(base, ours, theirs);
      if (merged) return { cleanMerge: true, mergedText: serializeFileAuthorRegistry(merged) };
    } catch {
      // Preserve malformed or competing edits for the conflict editor.
    }
  }
  return textMerge(params);
}

async function collectGitBody(body: GitHttpRequest["body"]): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof Uint8Array) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function* responseBody(data: ArrayBuffer): AsyncIterableIterator<Uint8Array> {
  yield new Uint8Array(data);
}

function gitHttpEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/info/refs")) return parsed.searchParams.get("service") ?? "info/refs";
    if (parsed.pathname.endsWith("/git-upload-pack")) return "git-upload-pack";
    if (parsed.pathname.endsWith("/git-receive-pack")) return "git-receive-pack";
    return "other";
  } catch {
    return "unknown";
  }
}

/**
 * Obsidian's requestUrl gives us the complete Smart HTTP response before
 * isomorphic-git parses it. Record only protocol metadata so diagnostics can
 * distinguish server/transfer time from local pack and tree processing without
 * ever retaining a repository URL or authentication material.
 */
function createGitHttp(logger: Logger) {
  return {
    async request(input: GitHttpRequest): Promise<GitHttpResponse> {
      const startedAt = Date.now();
      const endpoint = gitHttpEndpoint(input.url);
      let body: ArrayBuffer | undefined;
      try {
        body = await collectGitBody(input.body);
        const request: RequestUrlParam = {
          url: input.url,
          method: input.method ?? "GET",
          headers: input.headers,
          body,
          throw: false
        };
        const response = await requestUrl(request);
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = String(value);
        logger.debug("Git HTTP request completed", {
          endpoint,
          method: input.method ?? "GET",
          status: response.status,
          requestBytes: body?.byteLength ?? 0,
          responseBytes: response.arrayBuffer.byteLength,
          durationMs: Date.now() - startedAt
        });
        return {
          url: input.url,
          method: input.method,
          statusCode: response.status,
          statusMessage: `HTTP ${response.status}`,
          headers,
          body: responseBody(response.arrayBuffer)
        };
      } catch (error) {
        logger.warn("Git HTTP request failed", {
          endpoint,
          method: input.method ?? "GET",
          requestBytes: body?.byteLength ?? 0,
          durationMs: Date.now() - startedAt,
          error: String(error)
        });
        throw error;
      }
    }
  };
}

class GitFsError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "GitFsError";
  }
}

function cleanPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function basename(path: string): string {
  const clean = cleanPath(path).replace(/\/$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

export function createGitFs(vault: BinaryVault) {
  const read = async (path: string, options?: { encoding?: string }): Promise<string | Uint8Array> => {
    try {
      const data = await vault.read(cleanPath(path));
      if (options?.encoding === "utf8") return new TextDecoder().decode(data);
      return new Uint8Array(data);
    } catch (error) {
      throw new GitFsError(String(error), "ENOENT");
    }
  };
  const write = async (path: string, data: string | Uint8Array | ArrayBuffer): Promise<void> => {
    const value = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    await vault.write(cleanPath(path), value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  };
  return {
    promises: {
      readFile: read,
      writeFile: write,
      unlink: (path: string) => vault.remove(cleanPath(path)),
      rmdir: (path: string) => vault.rmdir(cleanPath(path)),
      mkdir: (path: string) => vault.mkdir(cleanPath(path)),
      rename: (from: string, to: string) => vault.rename(cleanPath(from), cleanPath(to)),
      readdir: async (path: string) => {
        const listed = await vault.list(cleanPath(path));
        return [...(listed.files ?? []), ...(listed.folders ?? [])].map(basename);
      },
      stat: async (path: string) => {
        const value = await vault.stat(cleanPath(path));
        if (!value) throw new GitFsError(`Not found: ${path}`, "ENOENT");
        const mtimeMs = value.mtime || Date.now();
        return {
          isFile: () => value.type === "file",
          isDirectory: () => value.type === "folder",
          isSymbolicLink: () => false,
          size: value.size,
          mtimeMs,
          ctimeMs: mtimeMs,
          dev: 0,
          ino: 0,
          mode: value.type === "file" ? 0o100644 : 0o40755,
          uid: 0,
          gid: 0
        };
      },
      lstat: async (path: string) => {
        const value = await vault.stat(cleanPath(path));
        if (!value) throw new GitFsError(`Not found: ${path}`, "ENOENT");
        const mtimeMs = value.mtime || Date.now();
        return {
          isFile: () => value.type === "file",
          isDirectory: () => value.type === "folder",
          isSymbolicLink: () => false,
          size: value.size,
          mtimeMs,
          ctimeMs: mtimeMs,
          dev: 0,
          ino: 0,
          mode: value.type === "file" ? 0o100644 : 0o40755,
          uid: 0,
          gid: 0
        };
      },
      readlink: async () => { throw new GitFsError("Symlinks are not supported", "EINVAL"); },
      symlink: async () => { throw new GitFsError("Symlinks are not supported", "EINVAL"); }
    }
  };
}

export class GitRepository {
  readonly fs;
  private readonly http: ReturnType<typeof createGitHttp>;
  /** Git trees are immutable; reuse security validation within one operation. */
  private readonly validatedManagedTrees = new Map<string, { files: string[]; sharedPluginIds: string[] }>();
  constructor(
    private readonly vault: BinaryVault,
    private readonly settings: TeamCoreSettings,
    private readonly logger: Logger,
    private readonly configDir: string,
    private readonly sharedPluginIds: readonly string[] = []
  ) {
    this.fs = createGitFs(vault);
    this.http = createGitHttp(logger);
  }

  private auth() {
    return this.settings.gitUsername || this.settings.gitPassword ? { username: this.settings.gitUsername, password: this.settings.gitPassword } : undefined;
  }

  private async gitOptions() {
    const credentials = this.auth();
    return { fs: this.fs, dir: "", http: this.http, onAuth: credentials ? () => credentials : undefined };
  }

  async exists(): Promise<boolean> {
    return this.vault.exists(".git/HEAD");
  }

  async init(): Promise<void> {
    if (!(await this.exists())) await git.init({ fs: this.fs, dir: "", defaultBranch: DEFAULT_BRANCH });
    await this.configureWorktreeMode();
  }

  /** Standardize knowledge-base repositories on content-only file tracking. */
  async configureWorktreeMode(): Promise<void> {
    await git.setConfig({ fs: this.fs, dir: "", path: "core.filemode", value: "false" });
    await this.clearIgnoredModeOnlyIndexChanges();
  }

  async ensureRemote(): Promise<void> {
    await this.configureWorktreeMode();
    const gitUrl = normalizeGitUrl(this.settings.gitUrl);
    if (!gitUrl) throw new Error("Git URL is not configured");
    const remotes = await git.listRemotes({ fs: this.fs, dir: "" });
    if (remotes.some((remote) => remote.remote === "origin")) {
      const current = await this.remoteUrl();
      if (current && normalizeGitUrl(current) !== gitUrl) throw new Error("本地和远端知识库不一致：origin URL 不同");
      await git.setConfig({ fs: this.fs, dir: "", path: "remote.origin.url", value: gitUrl });
      return;
    }
    await git.addRemote({ fs: this.fs, dir: "", remote: "origin", url: gitUrl });
  }

  async clone(onProgress?: (progress: GitProgressEvent) => void): Promise<void> {
    const gitUrl = normalizeGitUrl(this.settings.gitUrl);
    if (!gitUrl) throw new Error("Git URL is not configured");
    // Older plugin versions created this state file during startup, before a
    // remote clone had a chance to materialize the tracked version. Remove a
    // valid bootstrap file when no local repository exists so checkout can
    // proceed without weakening Git's protection for real local files.
    let bootstrapState: ArrayBuffer | undefined;
    if (!(await this.vault.exists(".git/HEAD")) && await this.vault.exists(SHARED_PLUGIN_STATE_PATH)) {
      try {
        await readSharedPluginState(this.vault);
        bootstrapState = await this.vault.read(SHARED_PLUGIN_STATE_PATH);
        await this.vault.remove(SHARED_PLUGIN_STATE_PATH);
      } catch {
        // Preserve malformed state rather than deleting unknown content.
      }
    }
    const personalPluginFiles = await this.snapshotPersonalPluginFiles();
    try {
      await git.clone({ ...(await this.gitOptions()), url: gitUrl, ref: DEFAULT_BRANCH, singleBranch: true, noCheckout: true, onProgress });
      await this.configureWorktreeMode();
      const remoteTree = await this.validateManagedTree("HEAD");
      for (const path of remoteTree.files) {
        if (isSharedPluginPath(path, this.configDir, remoteTree.sharedPluginIds) && await this.vault.exists(path)) {
          await this.vault.remove(path);
        }
      }
      await git.checkout({ fs: this.fs, dir: "", ref: DEFAULT_BRANCH });
      await this.materializeSharedPluginFiles();
      await this.restorePersonalPluginFiles(personalPluginFiles);
    } catch (error) {
      if (await this.vault.exists(".git")) await this.vault.rmdir(".git", true).catch(() => undefined);
      await this.restoreAllPluginFiles(personalPluginFiles).catch(() => undefined);
      if (bootstrapState) await this.vault.write(SHARED_PLUGIN_STATE_PATH, bootstrapState).catch(() => undefined);
      throw error;
    }
  }

  private async validateManagedTree(ref: string): Promise<{ files: string[]; sharedPluginIds: string[] }> {
    const oid = /^[0-9a-f]{40}$/i.test(ref)
      ? ref.toLowerCase()
      : await git.resolveRef({ fs: this.fs, dir: "", ref });
    const cached = this.validatedManagedTrees.get(oid);
    if (cached) return { files: [...cached.files], sharedPluginIds: [...cached.sharedPluginIds] };
    const files = await git.listFiles({ fs: this.fs, dir: "", ref: oid });
    let sharedPluginIds: string[] = [];
    if (files.includes(".gitignore")) {
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid, filepath: ".gitignore" });
      sharedPluginIds = readSharedPluginIdsFromGitignore(new TextDecoder().decode(blob), this.configDir);
    }
    const forbidden = files.filter((path) => !isManagedPath(path, this.configDir, sharedPluginIds));
    if (forbidden.length) {
      const preview = forbidden.slice(0, 5).join(", ");
      const remaining = forbidden.length > 5 ? ` 等 ${forbidden.length} 个文件` : "";
      throw new Error(`远端仓库包含禁止同步路径，已拒绝写入本地：${preview}${remaining}`);
    }
    const result = { files: [...files], sharedPluginIds: [...sharedPluginIds] };
    this.validatedManagedTrees.set(oid, result);
    return { files: [...result.files], sharedPluginIds: [...result.sharedPluginIds] };
  }

  async remoteInfo(): Promise<GitRemoteInfo> {
    const gitUrl = normalizeGitUrl(this.settings.gitUrl);
    if (!gitUrl) throw new Error("Git URL is not configured");
    const credentials = this.auth();
    const info = await git.getRemoteInfo({ url: gitUrl, http: this.http, onAuth: credentials ? () => credentials : undefined });
    return normalizeRemoteInfo(info);
  }

  async remoteUrl(): Promise<string | undefined> {
    const value: unknown = await git.getConfig({ fs: this.fs, dir: "", path: "remote.origin.url" }).catch(() => undefined);
    return typeof value === "string" ? value : undefined;
  }

  /** Current local HEAD, exposed for durable synchronization checkpoints. */
  async headOid(): Promise<string | undefined> {
    return git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
  }

  /** Read one file from the current local HEAD without touching the worktree. */
  async readHeadFile(path: string): Promise<ArrayBuffer | undefined> {
    const filepath = normalizeVaultPath(path);
    if (!filepath) return undefined;
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!head) return undefined;
    try {
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid: head, filepath });
      return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
    } catch {
      return undefined;
    }
  }

  /**
   * Restore exact managed worktree paths from HEAD.  It deliberately does not
   * perform checkout/reset for any other path, so unrelated local edits and
   * additions remain untouched.
   */
  async restoreManagedPathsFromHead(paths: readonly string[]): Promise<string[]> {
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!head) return [];
    const sharedPluginIds = await this.currentSharedPluginIds();
    const tracked = new Set(await git.listFiles({ fs: this.fs, dir: "", ref: head }));
    const restored: string[] = [];
    for (const candidate of [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort()) {
      if (candidate === MANIFEST_PATH || !isManagedPath(candidate, this.configDir, sharedPluginIds) || !tracked.has(candidate)) continue;
      await this.writeTreeFile(head, candidate);
      await git.resetIndex({ fs: this.fs, dir: "", filepath: candidate }).catch(() => undefined);
      restored.push(candidate);
    }
    return restored;
  }

  /** Discard exactly one public index/worktree change without touching peers. */
  async discardManagedPathChange(path: string): Promise<"restored" | "removed" | undefined> {
    const filepath = normalizeVaultPath(path);
    if (!filepath || isAssetPath(filepath)) return undefined;
    const sharedPluginIds = await this.currentSharedPluginIds();
    if (!isManagedPath(filepath, this.configDir, sharedPluginIds)) return undefined;
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!head) return undefined;
    const tracked = new Set(await git.listFiles({ fs: this.fs, dir: "", ref: head }));
    if (tracked.has(filepath)) {
      await this.writeTreeFile(head, filepath);
      await git.resetIndex({ fs: this.fs, dir: "", filepath });
      return "restored";
    }
    // A locally added file has no HEAD counterpart. Removing it is the Git
    // equivalent of discarding an uncommitted addition.
    if (await this.vault.exists(filepath)) await this.vault.remove(filepath);
    await git.remove({ fs: this.fs, dir: "", filepath }).catch(() => undefined);
    return "removed";
  }

  private async readConflictState(): Promise<GitConflictState | undefined> {
    if (!(await this.vault.exists(CONFLICT_STATE_PATH))) return undefined;
    try {
      const value = JSON.parse(new TextDecoder().decode(await this.vault.read(CONFLICT_STATE_PATH))) as Partial<GitConflictState>;
      if (value.version !== 1
        || typeof value.localOid !== "string" || !/^[0-9a-f]{40}$/i.test(value.localOid)
        || typeof value.remoteOid !== "string" || !/^[0-9a-f]{40}$/i.test(value.remoteOid)
        || !Array.isArray(value.files) || !value.files.every((path) => typeof path === "string" && path.length > 0)
        || typeof value.detectedAt !== "string"
        || (value.mode !== undefined && value.mode !== "branch-merge" && value.mode !== "index-replay")
        || (value.headOid !== undefined && (typeof value.headOid !== "string" || !/^[0-9a-f]{40}$/i.test(value.headOid)))
        || (value.transactionId !== undefined && (typeof value.transactionId !== "string" || !/^[0-9a-f]{24}$/i.test(value.transactionId)))) throw new Error("invalid shape");
      return value as GitConflictState;
    } catch (error) {
      throw new Error(`本地 Git 冲突状态记录损坏，已停止同步：${String(error)}`);
    }
  }

  private async writeConflictState(state: GitConflictState): Promise<void> {
    const encoded = new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`);
    await this.vault.write(CONFLICT_STATE_PATH, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  }

  private async clearConflictState(): Promise<void> {
    if (await this.vault.exists(CONFLICT_STATE_PATH)) await this.vault.remove(CONFLICT_STATE_PATH);
  }

  private async requireConflictState(): Promise<GitConflictState> {
    const state = await this.readConflictState();
    if (!state) throw new Error("当前没有待解决的同步冲突");
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    const expectedHead = state.mode === "index-replay" ? state.headOid : state.localOid;
    if (!expectedHead || head !== expectedHead) throw new Error("冲突发生后本地提交已变化，请重新同步并重新打开冲突编辑器");
    return state;
  }

  private async readConflictText(oid: string, filepath: string): Promise<string | undefined> {
    try {
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid, filepath });
      if (blob.includes(0)) throw new Error(`冲突文件不是文本，无法在内置编辑器中处理：${filepath}`);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(blob);
      } catch {
        throw new Error(`冲突文件不是有效的 UTF-8 文本，无法在内置编辑器中处理：${filepath}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "NotFoundError") return undefined;
      throw error;
    }
  }

  private async readFileVersion(oid: string, filepath: string): Promise<GitFileVersion | undefined> {
    try {
      const result = await git.readBlob({ fs: this.fs, dir: "", oid, filepath });
      return { oid: result.oid, data: result.blob };
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "NotFoundError") return undefined;
      throw error;
    }
  }

  private mergeFileVersions(
    path: string,
    branches: [string, string, string],
    base: GitFileVersion | undefined,
    local: GitFileVersion | undefined,
    remote: GitFileVersion | undefined,
    resolutions: ReadonlyMap<string, string | undefined>
  ): Uint8Array | undefined {
    if (local?.oid === remote?.oid) return local?.data;
    if (local?.oid === base?.oid) return remote?.data;
    if (remote?.oid === base?.oid) return local?.data;
    if (resolutions.has(path)) {
      const content = resolutions.get(path);
      return content === undefined ? undefined : new TextEncoder().encode(content);
    }
    if (!local || !remote) throw new Error(`文件仍存在未解决的删除冲突：${path}`);
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const merged = teamCoreMergeDriver({
        path,
        branches,
        contents: [base ? decoder.decode(base.data) : "", decoder.decode(local.data), decoder.decode(remote.data)]
      }, this.configDir);
      if (merged.cleanMerge) return new TextEncoder().encode(merged.mergedText);
    } catch {
      // Binary or invalid UTF-8 content requires an explicit external resolution.
    }
    throw new Error(`文件仍存在未解决的内容冲突：${path}`);
  }

  async getConflictEditorSession(): Promise<ConflictEditorSession> {
    const state = await this.requireConflictState();
    const mergeBases: unknown = await git.findMergeBase({ fs: this.fs, dir: "", oids: [state.localOid, state.remoteOid] });
    const baseOid = Array.isArray(mergeBases) ? mergeBases.find((oid): oid is string => typeof oid === "string" && /^[0-9a-f]{40}$/i.test(oid)) : undefined;
    if (!baseOid) throw new Error("无法确定冲突的共同版本，请使用外部 Git 工具处理");
    const files = await Promise.all(state.files.map(async (path) => ({
      path,
      base: await this.readConflictText(baseOid, path),
      local: await this.readConflictText(state.localOid, path),
      remote: await this.readConflictText(state.remoteOid, path)
    })));
    return { baseOid, localOid: state.localOid, remoteOid: state.remoteOid, files };
  }

  async resolveConflicts(resolutions: readonly ConflictResolution[]): Promise<string> {
    const state = await this.requireConflictState();
    if (await this.hasUncommittedChanges()) {
      throw new Error("冲突发生后本地文件又有修改，已拒绝覆盖；请先备份或提交这些修改，再重新打开冲突编辑器");
    }
    const expected = [...state.files].sort();
    const provided = resolutions.map(({ path }) => path).sort();
    if (new Set(provided).size !== provided.length || provided.length !== expected.length || provided.some((path, index) => path !== expected[index])) {
      throw new Error("必须为每个冲突文件提交且仅提交一个解决结果");
    }

    const normalized = resolutions.map((resolution) => {
      if (resolution.path !== normalizeVaultPath(resolution.path)
        || (!isManagedPath(resolution.path, this.configDir, this.sharedPluginIds) && !isPotentialPluginPath(resolution.path, this.configDir))) {
        throw new Error(`冲突文件路径无效：${resolution.path}`);
      }
      if (resolution.path === MANIFEST_PATH) {
        if (resolution.content === undefined) throw new Error("附件清单不能删除，请选择或编辑一个有效版本");
        try {
          return { path: resolution.path, content: serializeManifest(validateManifest(JSON.parse(resolution.content))) };
        } catch (error) {
          throw new Error(`附件清单格式无效：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (resolution.path === ".gitignore" && resolution.content !== undefined) {
        try {
          const ids = readSharedPluginIdsFromGitignore(resolution.content, this.configDir);
          return { path: resolution.path, content: updateSharedPluginsInGitignore(resolution.content, this.configDir, ids) };
        } catch (error) {
          throw new Error(`公共插件配置格式无效：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (resolution.path === SHARED_PLUGIN_STATE_PATH && resolution.content !== undefined) {
        try {
          return { path: resolution.path, content: serializeSharedPluginState(parseSharedPluginState(resolution.content)) };
        } catch (error) {
          throw new Error(`公共插件启用状态格式无效：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (resolution.path === FILE_AUTHORS_PATH) {
        if (resolution.content === undefined) throw new Error("文件作者归属表不能删除，请选择或编辑一个有效版本");
        try {
          return { path: resolution.path, content: serializeFileAuthorRegistry(parseFileAuthorRegistry(resolution.content)) };
        } catch (error) {
          throw new Error(`文件作者归属表格式无效：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { ...resolution };
    });

    const mergeBases: unknown = await git.findMergeBase({ fs: this.fs, dir: "", oids: [state.localOid, state.remoteOid] });
    const baseOid = Array.isArray(mergeBases) ? mergeBases.find((oid): oid is string => typeof oid === "string" && /^[0-9a-f]{40}$/i.test(oid)) : undefined;
    if (!baseOid) throw new Error("无法确定冲突的共同版本，请使用外部 Git 工具处理");
    const tracked = await Promise.all([baseOid, state.localOid, state.remoteOid].map((ref) => git.listFiles({ fs: this.fs, dir: "", ref })));
    const paths = [...new Set(tracked.flat())].sort();
    const resolutionMap = new Map(normalized.map(({ path, content }) => [path, content]));
    const mergedFiles = new Map<string, Uint8Array | undefined>();
    const branches: [string, string, string] = [baseOid, state.localOid, state.remoteOid];
    for (const path of paths) {
      const [base, local, remote] = await Promise.all(branches.map((oid) => this.readFileVersion(oid, path)));
      mergedFiles.set(path, this.mergeFileVersions(path, branches, base, local, remote, resolutionMap));
    }

    const gitignore = mergedFiles.get(".gitignore");
    const mergedSharedPluginIds = gitignore
      ? readSharedPluginIdsFromGitignore(new TextDecoder().decode(gitignore), this.configDir)
      : [];
    if (state.mode === "index-replay") {
      const changedPaths: string[] = [];
      for (const path of paths) {
        const content = mergedFiles.get(path);
        const remote = await this.readFileVersion(state.remoteOid, path);
        const unchanged = content === undefined
          ? remote === undefined
          : remote !== undefined
            && content.byteLength === remote.data.byteLength
            && content.every((value, index) => value === remote.data[index]);
        if (unchanged) continue;
        if (!isManagedPath(path, this.configDir, mergedSharedPluginIds)) {
          throw new Error(`冲突解决结果包含禁止同步路径：${path}`);
        }
        if (content === undefined) {
          if (await this.vault.exists(path)) await this.vault.remove(path);
          await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
        } else {
          const data = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
          await this.vault.write(path, data);
          await git.add({ fs: this.fs, dir: "", filepath: path });
        }
        changedPaths.push(path);
      }
      await this.clearConflictState();
      this.logger.debug("Resolved pull-first replay conflicts into the public index", {
        transactionId: state.transactionId,
        files: expected,
        changedPaths
      });
      return state.remoteOid;
    }
    const personalPluginFiles = await this.snapshotPersonalPluginFiles();
    const currentBranch = await git.currentBranch({ fs: this.fs, dir: "", fullname: false }).catch(() => undefined);
    const checkoutRef = currentBranch ?? DEFAULT_BRANCH;
    try {
      await git.checkout({ fs: this.fs, dir: "", ref: checkoutRef, force: true });
      for (const path of paths) {
        const content = mergedFiles.get(path);
        if (!isManagedPath(path, this.configDir, mergedSharedPluginIds)) {
          await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
          continue;
        }
        if (content === undefined) {
          if (await this.vault.exists(path)) await this.vault.remove(path);
          await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
          continue;
        }
        const data = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
        await this.vault.write(path, data);
        await git.add({ fs: this.fs, dir: "", filepath: path });
      }
    } catch (error) {
      await git.checkout({ fs: this.fs, dir: "", ref: checkoutRef, force: true }).catch(() => undefined);
      await this.restorePersonalPluginFiles(personalPluginFiles).catch(() => undefined);
      throw error;
    }

    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    const oid = await git.commit({
      fs: this.fs,
      dir: "",
      message: "Resolve synchronization conflicts",
      parent: [state.localOid, state.remoteOid],
      author: { name: username, email },
      committer: { name: username, email }
    });
    const commit = await git.readCommit({ fs: this.fs, dir: "", oid });
    if (commit.commit.parent[0] !== state.localOid || commit.commit.parent[1] !== state.remoteOid) {
      throw new Error("冲突解决提交未包含完整的本地和远端历史，已停止同步");
    }
    await this.restorePersonalPluginFiles(personalPluginFiles);
    await this.clearConflictState();
    this.logger.debug("Created conflict resolution commit", { oid, files: expected });
    return oid;
  }

  async conflictedFiles(): Promise<string[]> {
    const state = await this.readConflictState();
    if (!state) return [];
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (head && head !== state.localOid) {
      const includesLocal = await git.isDescendent({ fs: this.fs, dir: "", oid: head, ancestor: state.localOid }).catch(() => false);
      const includesRemote = await git.isDescendent({ fs: this.fs, dir: "", oid: head, ancestor: state.remoteOid }).catch(() => false);
      if (includesLocal && includesRemote) {
        await this.clearConflictState();
        return [];
      }
    }
    return [...state.files];
  }

  async ensureGitignore(): Promise<boolean> {
    return writeSharedPluginIds(this.vault, this.configDir, this.sharedPluginIds);
  }

  private async currentSharedPluginIds(): Promise<readonly string[]> {
    // The ignore file is the source of truth. Re-read it before staging so a
    // remote checkout or a settings change cannot leave a stale constructor
    // snapshot capable of untracking shared plugin files.
    if (await this.vault.exists(".gitignore")) return readSharedPluginIds(this.vault, this.configDir);
    return this.sharedPluginIds;
  }

  async stageManagedChanges(excludedPaths: readonly string[] | (() => readonly string[]) = []): Promise<string[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    await this.repairPrivateIndexBoundary();
    const currentExcluded = (): Set<string> => new Set(
      (typeof excludedPaths === "function" ? excludedPaths() : excludedPaths).map(normalizeVaultPath)
    );
    const matrix = await this.publicStatusMatrix();
    const changed: string[] = [];
    for (const [filepath, head, workdir, stage] of matrix) {
      if (currentExcluded().has(normalizeVaultPath(filepath))) {
        if (head !== stage) await git.resetIndex({ fs: this.fs, dir: "", filepath });
        continue;
      }
      if (isManagedPath(filepath, this.configDir, sharedPluginIds) && (head !== workdir || workdir !== stage)) {
        changed.push(filepath);
        if (workdir === 0) await git.remove({ fs: this.fs, dir: "", filepath });
        // An index-only change is already Git's authoritative desired state.
        // In particular, this preserves a staged executable-bit change instead
        // of replacing it with whatever mode the current mount exposes.
        else if (head !== workdir) await git.add({ fs: this.fs, dir: "", filepath });
      } else if (!isManagedPath(filepath, this.configDir, sharedPluginIds) && (head !== 0 || stage !== 0)) {
        // Any path outside the synchronization boundary is removed from the
        // index without deleting its local bytes. This also repairs histories
        // produced by older clients that tracked private/config/asset paths.
        changed.push(filepath);
        await git.remove({ fs: this.fs, dir: "", filepath });
      }
    }
    const excludedAfterStaging = currentExcluded();
    const included = changed.filter((filepath) => !excludedAfterStaging.has(normalizeVaultPath(filepath)));
    for (const filepath of changed) {
      if (excludedAfterStaging.has(normalizeVaultPath(filepath))) {
        await git.resetIndex({ fs: this.fs, dir: "", filepath });
      }
    }
    return this.changedIndexPaths(included);
  }

  /**
   * Stages an event-derived batch without asking isomorphic-git to walk the
   * entire worktree. This is the normal synchronization path; the full public
   * recovery scan above is retained only for explicit recovery boundaries.
   */
  async stageManagedPaths(paths: readonly string[], excludedPaths: readonly string[] | (() => readonly string[]) = []): Promise<string[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    await this.repairPrivateIndexBoundary();
    const excluded = new Set((typeof excludedPaths === "function" ? excludedPaths() : excludedPaths).map(normalizeVaultPath));
    const candidates = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].filter((path) => !isPrivatePath(path));
    const statusByPath = new Map((await this.publicStatusMatrix(candidates))
      .map((entry) => [normalizeVaultPath(entry[0]), entry]));
    for (const path of candidates) {
      if (excluded.has(path)) {
        await git.resetIndex({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
      } else if (isManagedPath(path, this.configDir, sharedPluginIds)) {
        const status = statusByPath.get(path);
        if (status && status[1] === status[2]) continue;
        if (await this.vault.exists(path)) await git.add({ fs: this.fs, dir: "", filepath: path });
        else await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
      } else {
        await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
      }
    }
    return this.changedIndexPaths(candidates.filter((path) => !excluded.has(path)));
  }

  /** Stage one public Vault event immediately; this is the durable public-change journal. */
  async stageManagedEventPath(path: string): Promise<void> {
    const filepath = normalizeVaultPath(path);
    if (!filepath || isPrivatePath(filepath)) return;
    const sharedPluginIds = await this.currentSharedPluginIds();
    if (!isManagedPath(filepath, this.configDir, sharedPluginIds)) return;
    if (await this.vault.exists(filepath)) await git.add({ fs: this.fs, dir: "", filepath });
    else await git.remove({ fs: this.fs, dir: "", filepath }).catch(() => undefined);
  }

  /**
   * Reconcile only the explicitly shared plugin folders with the index.
   *
   * Community plugins commonly write their own data.json through an adapter
   * or native module, bypassing Obsidian's Vault events.  Their files are
   * nevertheless part of the public boundary when the plugin is whitelisted.
   * This narrow scan is the recovery boundary for those direct writes; it does
   * not inspect notes, assets, private notes, personal plugins, or Team Core's
   * own local configuration.
   */
  async stageSharedPluginWorktreeChanges(): Promise<string[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    // Known index/HEAD paths are consulted only after a change is detected,
    // so a deleted config file can be removed from the index too.
    const candidates = await this.sharedPluginWorktreePaths(sharedPluginIds, true);
    if (!candidates.length) return [];
    // Do not use statusMatrix here. Some adapters can report a same-size
    // direct rewrite with unchanged/coarse mtime, which makes Git's stat
    // shortcut miss the new bytes. This intentionally asks Git to recalculate
    // blobs for the bounded whitelist only.
    for (const path of candidates) {
      if (await this.vault.exists(path)) await git.add({ fs: this.fs, dir: "", filepath: path });
      else await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
    }
    return this.changedIndexPaths(candidates);
  }

  /** Cheap directory fingerprint for background shared-plugin polling. */
  async sharedPluginWorktreeFingerprint(): Promise<string> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const candidates = await this.sharedPluginWorktreePaths(sharedPluginIds);
    const parts: string[] = [];
    for (const path of candidates) {
      const stat = await this.vault.stat(path);
      parts.push(`${path}\u0000${stat?.type ?? "missing"}\u0000${stat?.size ?? -1}\u0000${stat?.mtime ?? -1}`);
    }
    return parts.join("\u0001");
  }

  private async sharedPluginWorktreePaths(sharedPluginIds: readonly string[], includeKnownGitPaths = false): Promise<string[]> {
    const config = normalizeVaultPath(this.configDir);
    const roots = sharedPluginIds.map((id) => `${config}/plugins/${id}`);
    if (!roots.length) return [];
    const candidates = new Set<string>();
    const collectKnownPaths = (paths: readonly string[]): void => {
      for (const rawPath of paths) {
        const path = normalizeVaultPath(rawPath);
        if (isSharedPluginPath(path, this.configDir, sharedPluginIds)) candidates.add(path);
      }
    };
    if (includeKnownGitPaths) {
      collectKnownPaths(await git.listFiles({ fs: this.fs, dir: "" }).catch(() => [] as string[]));
      collectKnownPaths(await git.listFiles({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => [] as string[]));
    }
    const collectWorktreePaths = async (folder: string): Promise<void> => {
      const entries = await this.vault.list(folder).catch(() => undefined);
      if (!entries) return;
      collectKnownPaths(entries.files);
      await Promise.all(entries.folders.map((child) => collectWorktreePaths(normalizeVaultPath(child))));
    };
    await Promise.all(roots.map((root) => collectWorktreePaths(root)));
    return [...candidates].sort();
  }

  /** Lists public changes in HEAD ↔ index only, without traversing the Vault. */
  async listPublicStagedChanges(): Promise<PublicWorktreeChange[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const changes = await walk({
      fs: this.fs,
      dir: "",
      trees: [TREE({ ref: "HEAD" }), STAGE()],
      map: async (path, [head, stage]) => {
        if (path === ".") return undefined;
        const entry = head ?? stage;
        if (!entry) return undefined;
        if (await entry.type() === "tree") return isPrivatePath(normalizeVaultPath(path)) ? null : undefined;
        if (!isManagedPath(path, this.configDir, sharedPluginIds)) return undefined;
        if (head && stage && await head.oid() === await stage.oid() && await head.mode() === await stage.mode()) return undefined;
        return {
          path: normalizeVaultPath(path),
          status: !stage ? "deleted" : !head ? "added" : "modified"
        } satisfies PublicWorktreeChange;
      }
    }) as PublicWorktreeChange[];
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  async hasStagedPublicChanges(): Promise<boolean> {
    return (await this.listPublicStagedChanges()).length > 0;
  }

  /**
   * Checks whether a fetched remote can be merged while the current public
   * index is temporarily checkpointed. Same-path changes are allowed because
   * the checkpoint is replayed with a real three-way merge; only unstaged
   * worktree drift is rejected because it is not represented by the index.
   */
  async assessPullFirstStash(): Promise<PullFirstStashAssessment> {
    const local = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    const remote = await git.resolveRef({ fs: this.fs, dir: "", ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }).catch(() => undefined);
    if (!local || !remote || local === remote) return { remoteChanged: false, canStash: false };
    const remotePaths = await this.changedTreePaths(local, remote);
    if (!remotePaths.length) return { remoteChanged: false, canStash: false };
    const staged = await this.listPublicStagedChanges();
    if (!staged.length) return { remoteChanged: true, canStash: false, reason: "没有本地公共修改" };
    const fastForward = await git.isDescendent({ fs: this.fs, dir: "", oid: remote, ancestor: local }).catch(() => false);
    if (!fastForward) {
      return { remoteChanged: true, canStash: false, reason: "本地与远端已产生提交分叉，先沿用现有提交级冲突流程" };
    }
    if (await this.hasUnstagedPublicChanges()) {
      return { remoteChanged: true, canStash: false, reason: "存在尚未进入 Git 暂存区的公共修改" };
    }
    return { remoteChanged: true, canStash: true };
  }

  /** Paths a fetched remote would materialize into the managed worktree. */
  async remoteChangedPaths(): Promise<string[]> {
    const local = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    const remote = await git.resolveRef({ fs: this.fs, dir: "", ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }).catch(() => undefined);
    if (!local || !remote || local === remote) return [];
    return this.changedTreePaths(local, remote);
  }

  /** Create a single-use Team Core checkpoint without touching refs/stash or its reflog. */
  async createTeamCoreStash(transactionId: string): Promise<string> {
    if (!/^[a-f0-9]{24}$/i.test(transactionId)) throw new Error("同步暂存事务标识无效");
    // isomorphic-git's stash implementation reads identity from .git/config
    // (unlike our normal commit wrapper, which passes it per call). We use
    // `create` only: push/apply rely on a reflog path that is not portable
    // across Obsidian's filesystem adapters.
    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    await git.setConfig({ fs: this.fs, dir: "", path: "user.name", value: username });
    await git.setConfig({ fs: this.fs, dir: "", path: "user.email", value: email });
    const oid = await git.stash({ fs: this.fs, dir: "", op: "create", message: `Team Core sync ${transactionId}` });
    if (typeof oid !== "string" || !/^[a-f0-9]{40}$/i.test(oid)) throw new Error("创建同步暂存失败，未生成有效的 Git 快照");
    await git.writeRef({ fs: this.fs, dir: "", ref: this.teamCoreStashRef(transactionId), value: oid, force: true });
    const base = await this.stashBaseOid(oid);
    const paths = await this.changedTreePaths(base, oid);
    await this.materializeIndexTreePaths(base, paths, oid);
    const verified = await this.findTeamCoreStash(transactionId, oid);
    if (!verified) throw new Error("创建同步暂存后无法验证临时引用，已停止继续同步");
    return verified;
  }

  async findTeamCoreStash(transactionId: string, expectedOid?: string): Promise<string | undefined> {
    const oid = await git.resolveRef({ fs: this.fs, dir: "", ref: this.teamCoreStashRef(transactionId) }).catch(() => undefined);
    if (!oid || (expectedOid && oid !== expectedOid)) return undefined;
    const commit = await git.readCommit({ fs: this.fs, dir: "", oid }).catch(() => undefined);
    const message = commit?.commit.message ?? "";
    return message.startsWith(`Team Core sync ${transactionId}:`) ? oid : undefined;
  }

  /**
   * A recovery probe for the narrow interruption window after stash apply.
   * The transaction is considered restored only if all paths contained by the
   * stash have reached its final index tree; partial application stays
   * recoverable and is never applied a second time automatically.
   */
  async isTeamCoreStashRestored(stashOid: string): Promise<boolean> {
    const stash = await git.readCommit({ fs: this.fs, dir: "", oid: stashOid });
    const baseOid = stash.commit.parent?.[0];
    if (!baseOid) return false;
    const paths = await this.changedTreePaths(baseOid, stashOid);
    return Promise.all(paths.map((path) => this.indexMatchesTreePath(stashOid, path))).then((values) => values.every(Boolean));
  }

  async teamCoreStashPaths(stashOid: string): Promise<string[]> {
    return this.changedTreePaths(await this.stashBaseOid(stashOid), stashOid);
  }

  /**
   * Merge the local checkpoint commit into the already-integrated remote HEAD
   * without moving the current branch. The returned commit is only a durable
   * carrier for the resulting tree; it is never pushed as repository history.
   */
  async planTeamCoreStashReplay(transactionId: string, stashOid: string): Promise<TeamCoreReplayPlan> {
    if (!(await this.findTeamCoreStash(transactionId, stashOid))) {
      throw new Error("同步暂存已改变或不属于 Team Core，拒绝执行三方恢复");
    }
    const remoteOid = await this.headOid();
    if (!remoteOid) throw new Error("无法读取远端合并后的本地 HEAD");
    const currentBranch = await git.currentBranch({ fs: this.fs, dir: "", fullname: false }).catch(() => undefined);
    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    try {
      const result = await git.merge({
        fs: this.fs,
        dir: "",
        ours: currentBranch ? `refs/heads/${currentBranch}` : "HEAD",
        theirs: this.teamCoreStashRef(transactionId),
        fastForward: false,
        noUpdateBranch: true,
        abortOnConflict: true,
        message: `Team Core replay ${transactionId}`,
        author: { name: username, email },
        committer: { name: username, email },
        mergeDriver: (params) => teamCoreMergeDriver(params, this.configDir)
      });
      const mergedOid = result.oid ?? (result.alreadyMerged ? remoteOid : undefined);
      if (!mergedOid) throw new Error("三方合并未生成可恢复的结果快照");
      await this.validateManagedTree(mergedOid);
      return { remoteOid, mergedOid, conflicts: [] };
    } catch (error) {
      const conflicts = conflictFilesFromError(error);
      if (!conflicts.length) throw error;
      await this.writeConflictState({
        version: 1,
        localOid: stashOid,
        remoteOid,
        headOid: remoteOid,
        mode: "index-replay",
        transactionId,
        files: conflicts,
        detectedAt: new Date().toISOString()
      });
      this.logger.warn("Pull-first checkpoint replay requires conflict resolution", { transactionId, files: conflicts });
      return { remoteOid, conflicts };
    }
  }

  /** Idempotently materialize a planned three-way tree as HEAD ↔ index changes. */
  async applyTeamCoreMergedSnapshot(mergedOid: string): Promise<string[]> {
    const head = await this.headOid();
    if (!head) throw new Error("无法读取当前 HEAD，拒绝恢复三方合并结果");
    await this.validateManagedTree(mergedOid);
    const paths = await this.changedTreePaths(head, mergedOid);
    await this.materializeIndexTreePaths(mergedOid, paths, head);
    const complete = await Promise.all(paths.map((path) => this.indexMatchesTreePath(mergedOid, path)));
    if (!complete.every(Boolean)) throw new Error("三方合并结果只恢复了一部分文件，已保留事务以便重新恢复");
    return paths;
  }

  async isTeamCoreMergedSnapshotApplied(mergedOid: string): Promise<boolean> {
    const head = await this.headOid();
    if (!head) return false;
    const paths = await this.changedTreePaths(head, mergedOid);
    return Promise.all(paths.map((path) => this.indexMatchesTreePath(mergedOid, path))).then((values) => values.every(Boolean));
  }

  async applyTeamCoreStash(transactionId: string, stashOid: string): Promise<void> {
    if (!(await this.findTeamCoreStash(transactionId, stashOid))) {
      throw new Error("同步暂存已改变或不属于 Team Core，已停止恢复以保护本地修改");
    }
    const base = await this.stashBaseOid(stashOid);
    const paths = await this.changedTreePaths(base, stashOid);
    await this.materializeIndexTreePaths(stashOid, paths, base);
    if (!await this.isTeamCoreStashRestored(stashOid)) {
      throw new Error("同步暂存只恢复了一部分文件，已保留恢复点；请使用冲突编辑器或重新启动插件继续处理");
    }
  }

  async dropTeamCoreStash(transactionId: string, stashOid: string): Promise<void> {
    if (!(await this.findTeamCoreStash(transactionId, stashOid))) {
      throw new Error("同步暂存已改变或不属于 Team Core，拒绝删除");
    }
    await git.deleteRef({ fs: this.fs, dir: "", ref: this.teamCoreStashRef(transactionId) });
  }

  /** Commit the existing managed index delta without re-reading the worktree. */
  /**
   * Build the message from the repaired, final index when the caller wants to
   * describe a file count. Event queues are only scheduling hints and can be
   * coalesced, rewritten, or eliminated by a remote replay.
   */
  async commitStaged(message: string | ((changes: readonly PublicWorktreeChange[]) => string)): Promise<string | undefined> {
    await this.repairIndexBoundary();
    const changed = await this.listPublicStagedChanges();
    if (!changed.length) return undefined;
    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    const resolvedMessage = typeof message === "function" ? message(changed) : message;
    const oid = await git.commit({ fs: this.fs, dir: "", message: resolvedMessage, author: { name: username, email }, committer: { name: username, email } });
    this.logger.debug("Created Git commit from staged public changes", { oid, files: changed.map((change) => change.path) });
    return oid;
  }

  async commit(message: string, excludedPaths: readonly string[] | (() => readonly string[]) = [], paths?: readonly string[]): Promise<string | undefined> {
    const changed = paths ? await this.stageManagedPaths(paths, excludedPaths) : await this.stageManagedChanges(excludedPaths);
    if (!changed.length) return undefined;
    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    const oid = await git.commit({ fs: this.fs, dir: "", message, author: { name: username, email }, committer: { name: username, email } });
    this.logger.debug("Created Git commit", { oid, files: changed });
    return oid;
  }

  async fetch(): Promise<void> {
    const startedAt = Date.now();
    await this.ensureRemote();
    const preparedAt = Date.now();
    const remoteRef = `refs/remotes/origin/${DEFAULT_BRANCH}`;
    const before = await git.resolveRef({ fs: this.fs, dir: "", ref: remoteRef }).catch(() => undefined);
    let lastProgress: Pick<GitProgressEvent, "phase" | "loaded" | "total"> | undefined;
    await git.fetch({
      ...(await this.gitOptions()),
      remote: "origin",
      ref: DEFAULT_BRANCH,
      singleBranch: true,
      prune: false,
      onProgress: (event) => { lastProgress = { phase: event.phase, loaded: event.loaded, total: event.total }; }
    });
    const after = await git.resolveRef({ fs: this.fs, dir: "", ref: remoteRef }).catch(() => undefined);
    this.logger.debug("Git fetch completed", {
      durationMs: Date.now() - startedAt,
      repositoryPreparationMs: preparedAt - startedAt,
      transferAndPackProcessingMs: Date.now() - preparedAt,
      remoteRefChanged: before !== after,
      ...(lastProgress ? { progress: lastProgress } : {})
    });
  }

  async mergeRemote(): Promise<{ merged: boolean; conflicts: string[] }> {
    const pendingConflicts = await this.conflictedFiles();
    if (pendingConflicts.length) return { merged: false, conflicts: pendingConflicts };
    const remote = await git.resolveRef({ fs: this.fs, dir: "", ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }).catch(() => undefined);
    const local = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!remote || !local || remote === local) return { merged: false, conflicts: [] };
    await this.validateRemoteMergeBoundary(local, remote);
    const currentBranch = await git.currentBranch({ fs: this.fs, dir: "", fullname: false }).catch(() => undefined);
    try {
      const username = this.settings.gitUsername.trim() || "unknown";
      const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
      const result = await git.merge({
        fs: this.fs,
        dir: "",
        // Pass the branch ref, not its current OID, so isomorphic-git updates
        // the branch pointer after creating a merge commit.
        ours: currentBranch ? `refs/heads/${currentBranch}` : undefined,
        theirs: `refs/remotes/origin/${DEFAULT_BRANCH}`,
        fastForward: true,
        message: "Merge remote changes",
        author: { name: username, email },
        committer: { name: username, email },
        mergeDriver: (params) => teamCoreMergeDriver(params, this.configDir)
      });
      const conflicts = (result as { conflictedFiles?: string[] }).conflictedFiles ?? [];
      if (!conflicts.length && !result.alreadyMerged) {
        // merge() updates the index/tree but does not materialize a clean
        // merge into the working tree. Do not use checkout: even a path-
        // limited checkout analyzes the root worktree and visits ignored
        // private notes. Materialize changed Git-tree files directly.
        const merged = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" });
        await this.materializeMergedWorktree(local, merged);
      }
      await this.clearConflictState();
      return { merged: true, conflicts };
    } catch (error) {
      const conflicts = conflictFilesFromError(error);
      if (conflicts.length) {
        await this.writeConflictState({ version: 1, localOid: local, remoteOid: remote, files: conflicts, detectedAt: new Date().toISOString() });
        this.logger.warn("Git merge blocked by conflicts", { files: conflicts });
        return { merged: false, conflicts };
      }
      throw error;
    }
  }

  private async materializeMergedWorktree(before: string, after: string): Promise<void> {
    const changed = await this.changedTreePaths(before, after);
    // The whitelist is itself shared. Apply it before materializing changed
    // plugin paths so a newly shared plugin is recognized in this same merge.
    if (changed.includes(".gitignore")) {
      await this.writeTreeFile(after, ".gitignore");
      await git.add({ fs: this.fs, dir: "", filepath: ".gitignore" });
    }
    const sharedPluginIds = await this.currentSharedPluginIds();
    for (const path of changed) {
      if (path === ".gitignore" || !isManagedPath(path, this.configDir, sharedPluginIds)) continue;
      const existsAfterMerge = await git.readBlob({ fs: this.fs, dir: "", oid: after, filepath: path }).then(() => true).catch(() => false);
      if (existsAfterMerge) {
        await this.writeTreeFile(after, path);
        await git.add({ fs: this.fs, dir: "", filepath: path });
      } else if (await this.vault.exists(path)) {
        await this.vault.remove(path);
        await git.remove({ fs: this.fs, dir: "", filepath: path });
      }
    }
  }

  /** Walk only differing Git trees; equal directory OIDs prune whole subtrees. */
  private async changedTreePaths(before: string, after: string): Promise<string[]> {
    const changed = (await walk({
      fs: this.fs,
      dir: "",
      trees: [TREE({ ref: before }), TREE({ ref: after })],
      map: async (path, [previous, current]) => {
        const entry = previous ?? current;
        if (!entry) return undefined;
        if (await entry.type() === "tree") {
          if (previous && current && await previous.oid() === await current.oid()) return null;
          return undefined;
        }
        return previous && current && await previous.oid() === await current.oid() && await previous.mode() === await current.mode()
          ? undefined
          : normalizeVaultPath(path);
      }
    }) as string[] | undefined) ?? [];
    return changed.map(normalizeVaultPath).sort();
  }

  private async indexMatchesTreePath(treeOid: string, targetPath: string): Promise<boolean> {
    let matches = false;
    await walk({
      fs: this.fs,
      dir: "",
      trees: [STAGE(), TREE({ ref: treeOid })],
      map: async (path, [stage, tree]) => {
        if (normalizeVaultPath(path) !== normalizeVaultPath(targetPath)) return undefined;
        if (!stage || !tree) {
          matches = !stage && !tree;
          return undefined;
        }
        matches = await stage.oid() === await tree.oid() && await stage.mode() === await tree.mode();
        return undefined;
      }
    });
    return matches;
  }

  private teamCoreStashRef(transactionId: string): string {
    return `refs/team-core/sync/${transactionId}`;
  }

  private async stashBaseOid(stashOid: string): Promise<string> {
    const stash = await git.readCommit({ fs: this.fs, dir: "", oid: stashOid });
    const base = stash.commit.parent?.[0];
    if (!base) throw new Error("同步暂存缺少基线提交，无法安全恢复");
    return base;
  }

  /**
   * Materialize only paths allowed by the source/target Git trees and set
   * their exact index entries. The whitelist itself can change in the same
   * replay, so worktree-derived plugin IDs are not authoritative here.
   */
  private async materializeIndexTreePaths(treeOid: string, paths: readonly string[], sourceTreeOid?: string): Promise<void> {
    const targetTree = await this.validateManagedTree(treeOid);
    const sourceTree = sourceTreeOid ? await this.validateManagedTree(sourceTreeOid) : undefined;
    const tracked = new Set(targetTree.files);
    for (const path of [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].sort()) {
      const targetManaged = isManagedPath(path, this.configDir, targetTree.sharedPluginIds);
      const sourceManaged = sourceTree
        ? isManagedPath(path, this.configDir, sourceTree.sharedPluginIds)
        : false;
      if (tracked.has(path) ? !targetManaged : !targetManaged && !sourceManaged) {
        throw new Error(`同步暂存包含禁止同步路径：${path}`);
      }
      if (tracked.has(path)) {
        await this.writeTreeFile(treeOid, path);
        await git.resetIndex({ fs: this.fs, dir: "", filepath: path, ref: treeOid });
      } else {
        if (await this.vault.exists(path)) await this.vault.remove(path);
        await git.remove({ fs: this.fs, dir: "", filepath: path }).catch(() => undefined);
      }
    }
  }

  private async hasUnstagedPublicChanges(): Promise<boolean> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const matrix = await this.publicStatusMatrix();
    return matrix.some(([path, _head, workdir, stage]) => (
      isManagedPath(path, this.configDir, sharedPluginIds) && workdir !== stage
    ));
  }

  /**
   * A normal remote merge validates only the changed tree paths. Changing the
   * shared-plugin whitelist changes the path policy itself, so it deliberately
   * falls back to the full remote-tree validation boundary.
   */
  private async validateRemoteMergeBoundary(local: string, remote: string): Promise<void> {
    const changed = await this.changedTreePaths(local, remote);
    if (changed.includes(".gitignore")) {
      await this.validateManagedTree(remote);
      return;
    }
    const sharedPluginIds = await this.currentSharedPluginIds();
    const forbidden = changed.filter((path) => !isManagedPath(path, this.configDir, sharedPluginIds));
    if (!forbidden.length) return;
    const preview = forbidden.slice(0, 5).join(", ");
    const remaining = forbidden.length > 5 ? ` 等 ${forbidden.length} 个文件` : "";
    throw new Error(`远端仓库包含禁止同步路径，已拒绝写入本地：${preview}${remaining}`);
  }

  private async writeTreeFile(oid: string, path: string): Promise<void> {
    const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid, filepath: path });
    const data = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
    await this.vault.write(path, data);
  }

  private async snapshotPersonalPluginFiles(): Promise<Map<string, ArrayBuffer>> {
    const snapshot = new Map<string, ArrayBuffer>();
    const config = normalizeVaultPath(this.configDir);
    if (!config) return snapshot;
    const configPrefix = `${config}/plugins/`;
    const walk = async (path: string): Promise<void> => {
      const entries = await this.vault.list(path);
      for (const file of entries.files) {
        const normalized = normalizeVaultPath(file);
        const id = pluginIdFromPath(normalized, this.configDir);
        if (id && id !== "team-core") snapshot.set(normalized, await this.vault.read(normalized));
      }
      for (const folder of entries.folders) await walk(normalizeVaultPath(folder));
    };
    if (configPrefix !== "/" && await this.vault.exists(configPrefix.replace(/\/$/, ""))) await walk(configPrefix.replace(/\/$/, ""));
    return snapshot;
  }

  private async restorePersonalPluginFiles(snapshot: ReadonlyMap<string, ArrayBuffer>): Promise<void> {
    if (!snapshot.size) return;
    const currentIds = await readSharedPluginIds(this.vault, this.configDir);
    for (const [path, data] of snapshot) {
      const id = pluginIdFromPath(path, this.configDir);
      if (id && id !== "team-core" && !currentIds.includes(id)) await this.vault.write(path, data);
    }
  }

  private async restoreAllPluginFiles(snapshot: ReadonlyMap<string, ArrayBuffer>): Promise<void> {
    for (const [path, data] of snapshot) await this.vault.write(path, data);
  }

  private async materializeSharedPluginFiles(): Promise<void> {
    const sharedPluginIds = await readSharedPluginIds(this.vault, this.configDir);
    const head = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!head) return;
    const files = await git.listFiles({ fs: this.fs, dir: "", ref: head });
    for (const path of files) {
      if (!isSharedPluginPath(path, this.configDir, sharedPluginIds)) continue;
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid: head, filepath: path });
      const data = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
      const current = await this.vault.read(path).catch(() => undefined);
      if (current && current.byteLength === data.byteLength) {
        const expected = new Uint8Array(data);
        const actual = new Uint8Array(current);
        if (expected.every((value, index) => value === actual[index])) continue;
      }
      await this.vault.write(path, data);
    }
  }

  async push(): Promise<void> {
    await this.ensureRemote();
    await git.push({ ...(await this.gitOptions()), remote: "origin", ref: DEFAULT_BRANCH, onAuth: this.auth() ? () => this.auth() : undefined });
  }

  async deleteRemoteBranch(remoteOid: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/i.test(remoteOid)) throw new Error("远端 main 引用无效，拒绝删除");
    if (!(await this.exists())) await this.init();
    await this.ensureRemote();
    const resetRef = "refs/team-core/reset-main";
    await git.writeRef({ fs: this.fs, dir: "", ref: resetRef, value: remoteOid, force: true });
    try {
      await git.push({
        ...(await this.gitOptions()),
        remote: "origin",
        ref: resetRef,
        remoteRef: `refs/heads/${DEFAULT_BRANCH}`,
        delete: true,
        onAuth: this.auth() ? () => this.auth() : undefined
      });
    } finally {
      await git.deleteRef({ fs: this.fs, dir: "", ref: resetRef }).catch(() => undefined);
    }
  }

  async log(filepath?: string, depth?: number, since?: number): Promise<CommitSummary[]> {
    // Private notes are intentionally outside Git. The active editor can be
    // private immediately after a successful sync, so never ask
    // isomorphic-git to traverse history for one.
    if (filepath && isPrivatePath(filepath)) return [];
    const entries = await git.log({
      fs: this.fs,
      dir: "",
      filepath,
      ...(since === undefined ? { depth: depth ?? 200 } : { since: new Date(since) })
    });
    return entries.map((entry) => ({
      oid: entry.oid,
      shortOid: entry.oid.slice(0, 7),
      parents: [...entry.commit.parent],
      message: entry.commit.message.trim(),
      author: entry.commit.author.name,
      email: entry.commit.author.email,
      timestamp: entry.commit.author.timestamp * 1000
    }));
  }

  async logSince(since: number, filepath?: string): Promise<CommitSummary[]> {
    return this.log(filepath, undefined, since);
  }

  /**
   * Computes the visible change categories only when a history row is opened.
   * This keeps the initial history page bounded even for a long-lived vault.
   */
  async commitChanges(oid: string): Promise<CommitChangeDetails> {
    const commit = await git.readCommit({ fs: this.fs, dir: "", oid });
    const parent = commit.commit.parent[0] ?? EMPTY_TREE_OID;
    const changedPaths = (await walk({
      fs: this.fs,
      dir: "",
      trees: [TREE({ ref: oid }), TREE({ ref: parent })],
      cache: {},
      map: async (filepath, [current, previous]) => {
        const entry = current ?? previous;
        if (!entry || await entry.type() === "tree") return undefined;
        const currentOid = current ? await current.oid() : undefined;
        const previousOid = previous ? await previous.oid() : undefined;
        return currentOid === previousOid ? undefined : normalizeVaultPath(filepath);
      }
    }) as string[]).sort();

    const configPrefix = `${normalizeVaultPath(this.configDir)}/`;
    const markdownPaths = changedPaths.filter((path) => path.endsWith(".md")
      && !path.startsWith(configPrefix)
      && !path.startsWith(".team/")
      && !isPrivatePath(path));
    const documentTexts = new Map<string, string>();
    const documentChanges = await Promise.all(markdownPaths.map(async (path): Promise<CommitDocumentChange> => {
      const current = await this.readBlobText(oid, path);
      const previous = await this.readBlobText(parent, path);
      const text = current ?? previous;
      if (text !== undefined) documentTexts.set(path, text);
      return {
        path,
        status: current === undefined ? "deleted" : previous === undefined ? "added" : "modified",
        ...(previous === undefined ? {} : { previousLineCount: countTextLines(previous) }),
        ...(current === undefined ? {} : { currentLineCount: countTextLines(current) })
      };
    }));
    const pluginIds = [...new Set(changedPaths.map((path) => pluginIdFromPath(path, this.configDir)).filter((id): id is string => Boolean(id)))].sort();
    const pluginChanges = await Promise.all(pluginIds.map((id) => this.pluginChangeAtCommit(id, oid, parent, changedPaths)));
    const pluginNames = pluginChanges.map((change) => change.name);
    const changedAssetPaths = new Set<string>(changedPaths.filter(isAssetPath));
    if (changedPaths.includes(MANIFEST_PATH)) {
      for (const path of await this.changedManifestAssetPaths(oid, parent)) changedAssetPaths.add(path);
    }

    const attachmentDocumentPaths: string[] = [];
    if (changedAssetPaths.size) {
      for (const path of markdownPaths) {
        const text = documentTexts.get(path);
        if (text !== undefined && collectMarkdownReferences(text, path).some((reference) => changedAssetPaths.has(reference))) {
          attachmentDocumentPaths.push(path);
        }
      }
    }

    const pluginPaths = new Set(changedPaths.filter((path) => pluginIdFromPath(path, this.configDir) !== undefined));
    const knownPaths = new Set([
      ...markdownPaths,
      ...pluginPaths,
      ...changedAssetPaths,
      MANIFEST_PATH,
      SHARED_PLUGIN_STATE_PATH,
      FILE_AUTHORS_PATH,
      ".gitignore"
    ]);
    return {
      markdownPaths,
      documentChanges,
      pluginNames,
      pluginChanges,
      attachmentDocumentPaths,
      hasUnassociatedAttachmentChanges: changedAssetPaths.size > 0 && attachmentDocumentPaths.length === 0,
      sharedPluginStateChanged: changedPaths.includes(SHARED_PLUGIN_STATE_PATH),
      fileAuthorsChanged: changedPaths.includes(FILE_AUTHORS_PATH),
      sharedPluginRulesChanged: changedPaths.includes(".gitignore"),
      hasOtherChanges: changedPaths.some((path) => !knownPaths.has(path))
    };
  }

  private async readBlobText(oid: string, filepath: string): Promise<string | undefined> {
    try {
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid, filepath });
      return new TextDecoder("utf-8", { fatal: true }).decode(blob);
    } catch {
      return undefined;
    }
  }

  private async changedManifestAssetPaths(oid: string, parent: string): Promise<string[]> {
    const current = await this.readBlobText(oid, MANIFEST_PATH);
    const previous = await this.readBlobText(parent, MANIFEST_PATH);
    const currentManifest = current ? parseManifestContent(current) : undefined;
    const previousManifest = previous ? parseManifestContent(previous) : undefined;
    if (!currentManifest && !previousManifest) return [];
    const currentFiles = currentManifest?.files ?? {};
    const previousFiles = previousManifest?.files ?? {};
    return [...new Set([...Object.keys(currentFiles), ...Object.keys(previousFiles)])]
      .filter((path) => JSON.stringify(currentFiles[path]) !== JSON.stringify(previousFiles[path]))
      .sort();
  }

  private async pluginChangeAtCommit(id: string, oid: string, parent: string, changedPaths: readonly string[]): Promise<CommitPluginChange> {
    const manifestPath = `${normalizeVaultPath(this.configDir)}/plugins/${id}/manifest.json`;
    let name = id;
    let version: string | undefined;
    for (const ref of [oid, parent]) {
      const text = await this.readBlobText(ref, manifestPath);
      if (!text) continue;
      try {
        const manifest = JSON.parse(text) as { name?: unknown; version?: unknown };
        if (typeof manifest.name === "string" && manifest.name.trim()) name = manifest.name.trim();
        if (typeof manifest.version === "string" && manifest.version.trim()) version = manifest.version.trim();
        break;
      } catch {
        // Deleted or malformed plugin metadata falls back to its stable ID.
      }
    }
    return {
      name,
      ...(version ? { version } : {}),
      changedFileCount: changedPaths.filter((path) => pluginIdFromPath(path, this.configDir) === id).length
    };
  }

  async fileAuthors(filepath: string): Promise<string[]> {
    if (isPrivatePath(filepath)) return [];
    const entries = await git.log({ fs: this.fs, dir: "", filepath }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "NotFoundError") return [];
      throw error;
    });
    const authors = new Set<string>();
    for (const entry of entries.reverse()) {
      // A merge records who integrated histories, not necessarily who wrote
      // each path inherited from a parent. Retain it only if the resulting
      // blob differs from every parent: that is a genuine conflict-resolution
      // or manual merge edit by the merger.
      if (entry.commit.parent.length > 1
        && !await this.mergeIntroducesPathContent(entry.oid, entry.commit.parent, filepath)) continue;
      const author = entry.commit.author.name.trim();
      if (author) authors.add(author);
    }
    return [...authors];
  }

  /** Expensive maintenance query: collect every attachment object referenced by Git history. */
  async historicalAttachmentObjects(): Promise<Set<string>> {
    const referenced = new Set<string>();
    const commits = await git.log({ fs: this.fs, dir: "" });
    for (const commit of commits) {
      const text = await this.readBlobText(commit.oid, MANIFEST_PATH);
      if (!text) continue;
      try {
        const manifest = validateManifest(JSON.parse(text));
        for (const entry of Object.values(manifest.files)) referenced.add(`${entry.sha256}:${entry.size}`);
      } catch {
        // Invalid historical manifests are not a reason to delete an object.
        return new Set([...referenced, "*"]);
      }
    }
    return referenced;
  }

  async fileAuthorsIndex(onProgress?: (current: number, total: number) => void): Promise<Map<string, string[]>> {
    const commits = await git.log({ fs: this.fs, dir: "" });
    const authorsByPath = new Map<string, Set<string>>();
    const cache = {};
    const configDirectory = normalizeVaultPath(this.configDir);
    for (const [index, entry] of commits.entries()) {
      const author = entry.commit.author.name.trim();
      if (author) {
        const changed = await walk({
          fs: this.fs,
          dir: "",
          trees: [TREE({ ref: entry.oid }), ...entry.commit.parent.map((oid) => TREE({ ref: oid }))],
          cache,
          map: async (filepath, [current, ...parents]) => {
            const treeEntry = current ?? parents.find(Boolean);
            if (!treeEntry) return undefined;
            if (await treeEntry.type() === "tree") {
              return filepath === "assets" || filepath === configDirectory || filepath === "私人笔记" || filepath === ".trash" ? null : undefined;
            }
            if (!filepath.endsWith(".md") || filepath.startsWith(".team/")) return undefined;
            const currentOid = current ? await current.oid() : undefined;
            const parentOids = await Promise.all(parents.map(async (candidate) => candidate ? candidate.oid() : undefined));
            if (entry.commit.parent.length > 1) {
              // The path was inherited unchanged from at least one parent:
              // this merge did not author it. A new blob relative to every
              // parent is a deliberate merge-resolution contribution.
              return currentOid && !parentOids.includes(currentOid) ? filepath : undefined;
            }
            return currentOid === parentOids[0] ? undefined : filepath;
          }
        }) as string[];
        for (const path of changed) {
          const authors = authorsByPath.get(path) ?? new Set<string>();
          authors.add(author);
          authorsByPath.set(path, authors);
        }
      }
      onProgress?.(index + 1, commits.length);
    }
    return new Map([...authorsByPath.entries()].map(([path, authors]) => [path, [...authors]]));
  }

  private async mergeIntroducesPathContent(oid: string, parents: readonly string[], filepath: string): Promise<boolean> {
    const current = await git.readBlob({ fs: this.fs, dir: "", oid, filepath }).then((result) => result.oid).catch(() => undefined);
    if (!current) return false;
    const parentOids = await Promise.all(parents.map((parent) => (
      git.readBlob({ fs: this.fs, dir: "", oid: parent, filepath }).then((result) => result.oid).catch(() => undefined)
    )));
    return !parentOids.includes(current);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const matrix = await this.publicStatusMatrix();
    return matrix.some(([filepath, head, workdir, stage]) => {
      if (isManagedPath(filepath, this.configDir, sharedPluginIds)) return head !== workdir || workdir !== stage;
      return head !== 0 || stage !== 0;
    });
  }

  /**
   * Fast, event-scoped Git check for the status bar. This reads only the
   * supplied paths and never stages, rewrites the index, or contacts remote.
   */
  async hasManagedPathChanges(paths: readonly string[]): Promise<boolean> {
    const candidates = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))].filter((path) => !isPrivatePath(path));
    if (!candidates.length) return false;
    const sharedPluginIds = await this.currentSharedPluginIds();
    const matrix = await this.publicStatusMatrix(candidates);
    return matrix.some(([filepath, head, workdir, stage]) => (
      isManagedPath(filepath, this.configDir, sharedPluginIds) && (head !== workdir || workdir !== stage)
    ));
  }

  /**
   * Rebuilds the coordinator's event-derived queue after a reload, crash, or
   * external filesystem edit. Ordinary sync cycles stay incremental; this is
   * deliberately an explicit recovery boundary backed by Git's full matrix.
   */
  async recoverManagedWorktree(): Promise<ManagedWorktreeRecovery> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const matrix = await this.publicStatusMatrix();
    const changedManagedPaths: string[] = [];
    let hasBoundaryRepair = false;
    for (const [path, head, workdir, stage] of matrix) {
      if (head === workdir && workdir === stage) continue;
      if (isManagedPath(path, this.configDir, sharedPluginIds)) changedManagedPaths.push(normalizeVaultPath(path));
      else hasBoundaryRepair = true;
    }
    return {
      changedManagedPaths: [...new Set(changedManagedPaths)].sort(),
      hasBoundaryRepair,
      hasChanges: changedManagedPaths.length > 0 || hasBoundaryRepair
    };
  }

  /**
   * Lists actual public worktree/index changes without staging, committing, or
   * reading remote state. Private and otherwise unmanaged paths stay outside
   * this boundary by design.
   */
  async listPublicWorktreeChanges(): Promise<PublicWorktreeChange[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const matrix = await this.publicStatusMatrix();
    const changes: PublicWorktreeChange[] = [];
    for (const [path, head, workdir, stage] of matrix) {
      if (!isManagedPath(path, this.configDir, sharedPluginIds)) continue;
      if (head === workdir && workdir === stage) continue;
      changes.push({
        path: normalizeVaultPath(path),
        status: workdir === 0 ? "deleted" : head === 0 ? "added" : "modified"
      });
    }
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * Keep event-derived rename hints only when Git still observes their final
   * delete-plus-add shape. Folder moves can emit duplicate or late descendant
   * events; this is the authoritative guard against a stale move prompt.
   */
  async actualPublicMoves(moves: readonly PendingPublicMove[]): Promise<PendingPublicMove[]> {
    const candidates = moves
      .map((move) => ({ from: normalizeVaultPath(move.from), to: normalizeVaultPath(move.to) }))
      .filter((move) => move.from && move.to && move.from !== move.to);
    if (!candidates.length) return [];
    const sharedPluginIds = await this.currentSharedPluginIds();
    const gitCandidates = candidates.filter((move) => isManagedPath(move.from, this.configDir, sharedPluginIds)
      && isManagedPath(move.to, this.configDir, sharedPluginIds));
    const statuses = new Map((await this.publicStatusMatrix(gitCandidates.flatMap((move) => [move.from, move.to])))
      .map((status) => [normalizeVaultPath(status[0]), status]));
    const actual: PendingPublicMove[] = [];
    for (const move of candidates) {
      if (isAssetPath(move.from) && isAssetPath(move.to)) {
        // Attachments are deliberately outside Git. Their final on-disk shape
        // still tells us whether this event-derived move remains real.
        if (!(await this.vault.exists(move.from)) && await this.vault.exists(move.to)) actual.push(move);
        continue;
      }
      const source = statuses.get(move.from);
      const target = statuses.get(move.to);
      if (source && target && source[1] !== 0 && source[2] === 0 && target[1] === 0 && target[2] !== 0) actual.push(move);
    }
    return actual.sort((left, right) => left.from.localeCompare(right.from));
  }

  /** Return only event-hinted paths that Git currently records as deletions. */
  async actualPublicDeletedPaths(paths: readonly string[]): Promise<string[]> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const candidates = [...new Set(paths.map(normalizeVaultPath).filter((path) => (
      path && isManagedPath(path, this.configDir, sharedPluginIds)
    )))];
    if (!candidates.length) return [];
    const matrix = await this.publicStatusMatrix(candidates);
    return matrix
      .filter(([path, head, workdir]) => isManagedPath(path, this.configDir, sharedPluginIds) && head !== 0 && workdir === 0)
      .map(([path]) => normalizeVaultPath(path))
      .sort();
  }

  private async publicStatusMatrix(paths?: readonly string[]): Promise<Array<[string, number, number, number]>> {
    if (paths) {
      const filepaths = [...new Set(paths.map(normalizeVaultPath).filter(Boolean))];
      return git.statusMatrix({ fs: this.fs, dir: "", filepaths, filter: (filepath) => !isPrivatePath(normalizeVaultPath(filepath)) });
    }
    const root = await this.vault.list("").catch(() => ({ files: [], folders: [] }));
    const indexed = await git.listFiles({ fs: this.fs, dir: "" }).catch(() => [] as string[]);
    const headed = await git.listFiles({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => [] as string[]);
    const roots = [...(root.files ?? []), ...(root.folders ?? []), ...indexed, ...headed]
      .map(normalizeVaultPath)
      .map((path) => path.split("/", 1)[0])
      .filter((path) => path && !isPrivatePath(path) && path !== ".git");
    const filepaths = [...new Set(roots)].sort();
    return git.statusMatrix({
      fs: this.fs,
      dir: "",
      filepaths: filepaths.length ? filepaths : [".team"],
      filter: (filepath) => !isPrivatePath(normalizeVaultPath(filepath))
    });
  }

  /** Clear pre-existing staged executable-bit noise after opting out of file modes. */
  private async clearIgnoredModeOnlyIndexChanges(): Promise<void> {
    if (!(await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined))) return;
    const sharedPluginIds = await this.currentSharedPluginIds();
    const paths = await walk({
      fs: this.fs,
      dir: "",
      trees: [TREE({ ref: "HEAD" }), STAGE()],
      map: async (path, [head, stage]) => {
        if (path === ".") return undefined;
        const entry = head ?? stage;
        if (!entry) return undefined;
        if (await entry.type() === "tree") return undefined;
        if (!head || !stage || !isManagedPath(path, this.configDir, sharedPluginIds)) return undefined;
        return await head.oid() === await stage.oid() && await head.mode() !== await stage.mode() ? normalizeVaultPath(path) : undefined;
      }
    }) as string[];
    await Promise.all(paths.map((filepath) => git.resetIndex({ fs: this.fs, dir: "", filepath })));
  }

  /** Compare HEAD and the index only. Neither walker touches Vault files. */
  private async changedIndexPaths(candidates: readonly string[]): Promise<string[]> {
    if (!candidates.length) return [];
    const wanted = new Set(candidates.map(normalizeVaultPath));
    const ancestors = new Set<string>();
    for (const path of wanted) {
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index += 1) ancestors.add(parts.slice(0, index).join("/"));
    }
    const changed = await walk({
      fs: this.fs,
      dir: "",
      trees: [TREE({ ref: "HEAD" }), STAGE()],
      map: async (path, [head, stage]) => {
        if (path === ".") return undefined;
        const entry = head ?? stage;
        if (!entry) return undefined;
        if (await entry.type() === "tree") return ancestors.has(path) ? undefined : null;
        if (!wanted.has(path)) return undefined;
        return await head?.oid() === await stage?.oid() ? undefined : path;
      }
    }) as string[];
    return changed.map(normalizeVaultPath).sort();
  }

  private async repairPrivateIndexBoundary(): Promise<void> {
    let hasPrivateTree = false;
    await walk({
      fs: this.fs,
      dir: "",
      trees: [STAGE()],
      map: async (path, [stage]) => {
        if (path === PRIVATE_FOLDER) {
          hasPrivateTree = Boolean(stage);
          return null;
        }
        // Normal incremental commits inspect only root index entries. This is
        // deliberately not a statusMatrix/listFiles traversal of the vault.
        return path === "." ? undefined : null;
      }
    });
    if (!hasPrivateTree) return;
    const privatePaths = await walk({
      fs: this.fs,
      dir: "",
      trees: [STAGE()],
      map: async (path, [stage]) => {
        if (path === ".") return undefined;
        if (path === PRIVATE_FOLDER || path.startsWith(`${PRIVATE_FOLDER}/`)) {
          return await stage?.type() === "tree" ? undefined : normalizeVaultPath(path);
        }
        return null;
      }
    }) as string[];
    await Promise.all(privatePaths.map((filepath) => git.remove({ fs: this.fs, dir: "", filepath }).catch(() => undefined)));
  }

  /** Remove every index entry outside the managed public boundary before committing. */
  private async repairIndexBoundary(): Promise<void> {
    await this.repairPrivateIndexBoundary();
    const sharedPluginIds = await this.currentSharedPluginIds();
    const staged = await git.listFiles({ fs: this.fs, dir: "" }).catch(() => [] as string[]);
    const forbidden = staged
      .map(normalizeVaultPath)
      .filter((path) => path && !isManagedPath(path, this.configDir, sharedPluginIds));
    await Promise.all(forbidden.map((filepath) => git.remove({ fs: this.fs, dir: "", filepath }).catch(() => undefined)));
  }
}
