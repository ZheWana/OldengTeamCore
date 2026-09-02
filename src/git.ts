import git, { TREE, walk, type GitProgressEvent, type MergeDriverParams } from "isomorphic-git";
import diff3Merge from "diff3";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { AssetManifest, CommitChangeDetails, CommitDocumentChange, CommitPluginChange, Logger, CommitSummary, TeamCoreSettings } from "./types";
import { collectMarkdownReferences, isAssetPath, isManagedPath, isPrivatePath, normalizeVaultPath, type BinaryVault } from "./vault";
import { DEFAULT_BRANCH, FILE_AUTHORS_PATH, MANIFEST_PATH } from "./constants";
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
    const files = await git.listFiles({ fs: this.fs, dir: "", ref });
    let sharedPluginIds: string[] = [];
    if (files.includes(".gitignore")) {
      const oid = await git.resolveRef({ fs: this.fs, dir: "", ref });
      const { blob } = await git.readBlob({ fs: this.fs, dir: "", oid, filepath: ".gitignore" });
      sharedPluginIds = readSharedPluginIdsFromGitignore(new TextDecoder().decode(blob), this.configDir);
    }
    const forbidden = files.filter((path) => !isManagedPath(path, this.configDir, sharedPluginIds));
    if (forbidden.length) {
      const preview = forbidden.slice(0, 5).join(", ");
      const remaining = forbidden.length > 5 ? ` 等 ${forbidden.length} 个文件` : "";
      throw new Error(`远端仓库包含禁止同步路径，已拒绝写入本地：${preview}${remaining}`);
    }
    return { files, sharedPluginIds };
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

  async ensureGitignore(): Promise<void> {
    await writeSharedPluginIds(this.vault, this.configDir, this.sharedPluginIds);
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
    await this.unstageLocalPrivateFiles();
    const trackedPrivatePaths = await this.trackedPrivatePaths();
    const currentExcluded = (): Set<string> => new Set(
      (typeof excludedPaths === "function" ? excludedPaths() : excludedPaths).map(normalizeVaultPath)
    );
    const matrix = await git.statusMatrix({
      fs: this.fs,
      dir: "",
      filepaths: undefined,
      // Filter before isomorphic-git resolves staged blobs. A private path
      // from an older, interrupted client can point at a pruned blob; it is
      // outside Team Core's boundary and must never block public syncing.
      filter: (filepath) => !isPrivatePath(filepath) || trackedPrivatePaths.has(normalizeVaultPath(filepath))
    });
    const changed: string[] = [];
    for (const [filepath, head, workdir, stage] of matrix as Array<[string, number, number, number]>) {
      if (currentExcluded().has(normalizeVaultPath(filepath))) {
        if (head !== stage) await git.resetIndex({ fs: this.fs, dir: "", filepath });
        continue;
      }
      if (isManagedPath(filepath, this.configDir, sharedPluginIds) && (head !== workdir || workdir !== stage)) {
        changed.push(filepath);
        if (workdir === 0) await git.remove({ fs: this.fs, dir: "", filepath });
        else await git.add({ fs: this.fs, dir: "", filepath });
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
    return included;
  }

  async commit(message: string, excludedPaths: readonly string[] | (() => readonly string[]) = []): Promise<string | undefined> {
    const changed = await this.stageManagedChanges(excludedPaths);
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
    await this.validateManagedTree(remote);
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
        mergeDriver: (params) => teamCoreMergeDriver(params, this.configDir)
      });
      const conflicts = (result as { conflictedFiles?: string[] }).conflictedFiles ?? [];
      if (!conflicts.length && !result.alreadyMerged) {
        // merge() updates the index/tree but does not materialize a clean
        // merge into the working tree. Checkout makes remote notes available
        // in the Vault before attachment materialization and the next commit.
        await git.checkout({ fs: this.fs, dir: "", ref: currentBranch ?? DEFAULT_BRANCH });
        await this.materializeSharedPluginFiles();
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
      const author = entry.commit.author.name.trim();
      if (author) authors.add(author);
    }
    return [...authors];
  }

  async fileAuthorsIndex(onProgress?: (current: number, total: number) => void): Promise<Map<string, string[]>> {
    const commits = await git.log({ fs: this.fs, dir: "" });
    const authorsByPath = new Map<string, Set<string>>();
    const cache = {};
    const configDirectory = normalizeVaultPath(this.configDir);
    for (const [index, entry] of commits.entries()) {
      const author = entry.commit.author.name.trim();
      if (author) {
        const parent = entry.commit.parent[0] ?? EMPTY_TREE_OID;
        const changed = await walk({
          fs: this.fs,
          dir: "",
          trees: [TREE({ ref: entry.oid }), TREE({ ref: parent })],
          cache,
          map: async (filepath, [current, previous]) => {
            const entry = current ?? previous;
            if (!entry) return undefined;
            if (await entry.type() === "tree") {
              return filepath === "assets" || filepath === configDirectory || filepath === "私人笔记" || filepath === ".trash" ? null : undefined;
            }
            if (!filepath.endsWith(".md") || filepath.startsWith(".team/")) return undefined;
            const currentOid = current ? await current.oid() : undefined;
            const previousOid = previous ? await previous.oid() : undefined;
            return currentOid === previousOid ? undefined : filepath;
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

  async hasUncommittedChanges(): Promise<boolean> {
    const sharedPluginIds = await this.currentSharedPluginIds();
    const trackedPrivatePaths = await this.trackedPrivatePaths();
    return (await git.statusMatrix({
      fs: this.fs,
      dir: "",
      filter: (filepath) => !isPrivatePath(filepath) || trackedPrivatePaths.has(normalizeVaultPath(filepath))
    })).some(([filepath, head, workdir, stage]) => {
      if (isManagedPath(filepath, this.configDir, sharedPluginIds)) return head !== workdir || workdir !== stage;
      return head !== 0 || stage !== 0;
    });
  }

  private async trackedPrivatePaths(): Promise<Set<string>> {
    const files = await git.listFiles({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => [] as string[]);
    return new Set(files.filter(isPrivatePath).map(normalizeVaultPath));
  }

  private async unstageLocalPrivateFiles(): Promise<void> {
    const paths: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      const entries = await this.vault.list(folder).catch(() => undefined);
      if (!entries) return;
      paths.push(...entries.files.map(normalizeVaultPath));
      await Promise.all(entries.folders.map((path) => walk(normalizeVaultPath(path))));
    };
    await walk("私人笔记");
    await Promise.all(paths.map((filepath) => git.remove({ fs: this.fs, dir: "", filepath }).catch(() => undefined)));
  }
}
