import git, { type MergeDriverParams } from "isomorphic-git";
import diff3Merge from "diff3";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { AssetManifest, Logger, CommitSummary, TeamCoreSettings } from "./types";
import { isManagedPath, isPrivatePath, normalizeVaultPath, type BinaryVault } from "./vault";
import { DEFAULT_BRANCH, MANIFEST_PATH } from "./constants";
import { mergeAssetManifests, serializeManifest, validateManifest } from "./manifest";
import { isPotentialPluginPath, pluginIdFromPath, readSharedPluginIds, writeSharedPluginIds } from "./shared-plugins";

const CONFLICT_STATE_PATH = ".git/team-core-conflict.json";
const LINEBREAKS = /^.*(\r?\n|$)/gm;

interface GitConflictState {
  version: 1;
  localOid: string;
  remoteOid: string;
  files: string[];
  detectedAt: string;
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

function teamCoreMergeDriver(params: MergeDriverParams): { cleanMerge: boolean; mergedText: string } {
  const [base, ours, theirs] = params.contents.map(parseManifestContent);
  if (base && ours && theirs) {
    const merged = mergeAssetManifests(base, ours, theirs);
    if (merged) return { cleanMerge: true, mergedText: serializeManifest(merged) };
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

const http = {
  async request(input: GitHttpRequest): Promise<GitHttpResponse> {
    const body = await collectGitBody(input.body);
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
    return {
      url: input.url,
      method: input.method,
      statusCode: response.status,
      statusMessage: `HTTP ${response.status}`,
      headers,
      body: responseBody(response.arrayBuffer)
    };
  }
};

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
        return [...listed.files, ...listed.folders].map(basename);
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
  constructor(
    private readonly vault: BinaryVault,
    private readonly settings: TeamCoreSettings,
    private readonly logger: Logger,
    private readonly configDir: string,
    private readonly sharedPluginIds: readonly string[] = []
  ) {
    this.fs = createGitFs(vault);
  }

  private auth() {
    return this.settings.gitUsername || this.settings.gitPassword ? { username: this.settings.gitUsername, password: this.settings.gitPassword } : undefined;
  }

  private async gitOptions() {
    const credentials = this.auth();
    return { fs: this.fs, dir: "", http, onAuth: credentials ? () => credentials : undefined };
  }

  async exists(): Promise<boolean> {
    return this.vault.exists(".git/HEAD");
  }

  async init(): Promise<void> {
    if (await this.exists()) return;
    await git.init({ fs: this.fs, dir: "", defaultBranch: DEFAULT_BRANCH });
  }

  async ensureRemote(): Promise<void> {
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

  async clone(): Promise<void> {
    const gitUrl = normalizeGitUrl(this.settings.gitUrl);
    if (!gitUrl) throw new Error("Git URL is not configured");
    const personalPluginFiles = await this.snapshotPersonalPluginFiles();
    await git.clone({ ...(await this.gitOptions()), url: gitUrl, ref: DEFAULT_BRANCH, singleBranch: true, noCheckout: false });
    await this.restorePersonalPluginFiles(personalPluginFiles);
  }

  async remoteInfo(): Promise<GitRemoteInfo> {
    const gitUrl = normalizeGitUrl(this.settings.gitUrl);
    if (!gitUrl) throw new Error("Git URL is not configured");
    const credentials = this.auth();
    const info = await git.getRemoteInfo({ url: gitUrl, http, onAuth: credentials ? () => credentials : undefined });
    return normalizeRemoteInfo(info);
  }

  async remoteUrl(): Promise<string | undefined> {
    const value: unknown = await git.getConfig({ fs: this.fs, dir: "", path: "remote.origin.url" }).catch(() => undefined);
    return typeof value === "string" ? value : undefined;
  }

  private async readConflictState(): Promise<GitConflictState | undefined> {
    if (!(await this.vault.exists(CONFLICT_STATE_PATH))) return undefined;
    try {
      const value = JSON.parse(new TextDecoder().decode(await this.vault.read(CONFLICT_STATE_PATH))) as Partial<GitConflictState>;
      if (value.version !== 1
        || typeof value.localOid !== "string" || !/^[0-9a-f]{40}$/i.test(value.localOid)
        || typeof value.remoteOid !== "string" || !/^[0-9a-f]{40}$/i.test(value.remoteOid)
        || !Array.isArray(value.files) || !value.files.every((path) => typeof path === "string" && path.length > 0)
        || typeof value.detectedAt !== "string") throw new Error("invalid shape");
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
    if (head !== state.localOid) throw new Error("冲突发生后本地提交已变化，请重新同步并重新打开冲突编辑器");
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
    const expected = [...state.files].sort();
    const provided = resolutions.map(({ path }) => path).sort();
    if (new Set(provided).size !== provided.length || provided.length !== expected.length || provided.some((path, index) => path !== expected[index])) {
      throw new Error("必须为每个冲突文件提交且仅提交一个解决结果");
    }

    const normalized = resolutions.map((resolution) => {
      if (resolution.path !== normalizeVaultPath(resolution.path) || !isManagedPath(resolution.path, this.configDir, this.sharedPluginIds)) {
        throw new Error(`冲突文件路径无效：${resolution.path}`);
      }
      if (resolution.path !== MANIFEST_PATH) return { ...resolution };
      if (resolution.content === undefined) throw new Error("附件清单不能删除，请选择或编辑一个有效版本");
      try {
        return { path: resolution.path, content: serializeManifest(validateManifest(JSON.parse(resolution.content))) };
      } catch (error) {
        throw new Error(`附件清单格式无效：${error instanceof Error ? error.message : String(error)}`);
      }
    });

    for (const resolution of normalized) {
      if (resolution.content === undefined) {
        if (await this.vault.exists(resolution.path)) await this.vault.remove(resolution.path);
        await git.remove({ fs: this.fs, dir: "", filepath: resolution.path });
      } else {
        const encoded = new TextEncoder().encode(resolution.content);
        await this.vault.write(resolution.path, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
        await git.add({ fs: this.fs, dir: "", filepath: resolution.path });
      }
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

  async ensureGitignore(): Promise<void> {
    await writeSharedPluginIds(this.vault, this.configDir, this.sharedPluginIds);
  }

  async stageManagedChanges(): Promise<string[]> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir: "", filepaths: undefined });
    const changed: string[] = [];
    for (const [filepath, head, workdir, stage] of matrix as Array<[string, number, number, number]>) {
      if (isPrivatePath(filepath)) {
        if (head !== 0 || stage !== 0) changed.push(filepath);
        if (stage !== 0) await git.remove({ fs: this.fs, dir: "", filepath });
        continue;
      }
      if (isManagedPath(filepath, this.configDir, this.sharedPluginIds) && (head !== workdir || workdir !== stage)) {
        changed.push(filepath);
        if (workdir === 0) await git.remove({ fs: this.fs, dir: "", filepath });
        else await git.add({ fs: this.fs, dir: "", filepath });
      } else if (isPotentialPluginPath(filepath, this.configDir) && (head !== 0 || stage !== 0)) {
        // Removing a directory from the whitelist untracks it without deleting
        // its local files, so it becomes a personal plugin immediately.
        changed.push(filepath);
        await git.remove({ fs: this.fs, dir: "", filepath });
      }
    }
    return changed;
  }

  async commit(message: string): Promise<string | undefined> {
    const changed = await this.stageManagedChanges();
    if (!changed.length) return undefined;
    const username = this.settings.gitUsername.trim() || "unknown";
    const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
    const oid = await git.commit({ fs: this.fs, dir: "", message, author: { name: username, email }, committer: { name: username, email } });
    this.logger.debug("Created Git commit", { oid, files: changed });
    return oid;
  }

  async fetch(): Promise<void> {
    await this.ensureRemote();
    await git.fetch({ ...(await this.gitOptions()), remote: "origin", ref: DEFAULT_BRANCH, singleBranch: true, prune: false });
  }

  async mergeRemote(): Promise<{ merged: boolean; conflicts: string[] }> {
    const pendingConflicts = await this.conflictedFiles();
    if (pendingConflicts.length) return { merged: false, conflicts: pendingConflicts };
    const remote = await git.resolveRef({ fs: this.fs, dir: "", ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }).catch(() => undefined);
    const local = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!remote || !local || remote === local) return { merged: false, conflicts: [] };
    const personalPluginFiles = await this.snapshotPersonalPluginFiles();
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
        mergeDriver: teamCoreMergeDriver
      });
      const conflicts = (result as { conflictedFiles?: string[] }).conflictedFiles ?? [];
      if (!conflicts.length && !result.alreadyMerged) {
        // merge() updates the index/tree but does not materialize a clean
        // merge into the working tree. Checkout makes remote notes available
        // in the Vault before attachment materialization and the next commit.
        await git.checkout({ fs: this.fs, dir: "", ref: currentBranch ?? DEFAULT_BRANCH });
        await this.restorePersonalPluginFiles(personalPluginFiles);
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

  private async snapshotPersonalPluginFiles(): Promise<Map<string, ArrayBuffer>> {
    const snapshot = new Map<string, ArrayBuffer>();
    const configPrefix = `${normalizeVaultPath(this.configDir) || ".obsidian"}/plugins/`;
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

  async log(filepath?: string, depth = 200): Promise<CommitSummary[]> {
    const entries = await git.log({ fs: this.fs, dir: "", depth, filepath });
    return entries.map((entry) => ({
      oid: entry.oid,
      shortOid: entry.oid.slice(0, 7),
      message: entry.commit.message.trim(),
      author: entry.commit.author.name,
      email: entry.commit.author.email,
      timestamp: entry.commit.author.timestamp * 1000
    }));
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await git.statusMatrix({ fs: this.fs, dir: "" })).some(([filepath, head, workdir, stage]) => {
      if (isPrivatePath(filepath)) return head !== 0 || stage !== 0;
      if (isManagedPath(filepath, this.configDir, this.sharedPluginIds)) return head !== workdir || workdir !== stage;
      return isPotentialPluginPath(filepath, this.configDir) && (head !== 0 || stage !== 0);
    });
  }
}
