import git from "isomorphic-git";
import { requestUrl, type RequestUrlParam } from "obsidian";
import type { Logger, CommitSummary, TeamCoreSettings } from "./types";
import { isManagedPath, isPrivatePath, normalizeVaultPath, type BinaryVault } from "./vault";
import { DEFAULT_BRANCH, PRIVATE_PREFIX } from "./constants";

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
  constructor(private readonly vault: BinaryVault, private readonly settings: TeamCoreSettings, private readonly logger: Logger, private readonly configDir: string) {
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
    await git.clone({ ...(await this.gitOptions()), url: gitUrl, ref: DEFAULT_BRANCH, singleBranch: true, noCheckout: false });
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

  async ensureGitignore(): Promise<void> {
    const path = ".gitignore";
    let current = "";
    if (await this.vault.exists(path)) current = new TextDecoder().decode(await this.vault.read(path));
    const entries = [`${normalizeVaultPath(this.configDir)}/`, "assets/", PRIVATE_PREFIX];
    const lines = current.split(/\r?\n/).filter(Boolean);
    for (const entry of entries) if (!lines.some((line) => line.trim() === entry)) lines.push(entry);
    await this.vault.write(path, new TextEncoder().encode(`${lines.join("\n")}\n`).buffer);
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
      if (isManagedPath(filepath, this.configDir) && (head !== workdir || workdir !== stage)) {
        changed.push(filepath);
        if (workdir === 0) await git.remove({ fs: this.fs, dir: "", filepath });
        else await git.add({ fs: this.fs, dir: "", filepath });
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
    const remote = await git.resolveRef({ fs: this.fs, dir: "", ref: `refs/remotes/origin/${DEFAULT_BRANCH}` }).catch(() => undefined);
    const local = await git.resolveRef({ fs: this.fs, dir: "", ref: "HEAD" }).catch(() => undefined);
    if (!remote || !local || remote === local) return { merged: false, conflicts: [] };
    try {
      const username = this.settings.gitUsername.trim() || "unknown";
      const email = `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}@knowledgebase.local`;
      const result = await git.merge({
        fs: this.fs,
        dir: "",
        ours: local,
        theirs: remote,
        fastForward: false,
        message: "Merge remote changes",
        author: { name: username, email },
        committer: { name: username, email }
      });
      const conflicts = (result as { conflictedFiles?: string[] }).conflictedFiles ?? [];
      return { merged: true, conflicts };
    } catch (error) {
      const conflicts = (error as { conflictedFiles?: string[] }).conflictedFiles ?? [];
      if (conflicts.length) return { merged: false, conflicts };
      throw error;
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
      return isManagedPath(filepath, this.configDir) && (head !== workdir || workdir !== stage);
    });
  }
}
