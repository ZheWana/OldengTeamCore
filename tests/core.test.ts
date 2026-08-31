import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, rename, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exportSettings, importSettings, mergeSettings } from "../src/config";
import { base64UrlDecode, base64UrlEncode, sha256Hex } from "../src/crypto";
import { conflictFilesFromError, GitRepository, isNonFastForwardPushError, isPushReconciliationError, normalizeGitUrl, normalizeRemoteInfo } from "../src/git";
import { createEmptyManifest, mergeAssetManifests, serializeManifest, validateManifest } from "../src/manifest";
import { S3_CHUNKED_DOWNLOAD_THRESHOLD, S3_DOWNLOAD_CHUNK_SIZE, S3Transport } from "../src/s3";
import { planPrivateDraftPublication, planPublicNotePrivatization, pushWithNonFastForwardRetry, shouldMaterializeRemoteAttachment, shouldNormalizeMovedAttachment, shouldProtectMismatchedLocalAttachment, shouldPublishPrivateDraftRename, shouldTrackVaultEvent, takePendingPaths } from "../src/sync";
import { assetPathForHash, collectMarkdownReferences, collectPrivateAttachmentReferences, ensureAssetsExcluded, hashFromAssetPath, isAssetPath, isConfigPath, isHiddenAssetsFolderPath, isImageAttachmentPath, isManagedPath, isPrivateAssetPath, isPrivatePath, isRootAssetsPath, isTrashPath, legacyHashFromAssetPath, listRemoteOverwriteFiles, normalizeVaultPath, pastedImageExtension, pastedImageTargetPath, pruneEmptyManagedFolders, rewriteAssetReferences } from "../src/vault";
import { applySharedPluginState, mergeSharedPluginIds, mergeSharedPluginState, parseSharedPluginState, readSharedPluginIdsFromGitignore, readSharedPluginState, serializeSharedPluginState, updateSharedPluginsInGitignore, writeSharedPluginState } from "../src/shared-plugins";
import { DEFAULT_SETTINGS, type Logger, type TeamCoreSettings } from "../src/types";
import type { BinaryVault } from "../src/vault";
import git from "isomorphic-git";
import { assignedOrHistoricalAuthors, clearFileAuthors, countResolvedDocumentAuthors, createEmptyFileAuthorRegistry, FileAuthorService, mergeFileAuthorRegistries, parseFileAuthorRegistry, serializeFileAuthorRegistry, setFileAuthors, validateFileAuthorRegistry, writeFileAuthorRegistry } from "../src/file-authors";
import { Buffer as BrowserBuffer } from "../src/browser-shims";
import { PluginLogger, parseLogEntries } from "../src/logger";
import { AuthorDisplayService, parseAuthorDisplayMappings, serializeAuthorDisplayMappings } from "../src/author-display";

const execFileAsync = promisify(execFile);

const settings = (overrides: Partial<TeamCoreSettings> = {}): TeamCoreSettings => ({
  ...DEFAULT_SETTINGS,
  gitUrl: "https://git.example.test/knowledge.git",
  gitUsername: "Alice.Example",
  gitPassword: "team-secret",
  s3Endpoint: "https://s3.example.test",
  s3Region: "z0",
  s3Bucket: "team-kb",
  s3Prefix: "vault",
  s3AccessKey: "access",
  s3SecretKey: "secret",
  ...overrides
});

const logger: Logger = { debug() {}, warn() {}, error() {} };

class NodeVault implements BinaryVault {
  constructor(private readonly root: string) {}

  private resolve(path: string): string { return join(this.root, path); }
  async read(path: string): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(await readFile(this.resolve(path)));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  async write(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.resolve(path)), { recursive: true });
    await writeFile(this.resolve(path), new Uint8Array(data));
  }
  async append(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.resolve(path)), { recursive: true });
    await writeFile(this.resolve(path), new Uint8Array(data), { flag: "a" });
  }
  async exists(path: string): Promise<boolean> {
    try { await stat(this.resolve(path)); return true; } catch { return false; }
  }
  async stat(path: string): Promise<{ type: "file" | "folder"; size: number; mtime: number } | null> {
    try {
      const value = await stat(this.resolve(path));
      return { type: value.isDirectory() ? "folder" : "file", size: value.size, mtime: value.mtimeMs };
    } catch { return null; }
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const entries = await readdir(this.resolve(path), { withFileTypes: true });
    return {
      files: entries.filter((entry) => entry.isFile()).map((entry) => join(path, entry.name)),
      folders: entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name))
    };
  }
  mkdir(path: string): Promise<void> { return mkdir(this.resolve(path), { recursive: true }); }
  remove(path: string): Promise<void> { return rm(this.resolve(path), { recursive: true, force: true }); }
  rmdir(path: string): Promise<void> { return rm(this.resolve(path), { recursive: true, force: true }); }
  rename(path: string, newPath: string): Promise<void> {
    return rename(this.resolve(path), this.resolve(newPath));
  }
}

const encode = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;
const decode = (value: ArrayBuffer): string => new TextDecoder().decode(value);

describe("browser runtime shims", () => {
  it("provides the Buffer operations required by isomorphic-git", () => {
    expect(BrowserBuffer.from("mobile import").toString("base64")).toBe("bW9iaWxlIGltcG9ydA==");
    expect(BrowserBuffer.concat([BrowserBuffer.from([1]), BrowserBuffer.from([2])])).toEqual(BrowserBuffer.from([1, 2]));
  });
});

describe("diagnostic logging", () => {
  it("keeps operational details while redacting secrets", () => {
    const logger = new PluginLogger(() => false);
    logger.warn("Attachment upload failed", { path: "assets/tc-sha256-image.png", password: "do-not-export", error: "HTTP 413" });
    const exported = JSON.parse(logger.exportText({ gitUrl: "https://git.example.test/team.git" })) as { entries: Array<{ details: { path: string; password: string; error: string } }> };
    expect(exported.entries[0].details).toEqual({ path: "assets/tc-sha256-image.png", password: "[redacted]", error: "HTTP 413" });
  });

  it("loads only valid persisted entries", () => {
    expect(parseLogEntries([
      { timestamp: "2026-08-30T00:00:00.000Z", level: "debug", message: "ok" },
      { timestamp: "bad", level: "unknown", message: "ignored" },
      null
    ])).toHaveLength(1);
  });
});

async function applyFiles(vault: NodeVault, changes: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) await vault.remove(path);
    else await vault.write(path, encode(content));
  }
}

async function createDivergence(root: string, base: Record<string, string>, local: Record<string, string | null>, remote: Record<string, string | null>) {
  const vault = new NodeVault(root);
  const repo = new GitRepository(vault, settings(), logger, ".obsidian");
  await repo.init();
  await applyFiles(vault, base);
  await repo.commit("Base");
  await git.branch({ fs: repo.fs, dir: "", ref: "remote" });

  await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
  await applyFiles(vault, remote);
  const remoteCommit = await repo.commit("Remote change");
  if (!remoteCommit) throw new Error("Expected a remote commit");

  await git.checkout({ fs: repo.fs, dir: "", ref: "main" });
  await applyFiles(vault, local);
  const localCommit = await repo.commit("Local change");
  if (!localCommit) throw new Error("Expected a local commit");
  await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit, force: true });
  return { vault, repo, localCommit, remoteCommit };
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function startGitHttpServer(projectRoot: string, beforeFirstPush: () => Promise<void>) {
  let pushHookPending = true;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (pushHookPending && url.searchParams.get("service") === "git-receive-pack") {
        pushHookPending = false;
        await beforeFirstPush();
      }
      const backend = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: decodeURIComponent(url.pathname),
          QUERY_STRING: url.searchParams.toString(),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: request.headers["content-length"] ?? "0",
          REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
          REMOTE_USER: "vitest"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      request.pipe(backend.stdin);
      let pending = Buffer.alloc(0);
      let headersSent = false;
      backend.stdout.on("data", (chunk: Buffer) => {
        if (headersSent) { response.write(chunk); return; }
        pending = Buffer.concat([pending, chunk]);
        const split = pending.indexOf("\r\n\r\n");
        if (split < 0) return;
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of pending.subarray(0, split).toString("utf8").split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers);
        headersSent = true;
        response.write(pending.subarray(split + 4));
      });
      backend.on("close", (code) => {
        if (!headersSent) response.writeHead(code === 0 ? 200 : 500);
        response.end();
      });
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to resolve Git test server port");
  return {
    url: `http://127.0.0.1:${address.port}/repo.git`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

describe("configuration bundles", () => {
  it("round-trips shared settings without replacing the local identity", () => {
    const source = settings({ gitUsername: "source-user", debounceMs: 90_000 });
    const current = settings({ gitUsername: "local-user", debounceMs: 60_000 });
    const imported = importSettings(exportSettings(source), current);

    expect(imported).toEqual({ ...source, gitUsername: "local-user" });
  });

  it("rejects malformed bundles and invalid timing values", () => {
    expect(() => importSettings("not-base64", settings())).toThrow();
    const encoded = exportSettings(settings({ debounceMs: 0 }));
    expect(() => importSettings(encoded, settings())).toThrow("同步时间");
  });

  it("preserves the automatic-sync choice and defaults legacy settings to enabled", () => {
    const source = settings({ autoSync: false });
    expect(importSettings(exportSettings(source), settings({ autoSync: true })).autoSync).toBe(true);
    expect(importSettings(exportSettings(source), settings({ autoSync: false })).autoSync).toBe(false);
    expect(mergeSettings({ autoSync: false }).autoSync).toBe(false);
    expect(mergeSettings({}).autoSync).toBe(false);
  });

  it("imports Git author display mappings without replacing the local login identity", () => {
    const source = settings({ gitUsername: "source-user", authorDisplayMappings: { xuchenrui: "许宸瑞" } });
    const imported = importSettings(exportSettings(source), settings({ gitUsername: "local-user" }));
    expect(imported.gitUsername).toBe("local-user");
    expect(imported.authorDisplayMappings).toEqual({ xuchenrui: "许宸瑞" });
  });

  it("rejects a malformed Git author display mapping in a configuration bundle", () => {
    const encoded = base64UrlEncode(JSON.stringify({ version: 1, settings: { authorDisplayMappings: "not-a-map" } }));
    expect(() => importSettings(encoded, settings())).toThrow("映射无效");
  });
});

describe("Git author display mappings", () => {
  it("uses canonical case-insensitive mappings and preserves unmapped names", () => {
    const mappings = parseAuthorDisplayMappings("xuchenrui = 许宸瑞\nWangZhe = 王哲");
    expect(mappings).toEqual({ wangzhe: "王哲", xuchenrui: "许宸瑞" });
    expect(serializeAuthorDisplayMappings(mappings)).toBe("wangzhe = 王哲\nxuchenrui = 许宸瑞");
    const display = new AuthorDisplayService(mappings);
    expect(display.display("XuChenRui")).toBe("许宸瑞");
    expect(display.displayMany(["xuchenrui", "许宸瑞", "unknown"])).toEqual(["许宸瑞", "unknown"]);
  });

  it("rejects malformed and duplicate mapping rows", () => {
    expect(() => parseAuthorDisplayMappings("xuchenrui 许宸瑞")).toThrow("第 1 行");
    expect(() => parseAuthorDisplayMappings("xuchenrui = 许宸瑞\nXuChenRui = 许宸瑞")).toThrow("重复");
  });
});

describe("Git URL normalization", () => {
  it("trims whitespace and trailing slashes before Smart HTTP appends paths", () => {
    expect(normalizeGitUrl("  https://git.example.test/knowledge.git/// ")).toBe("https://git.example.test/knowledge.git");
  });

  it("normalizes isomorphic-git remote discovery into branch and tag maps", () => {
    expect(normalizeRemoteInfo({ heads: { main: "a".repeat(40) }, tags: { v1: "b".repeat(40) }, HEAD: "refs/heads/main" })).toEqual({
      heads: { main: "a".repeat(40) },
      tags: { v1: "b".repeat(40) },
      defaultBranch: "refs/heads/main"
    });
    expect(normalizeRemoteInfo({ refs: { heads: { main: "a".repeat(40) } } }).heads.main).toBe("a".repeat(40));
  });
});

describe("crypto helpers", () => {
  it("produces the standard SHA-256 digest and URL-safe text encoding", async () => {
    expect(await sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const encoded = base64UrlEncode("团队 / team");
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toBe("团队 / team");
  });
});

describe("file author assignments", () => {
  it("stores canonical file-level authors and falls back to Git history", () => {
    const empty = createEmptyFileAuthorRegistry();
    expect(assignedOrHistoricalAuthors(empty, "notes/a.md", ["Git Author"])).toEqual(["Git Author"]);

    const assigned = setFileAuthors(empty, ["notes/b.md", "notes/a.md"], [" Alice ", "Bob", "Alice"]);
    expect(assignedOrHistoricalAuthors(assigned, "notes/a.md", ["Git Author"])).toEqual(["Alice", "Bob"]);
    expect(serializeFileAuthorRegistry(assigned)).toContain('"notes/a.md"');
    expect(Object.keys(parseFileAuthorRegistry(serializeFileAuthorRegistry(assigned)).files)).toEqual(["notes/a.md", "notes/b.md"]);

    const cleared = clearFileAuthors(assigned, ["notes/a.md"]);
    expect(assignedOrHistoricalAuthors(cleared, "notes/a.md", ["Git Author"])).toEqual(["Git Author"]);
    expect(() => validateFileAuthorRegistry({ version: 1, files: { "私人笔记/a.md": ["Alice"] } })).toThrow("路径无效");
    expect(() => validateFileAuthorRegistry({ version: 1, files: { "notes/a.md": [] } })).toThrow("不能为空");
  });

  it("merges independent file assignments and rejects competing edits", () => {
    const base = setFileAuthors(createEmptyFileAuthorRegistry(), ["notes/base.md"], ["Base"]);
    const ours = setFileAuthors(base, ["notes/local.md"], ["Alice"]);
    const theirs = setFileAuthors(base, ["notes/remote.md"], ["Bob"]);
    expect(mergeFileAuthorRegistries(base, ours, theirs)?.files).toEqual({
      "notes/base.md": ["Base"],
      "notes/local.md": ["Alice"],
      "notes/remote.md": ["Bob"]
    });

    const localEdit = setFileAuthors(base, ["notes/base.md"], ["Alice"]);
    const remoteEdit = setFileAuthors(base, ["notes/base.md"], ["Bob"]);
    expect(mergeFileAuthorRegistries(base, localEdit, remoteEdit)).toBeUndefined();
  });

  it("counts assigned document authors before falling back to file history", () => {
    const resolved = new Map<string, readonly string[]>([
      ["notes/manual.md", ["Manual Author"]],
      ["notes/history.md", ["Git Author", "Coauthor", "Git Author"]]
    ]);
    expect(Object.fromEntries(countResolvedDocumentAuthors(resolved))).toEqual({
      "Manual Author": 1,
      "Git Author": 1,
      Coauthor: 1
    });
  });

  it("resolves title and chart authors through one cached service", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-author-service-"));
    try {
      const vault = new NodeVault(root);
      await vault.write(".team/file-authors.json", encode(JSON.stringify({ version: 1, files: { "notes/manual.md": ["Manual Author"] } })));
      const calls: string[] = [];
      const service = new FileAuthorService(vault, {
        exists: async () => true,
        fileAuthors: async (path) => { calls.push(path); return ["Git Author"]; }
      });
      expect(await service.getAuthors("notes/manual.md")).toEqual(["Manual Author"]);
      expect(await service.getAuthors("notes/history.md")).toEqual(["Git Author"]);
      expect(await service.getAuthors("notes/history.md")).toEqual(["Git Author"]);
      expect(calls).toEqual(["notes/history.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one full-history index for chart authors while preserving manual assignments", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-author-index-"));
    try {
      const vault = new NodeVault(root);
      await vault.write(".team/file-authors.json", encode(JSON.stringify({ version: 1, files: { "notes/manual.md": ["Manual Author"] } })));
      let indexCalls = 0;
      const service = new FileAuthorService(vault, {
        exists: async () => true,
        fileAuthors: async () => { throw new Error("per-file lookup should not run"); },
        fileAuthorsIndex: async () => {
          indexCalls += 1;
          return new Map([["notes/history.md", ["Git Author", "Coauthor"]]]);
        }
      });
      const counts = await service.getDocumentAuthorCounts(["notes/manual.md", "notes/history.md"]);
      expect(Object.fromEntries(counts)).toEqual({ "Manual Author": 1, "Git Author": 1, Coauthor: 1 });
      expect(indexCalls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing hidden team directory when saving assignments", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-file-authors-"));
    try {
      const vault = new NodeVault(root);
      await vault.mkdir(".team");
      const originalMkdir = vault.mkdir.bind(vault);
      let mkdirCalls = 0;
      vault.mkdir = async (path: string): Promise<void> => {
        mkdirCalls += 1;
        if (await vault.exists(path)) throw new Error("Folder already exists");
        await originalMkdir(path);
      };
      const registry = setFileAuthors(createEmptyFileAuthorRegistry(), ["notes/a.md"], ["Alice"]);
      await writeFileAuthorRegistry(vault, registry);
      expect(mkdirCalls).toBe(0);
      expect(parseFileAuthorRegistry(decode(await vault.read(".team/file-authors.json")))).toEqual(registry);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("manifest and vault path rules", () => {
  it("adds assets to Obsidian excluded-file filters without replacing existing filters", () => {
    let filters: unknown = ["*.tmp"];
    const vault = {
      getConfig: (key: string) => key === "userIgnoreFilters" ? filters : undefined,
      setConfig: (key: string, value: unknown) => { if (key === "userIgnoreFilters") filters = value; }
    } as unknown as Vault;
    expect(ensureAssetsExcluded(vault)).toBe(true);
    expect(filters).toEqual(["*.tmp", "assets", "私人笔记/assets"]);
    expect(ensureAssetsExcluded(vault)).toBe(false);
    expect(filters).toEqual(["*.tmp", "assets", "私人笔记/assets"]);
  });

  it("recognizes only the root assets folder for explorer hiding", () => {
    expect(isRootAssetsPath("assets")).toBe(true);
    expect(isRootAssetsPath("/assets/")).toBe(true);
    expect(isRootAssetsPath("assets/screenshots/image.png")).toBe(false);
    expect(isRootAssetsPath("notes/assets")).toBe(false);
    expect(isHiddenAssetsFolderPath("assets")).toBe(true);
    expect(isHiddenAssetsFolderPath("私人笔记/assets")).toBe(true);
    expect(isHiddenAssetsFolderPath("私人笔记")).toBe(false);
    expect(isHiddenAssetsFolderPath("notes/assets")).toBe(false);
  });

  it("recognizes pasted image attachment extensions outside assets", () => {
    expect(isImageAttachmentPath("Pasted image.png")).toBe(true);
    expect(isImageAttachmentPath("notes/photo.JPG")).toBe(true);
    expect(isImageAttachmentPath("notes/readme.md")).toBe(false);
    expect(isImageAttachmentPath("assets/photo.png")).toBe(true);
    const hash = "a".repeat(64);
    expect(pastedImageExtension("image", "image/jpeg")).toBe("jpg");
    expect(pastedImageExtension("photo.WEBP", "application/octet-stream")).toBe("webp");
    expect(pastedImageTargetPath(hash, "png", "notes/readme.md")).toBe(`assets/tc-sha256-${hash}.png`);
    expect(pastedImageTargetPath(hash, "png", "私人笔记/readme.md")).toBe(`私人笔记/assets/tc-sha256-${hash}.png`);
  });

  it("prunes ordinary empty folders while preserving local-only roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-empty-folders-"));
    try {
      class WindowsDirectoryVault extends NodeVault {
        override rmdir(path: string, recursive = false): Promise<void> {
          if (!recursive) return Promise.reject(new Error(`Path is a directory: ${path}`));
          return super.rmdir(path, recursive);
        }
      }
      const vault = new WindowsDirectoryVault(root);
      await vault.mkdir("gone/nested");
      await vault.mkdir("kept");
      await vault.write("kept/note.md", encode("note"));
      await vault.mkdir("assets");
      await vault.mkdir("私人笔记/empty");
      await vault.mkdir(".obsidian/plugins");
      expect(await pruneEmptyManagedFolders(vault, ".obsidian")).toEqual(["gone", "gone/nested"]);
      expect(await vault.exists("gone")).toBe(false);
      expect(await vault.exists("kept")).toBe(true);
      expect(await vault.exists("assets")).toBe(true);
      expect(await vault.exists("私人笔记/empty")).toBe(true);
      expect(await vault.exists(".obsidian/plugins")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds hidden files that must be cleared before a confirmed remote overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-overwrite-files-"));
    try {
      const vault = new NodeVault(root);
      await vault.write(".team/assets-manifest.json", encode(serializeManifest(createEmptyManifest())));
      await vault.write(".gitignore", encode("assets/\n"));
      await vault.write("assets/hidden.png", encode("asset"));
      await vault.write("notes/readme.md", encode("note"));
      await vault.write(".obsidian/app.json", encode("{}\n"));
      await vault.write("私人笔记/draft.md", encode("draft"));
      await vault.write(".trash/deleted.md", encode("deleted"));
      await vault.write(".git/HEAD", encode("ref: refs/heads/main\n"));

      expect(await listRemoteOverwriteFiles(vault, ".obsidian")).toEqual([
        ".gitignore",
        ".team/assets-manifest.json",
        "assets/hidden.png",
        "notes/readme.md"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes and serializes asset entries deterministically", () => {
    const manifest = validateManifest({
      version: 1,
      files: {
        "assets\\z.pdf": {
          sha256: "b".repeat(64),
          size: 10,
          mime: "application/pdf",
          uploadedAt: "2026-08-25T00:00:00Z",
          uploadedBy: "alice"
        },
        "assets/a.png": {
          sha256: "a".repeat(64),
          size: 5,
          mime: "image/png",
          uploadedAt: "2026-08-25T00:00:00Z",
          uploadedBy: "alice"
        }
      }
    });
    expect(Object.keys(manifest.files)).toEqual(["assets/z.pdf", "assets/a.png"]);
    const serialized = serializeManifest(manifest);
    expect(serialized.indexOf("assets/a.png")).toBeLessThan(serialized.indexOf("assets/z.pdf"));
    expect(validateManifest(createEmptyManifest())).toEqual(createEmptyManifest());
  });

  it("rejects non-asset paths and invalid hashes", () => {
    expect(() => validateManifest({ version: 1, files: { "notes/a.md": {} } })).toThrow("not an asset");
    expect(() => validateManifest({ version: 1, files: { "assets/a.bin": { sha256: "x", size: 1, mime: "x", uploadedAt: "2026-01-01", uploadedBy: "a" } } })).toThrow("SHA-256");
  });

  it("semantically merges independent attachment paths and rejects competing changes to one path", () => {
    const entry = (hash: string, uploadedBy: string) => ({
      sha256: hash.repeat(64),
      size: 10,
      mime: "image/png",
      uploadedAt: "2026-08-28T00:00:00.000Z",
      uploadedBy
    });
    const base = createEmptyManifest();
    const ours = validateManifest({ version: 1, files: { "assets/local.png": entry("a", "alice") } });
    const theirs = validateManifest({ version: 1, files: { "assets/remote.png": entry("b", "bob") } });
    expect(mergeAssetManifests(base, ours, theirs)).toEqual(validateManifest({
      version: 1,
      files: { "assets/local.png": entry("a", "alice"), "assets/remote.png": entry("b", "bob") }
    }));

    const remoteSamePath = validateManifest({ version: 1, files: { "assets/local.png": entry("c", "bob") } });
    expect(mergeAssetManifests(base, ours, remoteSamePath)).toBeUndefined();

    const sameContentMetadata = validateManifest({ version: 1, files: { "assets/local.png": { ...entry("a", "bob"), uploadedAt: "2026-08-28T01:00:00.000Z" } } });
    expect(mergeAssetManifests(base, ours, sameContentMetadata)?.files["assets/local.png"]).toEqual(ours.files["assets/local.png"]);
  });

  it("extracts wiki and Markdown attachment references", () => {
    const markdown = [
      "![[assets/diagram.png|width=300]]",
      "![PDF](../assets/guide.pdf#page=2)",
      "[[assets/notes.txt]]",
      "![remote](https://example.test/image.png)"
    ].join("\n");
    expect(collectMarkdownReferences(markdown, "notes/readme.md")).toEqual(["assets/diagram.png", "assets/guide.pdf", "assets/notes.txt"]);
    expect(collectPrivateAttachmentReferences("![[私人笔记/assets/draft.png]]", "notes/readme.md")).toEqual(["私人笔记/assets/draft.png"]);
    expect(collectPrivateAttachmentReferences("![[assets/draft.png]]", "私人笔记/readme.md")).toEqual([]);
    expect(isPrivateAssetPath("私人笔记/assets/draft.png")).toBe(true);
    expect(isPrivateAssetPath("assets/draft.png")).toBe(false);
    expect(normalizeVaultPath("/notes\\../assets//a.png")).toBe("assets/a.png");
    expect(isAssetPath("assets/a.png")).toBe(true);
    expect(isManagedPath("notes/readme.md", ".obsidian")).toBe(true);
    expect(isManagedPath("assets/a.png", ".obsidian")).toBe(false);
    expect(isPrivatePath("私人笔记/秘密.md")).toBe(true);
    expect(isManagedPath("私人笔记/秘密.md", ".obsidian")).toBe(false);
    expect(isPrivatePath("私人笔记")).toBe(true);
    expect(isPrivatePath("私人笔记备份/公开.md")).toBe(false);
    expect(isPrivatePath("Private/legacy.md")).toBe(false);
    expect(isManagedPath("Private/legacy.md", ".obsidian")).toBe(true);
    expect(isPrivatePath("PrivateNotes/visible.md")).toBe(false);
    expect(isConfigPath(".settings/plugins/team-core/data.json", ".settings")).toBe(true);
    expect(isManagedPath(".settings/plugins/team-core/data.json", ".settings")).toBe(false);
    expect(isManagedPath(".settings/plugins/calendar/main.js", ".settings", ["calendar"])).toBe(true);
    expect(isManagedPath(".settings/plugins/dataview/main.js", ".settings", ["calendar"])).toBe(false);
    expect(isManagedPath(".settings/community-plugins.json", ".settings", ["calendar"])).toBe(false);
    expect(isConfigPath(".settings-backup/visible.md", ".settings")).toBe(false);
    expect(isTrashPath(".trash/deleted.md")).toBe(true);
    expect(isManagedPath(".trash/deleted.md", ".obsidian")).toBe(false);
  });

  it("uses the managed gitignore block as the shared plugin whitelist", () => {
    const content = ["notes/*.tmp", "assets/", "私人笔记/"].join("\n") + "\n";
    const updated = updateSharedPluginsInGitignore(content, ".obsidian", ["dataview", "calendar", "dataview"]);
    expect(readSharedPluginIdsFromGitignore(updated, ".obsidian")).toEqual(["calendar", "dataview"]);
    expect(updated).toContain("!.obsidian/plugins/calendar/**");
    expect(updated).toContain("!.obsidian/plugins/dataview/**");
    expect(updated).toContain("notes/*.tmp\n");
    expect(updated).not.toContain("!.obsidian/plugins/team-core/");
    const migrated = updateSharedPluginsInGitignore(".obsidian/\nassets/\n", ".obsidian", ["calendar"]);
    expect(migrated.split("\n")).not.toContain(".obsidian/");
    expect(() => updateSharedPluginsInGitignore(content, ".obsidian", ["../secret"])).toThrow();
    expect(mergeSharedPluginIds(["calendar"], ["calendar", "dataview"], ["calendar", "templater-obsidian"])).toEqual(["calendar", "dataview", "templater-obsidian"]);
    expect(mergeSharedPluginIds(["calendar"], [], ["calendar"])).toEqual([]);
    expect(parseSharedPluginState(serializeSharedPluginState(["calendar"]))).toEqual(["calendar"]);
    expect(mergeSharedPluginState(["calendar"], ["calendar", "dataview"], ["calendar", "templater-obsidian"])).toBe(serializeSharedPluginState(["calendar", "dataview", "templater-obsidian"]));
  });

  it("applies shared plugin enablement while preserving personal plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-plugin-state-"));
    try {
      const vault = new NodeVault(root);
      await vault.write(".obsidian/community-plugins.json", encode("[\"team-core\", \"personal-plugin\", \"calendar\"]"));
      await applySharedPluginState(vault, ".obsidian", ["calendar", "dataview"], ["dataview"]);
      expect(JSON.parse(decode(await vault.read(".obsidian/community-plugins.json")))).toEqual(["team-core", "personal-plugin", "dataview"]);
      await writeSharedPluginState(vault, ["calendar"]);
      expect(await readSharedPluginState(vault)).toEqual(["calendar"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tracks S3 attachments and only whitelisted configuration paths", () => {
    expect(shouldTrackVaultEvent("assets/new-image.png", ".obsidian", [])).toBe(true);
    expect(shouldTrackVaultEvent("notes/readme.md", ".obsidian", [])).toBe(true);
    expect(shouldTrackVaultEvent(".obsidian/plugins/calendar/main.js", ".obsidian", ["calendar"])).toBe(true);
    expect(shouldTrackVaultEvent(".obsidian/plugins/dataview/main.js", ".obsidian", ["calendar"])).toBe(false);
    expect(shouldTrackVaultEvent(".obsidian/plugins/team-core/data.json", ".obsidian", ["team-core"])).toBe(false);
    expect(shouldTrackVaultEvent("私人笔记/private.md", ".obsidian", [])).toBe(false);
    expect(shouldTrackVaultEvent(".team/assets-manifest.json", ".obsidian", [])).toBe(false);
    expect(shouldTrackVaultEvent(".team/file-authors.json", ".obsidian", [])).toBe(true);
  });

  it("publishes private drafts only when they move into a synchronized public path", () => {
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", "notes/draft.md", "md", ".obsidian", [])).toBe(true);
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", ".obsidian/plugins/calendar/draft.md", "md", ".obsidian", ["calendar"])).toBe(true);
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", ".trash/draft.md", "md", ".obsidian", [])).toBe(false);
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", ".obsidian/draft.md", "md", ".obsidian", [])).toBe(false);
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", ".obsidian/plugins/personal/draft.md", "md", ".obsidian", [])).toBe(false);
    expect(shouldPublishPrivateDraftRename("私人笔记/draft.md", "notes/draft.txt", "txt", ".obsidian", [])).toBe(false);
  });

  it("consumes one pending generation without dropping later events for the same path", () => {
    const pending = new Set(["notes/a.md", "assets/a.png"]);
    expect([...takePendingPaths(pending)].sort()).toEqual(["assets/a.png", "notes/a.md"]);
    expect(pending.size).toBe(0);
    pending.add("notes/a.md");
    expect([...pending]).toEqual(["notes/a.md"]);
  });

  it("normalizes attachments moved into public note folders without publishing local-only moves", () => {
    expect(shouldNormalizeMovedAttachment("assets/image.png", "notes/image.png", ".obsidian")).toBe(true);
    expect(shouldNormalizeMovedAttachment("私人笔记/assets/image.png", "drafts/image.png", ".obsidian")).toBe(true);
    expect(shouldNormalizeMovedAttachment("assets/image.png", "私人笔记/assets/image.png", ".obsidian")).toBe(false);
    expect(shouldNormalizeMovedAttachment("assets/image.png", ".trash/image.png", ".obsidian")).toBe(false);
    expect(shouldNormalizeMovedAttachment("assets/image.png", ".obsidian/plugins/personal/image.png", ".obsidian")).toBe(false);
  });

  it("uses a distinct SHA-256 attachment prefix and preserves link decorations when renaming", () => {
    const hash = "a".repeat(64);
    const destination = assetPathForHash(hash, "PNG");
    expect(destination).toBe(`assets/tc-sha256-${hash}.png`);
    expect(hashFromAssetPath(destination)).toBe(hash);
    expect(hashFromAssetPath(`assets/${hash}.png`)).toBeUndefined();
    expect(legacyHashFromAssetPath(`assets/${hash}.png`)).toBe(hash);
    expect(legacyHashFromAssetPath(`assets/${hash.toUpperCase()}.png`)).toBe(hash);
    expect(hashFromAssetPath("assets/not-a-hash.png")).toBeUndefined();
    expect(hashFromAssetPath(`assets/tc-sha256-${"a".repeat(63)}.png`)).toBeUndefined();
    expect(hashFromAssetPath(`assets/tc-sha256-${"A".repeat(64)}.png`)).toBeUndefined();
    expect(hashFromAssetPath(`assets/tc-sha256-${hash}.bad extension`)).toBeUndefined();
    expect(hashFromAssetPath(`assets/not-tc-sha256-${hash}.png`)).toBeUndefined();
    expect(legacyHashFromAssetPath(`assets/${hash}.bad extension`)).toBeUndefined();

    const markdown = [
      "![[assets/Pasted image.png|width=400]]",
      "[[../assets/Pasted image.png#page=2|Open PDF]]",
      "![image](../assets/Pasted image.png#page=3)",
      "![other](assets/other.png)"
    ].join("\n");
    expect(rewriteAssetReferences(markdown, "notes/readme.md", "assets/Pasted image.png", destination)).toBe([
      `![[assets/tc-sha256-${hash}.png|width=400]]`,
      `[[../assets/tc-sha256-${hash}.png#page=2|Open PDF]]`,
      `![image](../assets/tc-sha256-${hash}.png#page=3)`,
      "![other](assets/other.png)"
    ].join("\n"));
  });

  it("plans private draft publication without breaking attachments shared by other drafts", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-publication-"));
    try {
      const vault = new NodeVault(root);
      const sourcePath = "私人笔记/assets/draft image.png";
      const data = encode("private image bytes");
      await vault.write(sourcePath, data);
      const hash = await sha256Hex(data);
      const targetPath = `assets/tc-sha256-${hash}.png`;
      const markdown = [
        "![[私人笔记/assets/draft image.png|320]]",
        "![draft](私人笔记/assets/draft%20image.png#preview)"
      ].join("\n");

      const shared = await planPrivateDraftPublication(vault, markdown, "私人笔记/draft.md", "notes/draft.md", [{
        path: "私人笔记/other.md",
        content: "![[私人笔记/assets/draft image.png]]"
      }]);
      expect(shared.attachments).toHaveLength(1);
      expect(shared.attachments[0]).toMatchObject({ sourcePath, targetPath, createTarget: true, removeSource: false });
      expect(shared.markdown).toBe([
        `![[../${targetPath}|320]]`,
        `![draft](../${targetPath}#preview)`
      ].join("\n"));

      await vault.write(targetPath, data);
      const lastReference = await planPrivateDraftPublication(vault, markdown, "私人笔记/draft.md", "notes/draft.md", []);
      expect(lastReference.attachments[0]).toMatchObject({ targetPath, createTarget: false, removeSource: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to publish a draft whose private attachment is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-publication-missing-"));
    try {
      const vault = new NodeVault(root);
      await vault.mkdir("");
      await expect(planPrivateDraftPublication(
        vault,
        "![[私人笔记/assets/missing.pdf]]",
        "私人笔记/draft.md",
        "draft.md",
        []
      )).rejects.toThrow("私人附件不存在");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans public note privatization without breaking attachments shared by public notes", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-note-privatization-"));
    try {
      const vault = new NodeVault(root);
      const data = encode("public attachment bytes");
      const hash = await sha256Hex(data);
      const sourcePath = `assets/tc-sha256-${hash}.pdf`;
      const targetPath = `私人笔记/assets/tc-sha256-${hash}.pdf`;
      await vault.write(sourcePath, data);
      const markdown = `![document](../${sourcePath}#page=2)`;

      const shared = await planPublicNotePrivatization(vault, markdown, "notes/public.md", "私人笔记/public.md", [{
        path: "notes/other.md",
        content: `![[${sourcePath}|Open]]`
      }]);
      expect(shared.attachments).toHaveLength(1);
      expect(shared.attachments[0]).toMatchObject({ sourcePath, targetPath, createTarget: true, removeSource: false });
      expect(shared.markdown).toBe(`![document](${targetPath}#page=2)`);

      const privateReference = await planPublicNotePrivatization(vault, markdown, "notes/public.md", "私人笔记/public.md", [{
        path: "私人笔记/draft.md",
        content: `![[${sourcePath}|Draft attachment]]`
      }]);
      expect(privateReference.attachments[0]).toMatchObject({ sourcePath, removeSource: false });

      await vault.write(targetPath, data);
      const lastReference = await planPublicNotePrivatization(vault, markdown, "notes/public.md", "私人笔记/public.md", []);
      expect(lastReference.attachments[0]).toMatchObject({ sourcePath, targetPath, createTarget: false, removeSource: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("S3 transport", () => {
  it("downloads ranged chunks with incremental verification", async () => {
    const data = new TextEncoder().encode("0123456789abcdefghijklmnopqrstuv");
    const hash = await sha256Hex(data);
    const ranges: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(200, { "content-length": String(data.byteLength) });
        response.end();
        return;
      }
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (!range) { response.writeHead(416); response.end(); return; }
      const start = Number(range[1]);
      const end = Number(range[2]);
      ranges.push(`${start}-${end}`);
      response.writeHead(206, {
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${data.byteLength}`
      });
      response.end(data.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve S3 test server port");
    try {
      const chunks: Uint8Array[] = [];
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      await transport.downloadInChunks(hash, data.byteLength, async (chunk) => { chunks.push(new Uint8Array(chunk)); }, 8);
      expect(ranges).toEqual(["0-7", "8-15", "16-23", "24-31"]);
      expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(data));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps the production chunk size at 8 MiB", () => {
    expect(S3_DOWNLOAD_CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(S3_CHUNKED_DOWNLOAD_THRESHOLD).toBe(S3_DOWNLOAD_CHUNK_SIZE);
  });

  it("uses immutable content-addressed object keys", () => {
    const transport = new S3Transport(settings(), { debug() {}, warn() {}, error() {} });
    expect(transport.enabled()).toBe(true);
    expect(transport.objectKey("A".repeat(64))).toBe("vault/sha256/" + "a".repeat(64));
    expect(transport.objectUrl("A".repeat(64))).toBe("https://s3.example.test/team-kb/vault/sha256/" + "a".repeat(64));
    expect(transport.managedObjectPrefix()).toBe("vault/sha256/");
    expect(() => transport.objectKey("not-a-hash")).toThrow("hash");
  });

  it("does not repeat a bucket already present in a virtual-hosted endpoint", () => {
    const transport = new S3Transport(settings({ s3Endpoint: "https://team-kb.s3.example.test/" }), { debug() {}, warn() {}, error() {} });
    expect(transport.objectUrl("a".repeat(64))).toBe("https://team-kb.s3.example.test/vault/sha256/" + "a".repeat(64));
  });
});

describe("remote attachment materialization", () => {
  const entry = {
    sha256: "a".repeat(64),
    size: 10,
    mime: "image/png",
    uploadedAt: "2026-08-28T00:00:00.000Z",
    uploadedBy: "wangzhe"
  };

  it("retries an unchanged manifest entry when the local attachment is missing", () => {
    expect(shouldMaterializeRemoteAttachment(entry, entry, false)).toBe(true);
    expect(shouldMaterializeRemoteAttachment(entry, entry, true)).toBe(false);
  });

  it("downloads a missing same-user attachment but protects an existing mismatched file", () => {
    expect(shouldProtectMismatchedLocalAttachment(false, "wangzhe", "wangzhe")).toBe(false);
    expect(shouldProtectMismatchedLocalAttachment(true, "wangzhe", "wangzhe")).toBe(true);
    expect(shouldProtectMismatchedLocalAttachment(true, "other-user", "wangzhe")).toBe(false);
  });
});

describe("sync push reconciliation", () => {
  const rejected = () => Object.assign(new Error("Push rejected because it was not a simple fast-forward. Use force true to override."), {
    code: "PushRejectedError",
    data: { reason: "not-fast-forward" }
  });

  it("recognizes structured and legacy non-fast-forward errors", () => {
    expect(isNonFastForwardPushError(rejected())).toBe(true);
    expect(isNonFastForwardPushError(new Error("Push rejected because it was not a simple fast-forward."))).toBe(true);
    expect(isNonFastForwardPushError(new Error("authentication failed"))).toBe(false);
    expect(isPushReconciliationError({ code: "NotFoundError", caller: "git.push", data: { what: "a".repeat(40) } })).toBe(true);
    expect(isPushReconciliationError({ code: "NotFoundError", caller: "git.fetch", data: { what: "a".repeat(40) } })).toBe(false);
    expect(conflictFilesFromError({ data: { filepaths: ["b.md", "a.md", "a.md"] } })).toEqual(["a.md", "b.md"]);
  });

  it("fetches, merges, and retries a racing push at most twice", async () => {
    let pushes = 0;
    const attempts: number[] = [];
    const result = await pushWithNonFastForwardRetry(
      async () => { pushes += 1; if (pushes < 3) throw rejected(); },
      async (attempt) => { attempts.push(attempt); return { conflicts: [], deferred: false }; }
    );
    expect(result).toEqual({ conflicts: [], deferred: false });
    expect(pushes).toBe(3);
    expect(attempts).toEqual([1, 2]);

    pushes = 0;
    await expect(pushWithNonFastForwardRetry(
      async () => { pushes += 1; throw rejected(); },
      async () => ({ conflicts: [], deferred: false })
    )).rejects.toMatchObject({ code: "PushRejectedError" });
    expect(pushes).toBe(3);
  });

  it("stops before another push when reconciliation finds a conflict", async () => {
    let pushes = 0;
    const result = await pushWithNonFastForwardRetry(
      async () => { pushes += 1; throw rejected(); },
      async () => ({ conflicts: ["shared.md"], deferred: false })
    );
    expect(result).toEqual({ conflicts: ["shared.md"], deferred: false });
    expect(pushes).toBe(1);
  });
});

describe("Git repository adapter", () => {
  it("stages every file in selected plugin folders and keeps unselected folders local", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-plugins-"));
    try {
      const vault = new NodeVault(root);
      const shared = new GitRepository(vault, settings(), logger, ".obsidian", ["calendar"]);
      await shared.init();
      await shared.ensureRemote();
      await shared.ensureGitignore();
      await vault.write(".obsidian/plugins/calendar/main.js", encode("calendar"));
      await vault.write(".obsidian/plugins/calendar/manifest.json", encode("{}"));
      await vault.write(".obsidian/plugins/calendar/styles.css", encode(".x{}"));
      await vault.write(".obsidian/plugins/calendar/data.json", encode("{}"));
      await vault.write(".obsidian/plugins/calendar/extra.bin", encode("extra"));
      await vault.write(".obsidian/plugins/dataview/main.js", encode("personal"));
      await vault.write(".obsidian/plugins/team-core/data.json", encode("secret"));
      const generatedIgnore = decode(await vault.read(".gitignore"));
      expect(generatedIgnore).toContain(".obsidian/plugins/*\n");
      expect(generatedIgnore).toContain("!.obsidian/plugins/calendar/**\n");
      await shared.commit("Shared plugin");
      const files = await git.listFiles({ fs: shared.fs, dir: "", ref: "HEAD" });
      expect(files).toEqual(expect.arrayContaining([
        ".obsidian/plugins/calendar/main.js",
        ".obsidian/plugins/calendar/manifest.json",
        ".obsidian/plugins/calendar/styles.css",
        ".obsidian/plugins/calendar/data.json",
        ".obsidian/plugins/calendar/extra.bin"
      ]));
      expect(files).not.toContain(".obsidian/plugins/dataview/main.js");
      expect(files).not.toContain(".obsidian/plugins/team-core/data.json");

      const personal = new GitRepository(vault, settings(), logger, ".obsidian", []);
      await personal.ensureGitignore();
      expect(await personal.hasUncommittedChanges()).toBe(true);
      await personal.commit("Make plugin personal");
      const after = await git.listFiles({ fs: personal.fs, dir: "", ref: "HEAD" });
      expect(after.some((path) => path.startsWith(".obsidian/plugins/calendar/"))).toBe(false);
      expect(await vault.exists(".obsidian/plugins/calendar/main.js")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes, commits, reports history, and detects working-tree changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-git-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await repo.ensureRemote();
      await repo.ensureGitignore();
      const gitignore = new TextDecoder().decode(await vault.read(".gitignore"));
      expect(gitignore).toContain("私人笔记/\n");
      expect(gitignore).toContain(".trash/\n");
      expect(gitignore).not.toContain("Private/\n");
      await vault.write("notes/readme.md", new TextEncoder().encode("first\n").buffer);
      await vault.write("私人笔记/秘密.md", new TextEncoder().encode("never sync\n").buffer);

      const first = await repo.commit("Initial vault");
      expect(first).toMatch(/^[0-9a-f]{40}$/);
      expect(await repo.hasUncommittedChanges()).toBe(false);

      // Older clients could leave a private path with a missing blob in the
      // Git index. It must not make an otherwise valid sync fail.
      await execFileAsync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `100644,${"a".repeat(40)},私人笔记/旧索引.md`]);
      await expect(repo.hasUncommittedChanges()).resolves.toBe(false);
      await expect(repo.log("私人笔记/旧索引.md")).resolves.toEqual([]);
      await expect(repo.fileAuthors("私人笔记/旧索引.md")).resolves.toEqual([]);
      expect(await repo.commit("Private note must stay local")).toBeUndefined();

      await vault.write("notes/readme.md", new TextEncoder().encode("second\n").buffer);
      expect(await repo.hasUncommittedChanges()).toBe(true);
      const second = await repo.commit("Update note");
      expect(second).toMatch(/^[0-9a-f]{40}$/);

      const history = await repo.log("notes/readme.md", 10);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ message: "Update note", author: "Alice.Example", email: "alice.example@knowledgebase.local" });
      expect(history[0].parents).toEqual([first]);
      expect(await repo.fileAuthors("notes/readme.md")).toEqual(["Alice.Example"]);

      await vault.write("notes/readme.md", new TextEncoder().encode("third\n").buffer);
      const secondAuthor = new GitRepository(vault, settings({ gitUsername: "Bob.Example" }), logger, ".obsidian");
      await secondAuthor.commit("Second author update");
      expect(await secondAuthor.fileAuthors("notes/readme.md")).toEqual(["Alice.Example", "Bob.Example"]);
      expect((await secondAuthor.fileAuthorsIndex()).get("notes/readme.md")).toEqual(["Bob.Example", "Alice.Example"]);
      expect((await secondAuthor.fileAuthorsIndex()).has("私人笔记/秘密.md")).toBe(false);
      expect(await secondAuthor.fileAuthors("notes/missing.md")).toEqual([]);
      expect(await secondAuthor.logSince(Date.now() - 60_000)).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a private draft publication path out of an in-flight commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-git-draft-exclusion-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("draft.md", encode("draft base\n"));
      await vault.write("normal.md", encode("normal base\n"));
      await repo.commit("Base");

      await vault.write("draft.md", encode("draft publishing\n"));
      await vault.write("normal.md", encode("normal changed\n"));
      expect(await repo.commit("Normal only", ["draft.md"])).toMatch(/^[0-9a-f]{40}$/);
      const head = await git.resolveRef({ fs: repo.fs, dir: "", ref: "HEAD" });
      expect(new TextDecoder().decode((await git.readBlob({ fs: repo.fs, dir: "", oid: head, filepath: "draft.md" })).blob)).toBe("draft base\n");
      expect(new TextDecoder().decode((await git.readBlob({ fs: repo.fs, dir: "", oid: head, filepath: "normal.md" })).blob)).toBe("normal changed\n");
      expect(await repo.hasUncommittedChanges()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not leave selected plugin files as local changes after a clean remote merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-plugin-merge-state-"));
    try {
      const vault = new NodeVault(root);
      const sharedIds = ["calendar"];
      const repo = new GitRepository(vault, settings(), logger, ".obsidian", sharedIds);
      await repo.init();
      await repo.ensureGitignore();
      await vault.write(".obsidian/plugins/calendar/main.js", encode("calendar\n"));
      await repo.commit("Base plugin");
      await git.branch({ fs: repo.fs, dir: "", ref: "remote" });

      await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
      await vault.write(".obsidian/plugins/calendar/main.js", encode("calendar\n"));
      await vault.write("remote.md", encode("remote\n"));
      const remoteCommit = await repo.commit("Remote note");
      if (!remoteCommit) throw new Error("Expected a remote commit");

      await git.checkout({ fs: repo.fs, dir: "", ref: "main" });
      await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit, force: true });
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      expect(await repo.hasUncommittedChanges()).toBe(false);
      expect(await vault.exists(".obsidian/plugins/calendar/main.js")).toBe(true);
      expect(await vault.exists("remote.md")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a remote merge tree containing local-only configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-forbidden-merge-tree-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("base.md", encode("base\n"));
      await repo.commit("Base");
      await git.branch({ fs: repo.fs, dir: "", ref: "remote" });
      await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
      await vault.write(".obsidian/app.json", encode("remote config\n"));
      await git.add({ fs: repo.fs, dir: "", filepath: ".obsidian/app.json" });
      const remoteCommit = await git.commit({
        fs: repo.fs,
        dir: "",
        message: "Forbidden remote config",
        author: { name: "Remote", email: "remote@example.test" }
      });
      await git.checkout({ fs: repo.fs, dir: "", ref: "main", force: true });
      await vault.write(".obsidian/app.json", encode("local config\n"));
      await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit, force: true });

      await expect(repo.mergeRemote()).rejects.toThrow("禁止同步路径");
      expect(decode(await vault.read(".obsidian/app.json"))).toBe("local config\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("untracks legacy forbidden paths without deleting their local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-untrack-forbidden-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      const paths = ["私人笔记/private.md", "assets/image.png", ".trash/deleted.md", ".obsidian/app.json", ".obsidian/plugins/team-core/data.json"];
      for (const path of paths) {
        await vault.write(path, encode(path));
        await git.add({ fs: repo.fs, dir: "", filepath: path });
      }
      await git.commit({ fs: repo.fs, dir: "", message: "Legacy forbidden paths", author: { name: "Old client", email: "old@example.test" } });

      expect(await repo.commit("Remove forbidden paths from Git")).toMatch(/^[0-9a-f]{40}$/);
      expect(await git.listFiles({ fs: repo.fs, dir: "", ref: "HEAD" })).toEqual([]);
      for (const path of paths) expect(await vault.exists(path)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("semantically merges independent public-plugin enablement changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-plugin-state-merge-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian", ["calendar", "dataview", "templater-obsidian"]);
      await repo.init();
      await writeSharedPluginState(vault, ["calendar"]);
      await repo.commit("Base plugin state");
      await git.branch({ fs: repo.fs, dir: "", ref: "remote" });

      await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
      await writeSharedPluginState(vault, ["calendar", "dataview"]);
      const remoteCommit = await repo.commit("Remote plugin state");
      if (!remoteCommit) throw new Error("Expected a remote commit");

      await git.checkout({ fs: repo.fs, dir: "", ref: "main" });
      await writeSharedPluginState(vault, ["calendar", "templater-obsidian"]);
      await repo.commit("Local plugin state");
      await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit, force: true });
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      expect(await readSharedPluginState(vault)).toEqual(["calendar", "dataview", "templater-obsidian"]);
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a diverged local branch and materializes the merged tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-merge-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();

      await vault.write("base.md", new TextEncoder().encode("base\n").buffer);
      await repo.commit("Base");
      await git.branch({ fs: repo.fs, dir: "", ref: "remote" });

      await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
      await vault.write("remote.md", new TextEncoder().encode("remote\n").buffer);
      const remoteCommit = await repo.commit("Remote change");
      expect(remoteCommit).toMatch(/^[0-9a-f]{40}$/);

      await git.checkout({ fs: repo.fs, dir: "", ref: "main" });
      await vault.write("local.md", new TextEncoder().encode("local\n").buffer);
      const localCommit = await repo.commit("Local change");
      expect(localCommit).toMatch(/^[0-9a-f]{40}$/);
      await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit, force: true });

      const result = await repo.mergeRemote();
      expect(result).toEqual({ merged: true, conflicts: [] });
      expect(await git.resolveRef({ fs: repo.fs, dir: "", ref: "HEAD" })).not.toBe(localCommit);
      expect(new TextDecoder().decode(await vault.read("remote.md"))).toBe("remote\n");
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "same line changed differently",
      base: { "shared.md": "title\nbase\nend\n" },
      local: { "shared.md": "title\nlocal\nend\n" },
      remote: { "shared.md": "title\nremote\nend\n" },
      conflict: true
    },
    {
      name: "local modification and remote deletion",
      base: { "shared.md": "base\n", "anchor.md": "anchor\n" },
      local: { "shared.md": "local\n" },
      remote: { "shared.md": null },
      conflict: true
    },
    {
      name: "local deletion and remote modification",
      base: { "shared.md": "base\n", "anchor.md": "anchor\n" },
      local: { "shared.md": null },
      remote: { "shared.md": "remote\n" },
      conflict: true
    },
    {
      name: "same path added with different content",
      base: { "anchor.md": "anchor\n" },
      local: { "shared.md": "local\n" },
      remote: { "shared.md": "remote\n" },
      conflict: true
    },
    {
      name: "same path added with identical content",
      base: { "anchor.md": "anchor\n" },
      local: { "shared.md": "same\n" },
      remote: { "shared.md": "same\n" },
      conflict: false
    },
    {
      name: "different regions of one file",
      base: { "shared.md": "start\nbase one\nmiddle a\nmiddle b\nbase two\nend\n" },
      local: { "shared.md": "start\nlocal one\nmiddle a\nmiddle b\nbase two\nend\n" },
      remote: { "shared.md": "start\nbase one\nmiddle a\nmiddle b\nremote two\nend\n" },
      conflict: false
    }
  ])("handles $name conservatively", async ({ base, local, remote, conflict }) => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-"));
    try {
      const { vault, repo, localCommit, remoteCommit } = await createDivergence(root, base, local, remote);
      const result = await repo.mergeRemote();
      if (!conflict) {
        expect(result.conflicts).toEqual([]);
        expect(await repo.conflictedFiles()).toEqual([]);
        expect(await repo.hasUncommittedChanges()).toBe(false);
        return;
      }

      expect(result).toEqual({ merged: false, conflicts: ["shared.md"] });
      expect(await git.resolveRef({ fs: repo.fs, dir: "", ref: "HEAD" })).toBe(localCommit);
      expect(await repo.hasUncommittedChanges()).toBe(false);
      if (local["shared.md"] === null) expect(await vault.exists("shared.md")).toBe(false);
      else expect(decode(await vault.read("shared.md"))).toBe(local["shared.md"]);

      const reloaded = new GitRepository(vault, settings(), logger, ".obsidian");
      expect(await reloaded.conflictedFiles()).toEqual(["shared.md"]);
      expect(await reloaded.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });
      expect(await reloaded.commit("Must not commit a blocked conflict")).toBeUndefined();
      expect(await git.resolveRef({ fs: reloaded.fs, dir: "", ref: "HEAD" })).toBe(localCommit);

      await git.commit({
        fs: reloaded.fs,
        dir: "",
        message: "Resolve conflict externally",
        parent: [localCommit, remoteCommit],
        author: { name: "Resolver", email: "resolver@example.test" },
        committer: { name: "Resolver", email: "resolver@example.test" }
      });
      expect(await reloaded.conflictedFiles()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads all three conflict versions and creates a two-parent custom resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-editor-"));
    try {
      const { vault, repo, localCommit, remoteCommit } = await createDivergence(
        root,
        { "shared.md": "title\nbase\n" },
        { "shared.md": "title\nlocal\n" },
        { "shared.md": "title\nremote\n" }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });

      const session = await repo.getConflictEditorSession();
      expect(session).toMatchObject({
        localOid: localCommit,
        remoteOid: remoteCommit,
        files: [{ path: "shared.md", base: "title\nbase\n", local: "title\nlocal\n", remote: "title\nremote\n" }]
      });
      expect(session.baseOid).toMatch(/^[0-9a-f]{40}$/);
      await expect(repo.resolveConflicts([])).rejects.toThrow("每个冲突文件");

      const oid = await repo.resolveConflicts([{ path: "shared.md", content: "title\ncombined\n" }]);
      const commit = await git.readCommit({ fs: repo.fs, dir: "", oid });
      expect(commit.commit.parent).toEqual([localCommit, remoteCommit]);
      expect(commit.commit.message.trim()).toBe("Resolve synchronization conflicts");
      expect(decode(await vault.read("shared.md"))).toBe("title\ncombined\n");
      expect(await repo.conflictedFiles()).toEqual([]);
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps non-conflicting remote files when resolving one conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-remote-files-"));
    try {
      const { vault, repo, localCommit, remoteCommit } = await createDivergence(
        root,
        { "shared.md": "title\nbase\n" },
        { "shared.md": "title\nlocal\n" },
        { "shared.md": "title\nremote\n", "remote-only.md": "must survive\n" }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });
      const oid = await repo.resolveConflicts([{ path: "shared.md", content: "title\ncombined\n" }]);
      expect(decode(await vault.read("remote-only.md"))).toBe("must survive\n");
      expect((await git.readCommit({ fs: repo.fs, dir: "", oid })).commit.parent).toEqual([localCommit, remoteCommit]);
      expect((await git.listFiles({ fs: repo.fs, dir: "", ref: "HEAD" }))).toContain("remote-only.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("semantically merges independent public-plugin whitelist changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-gitignore-merge-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      const base = updateSharedPluginsInGitignore("assets/\n私人笔记/\n", ".obsidian", []);
      await vault.write(".gitignore", encode(base));
      await repo.commit("Base ignore");
      await git.branch({ fs: repo.fs, dir: "", ref: "remote" });
      await git.checkout({ fs: repo.fs, dir: "", ref: "remote" });
      await vault.write(".gitignore", encode(updateSharedPluginsInGitignore(base, ".obsidian", ["calendar"])));
      const remoteCommit = await repo.commit("Remote public plugin");
      await git.checkout({ fs: repo.fs, dir: "", ref: "main" });
      await vault.write(".gitignore", encode(updateSharedPluginsInGitignore(base, ".obsidian", ["dataview"])));
      await repo.commit("Local public plugin");
      await git.writeRef({ fs: repo.fs, dir: "", ref: "refs/remotes/origin/main", value: remoteCommit!, force: true });
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      expect(readSharedPluginIdsFromGitignore(decode(await vault.read(".gitignore")), ".obsidian")).toEqual(["calendar", "dataview"]);
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("represents deleted conflict sides and can resolve by deleting the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-delete-"));
    try {
      const { vault, repo, localCommit, remoteCommit } = await createDivergence(
        root,
        { "shared.md": "base\n", "anchor.md": "anchor\n" },
        { "shared.md": "local\n" },
        { "shared.md": null }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });
      expect((await repo.getConflictEditorSession()).files[0]).toEqual({
        path: "shared.md",
        base: "base\n",
        local: "local\n",
        remote: undefined
      });

      const oid = await repo.resolveConflicts([{ path: "shared.md", content: undefined }]);
      expect(await vault.exists("shared.md")).toBe(false);
      expect((await git.readCommit({ fs: repo.fs, dir: "", oid })).commit.parent).toEqual([localCommit, remoteCommit]);
      await expect(git.readBlob({ fs: repo.fs, dir: "", oid, filepath: "shared.md" })).rejects.toMatchObject({ code: "NotFoundError" });
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("can keep a local deletion when the remote side modified the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-keep-delete-"));
    try {
      const { vault, repo } = await createDivergence(
        root,
        { "shared.md": "base\n", "anchor.md": "anchor\n" },
        { "shared.md": null },
        { "shared.md": "remote\n" }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });
      expect((await repo.getConflictEditorSession()).files[0]).toMatchObject({ local: undefined, remote: "remote\n" });
      await repo.resolveConflicts([{ path: "shared.md", content: undefined }]);
      expect(await vault.exists("shared.md")).toBe(false);
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale conflict sessions after HEAD changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-stale-"));
    try {
      const { repo, localCommit } = await createDivergence(
        root,
        { "shared.md": "base\n" },
        { "shared.md": "local\n" },
        { "shared.md": "remote\n" }
      );
      await repo.mergeRemote();
      await git.commit({
        fs: repo.fs,
        dir: "",
        message: "Unexpected local commit",
        parent: [localCommit],
        author: { name: "Test", email: "test@example.test" },
        committer: { name: "Test", email: "test@example.test" }
      });
      await expect(repo.getConflictEditorSession()).rejects.toThrow("本地提交已变化");
      await expect(repo.resolveConflicts([{ path: "shared.md", content: "combined\n" }])).rejects.toThrow("本地提交已变化");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflict resolution when the worktree changed after the conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-dirty-worktree-"));
    try {
      const { vault, repo } = await createDivergence(
        root,
        { "shared.md": "base\n", "other.md": "unchanged\n" },
        { "shared.md": "local\n" },
        { "shared.md": "remote\n" }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: ["shared.md"] });
      await vault.write("other.md", encode("edited while resolving\n"));
      await expect(repo.resolveConflicts([{ path: "shared.md", content: "combined\n" }])).rejects.toThrow("本地文件又有修改");
      expect(decode(await vault.read("other.md"))).toBe("edited while resolving\n");
      expect(await repo.conflictedFiles()).toEqual(["shared.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates attachment manifest resolutions before changing the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-conflict-manifest-editor-"));
    const entry = (hash: string, uploadedBy: string) => ({ sha256: hash.repeat(64), size: 10, mime: "image/png", uploadedAt: "2026-08-28T00:00:00.000Z", uploadedBy });
    try {
      const base = serializeManifest(createEmptyManifest());
      const local = serializeManifest(validateManifest({ version: 1, files: { "assets/shared.png": entry("a", "alice") } }));
      const remote = serializeManifest(validateManifest({ version: 1, files: { "assets/shared.png": entry("b", "bob") } }));
      const { vault, repo } = await createDivergence(
        root,
        { ".team/assets-manifest.json": base },
        { ".team/assets-manifest.json": local },
        { ".team/assets-manifest.json": remote }
      );
      expect(await repo.mergeRemote()).toEqual({ merged: false, conflicts: [".team/assets-manifest.json"] });
      await expect(repo.resolveConflicts([{ path: ".team/assets-manifest.json", content: "not json" }])).rejects.toThrow("附件清单格式无效");
      await expect(repo.resolveConflicts([{ path: ".team/assets-manifest.json", content: undefined }])).rejects.toThrow("附件清单不能删除");
      expect(decode(await vault.read(".team/assets-manifest.json"))).toBe(local);
      expect(await repo.conflictedFiles()).toEqual([".team/assets-manifest.json"]);

      await repo.resolveConflicts([{ path: ".team/assets-manifest.json", content: remote }]);
      expect(validateManifest(JSON.parse(decode(await vault.read(".team/assets-manifest.json"))))).toEqual(JSON.parse(remote));
      expect(await repo.conflictedFiles()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges independent attachment manifest entries without a text conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-manifest-merge-"));
    const entry = (hash: string, uploadedBy: string) => ({ sha256: hash.repeat(64), size: 10, mime: "image/png", uploadedAt: "2026-08-28T00:00:00.000Z", uploadedBy });
    try {
      const base = serializeManifest(createEmptyManifest());
      const local = serializeManifest(validateManifest({ version: 1, files: { "assets/local.png": entry("a", "alice") } }));
      const remote = serializeManifest(validateManifest({ version: 1, files: { "assets/remote.png": entry("b", "bob") } }));
      const { vault, repo } = await createDivergence(root, { ".team/assets-manifest.json": base }, { ".team/assets-manifest.json": local }, { ".team/assets-manifest.json": remote });
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      const merged = validateManifest(JSON.parse(decode(await vault.read(".team/assets-manifest.json"))));
      expect(Object.keys(merged.files).sort()).toEqual(["assets/local.png", "assets/remote.png"]);
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a legacy bootstrap shared-plugin state during remote clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-clone-bootstrap-"));
    const bare = join(root, "repo.git");
    const seed = join(root, "seed");
    const local = join(root, "local");
    let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
    try {
      await runGit(["init", "--bare", bare]);
      await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
      await mkdir(seed);
      await runGit(["init"], seed);
      await runGit(["checkout", "-b", "main"], seed);
      await runGit(["config", "user.name", "Seed"], seed);
      await runGit(["config", "user.email", "seed@example.test"], seed);
      await mkdir(join(seed, ".team"));
      const remoteState = serializeSharedPluginState(["calendar"]);
      await writeFile(join(seed, ".team", "shared-plugins.json"), remoteState);
      await writeFile(join(seed, ".gitignore"), updateSharedPluginsInGitignore("assets/\n私人笔记/\n", ".obsidian", ["calendar"]));
      await mkdir(join(seed, ".obsidian", "plugins", "calendar"), { recursive: true });
      await writeFile(join(seed, ".obsidian", "plugins", "calendar", "main.js"), "remote calendar\n");
      await runGit(["add", ".team/shared-plugins.json", ".gitignore", ".obsidian/plugins/calendar/main.js"], seed);
      await runGit(["commit", "-m", "Shared plugin state"], seed);
      await runGit(["remote", "add", "origin", bare], seed);
      await runGit(["push", "origin", "main"], seed);

      server = await startGitHttpServer(root, async () => undefined);
      const vault = new NodeVault(local);
      await vault.mkdir("");
      await vault.write(".team/shared-plugins.json", encode(serializeSharedPluginState([])));
      await vault.write(".obsidian/plugins/calendar/main.js", encode("local calendar\n"));
      await vault.write(".obsidian/plugins/personal/main.js", encode("personal plugin\n"));
      const repo = new GitRepository(vault, settings({ gitUrl: server.url }), logger, ".obsidian");
      const progressEvents: Array<{ phase: string; loaded: number; total: number }> = [];
      await repo.clone((progress) => {
        progressEvents.push(progress);
      });

      expect(decode(await vault.read(".team/shared-plugins.json"))).toBe(remoteState);
      expect(decode(await vault.read(".obsidian/plugins/calendar/main.js"))).toBe("remote calendar\n");
      expect(decode(await vault.read(".obsidian/plugins/personal/main.js"))).toBe("personal plugin\n");
      expect(await repo.hasUncommittedChanges()).toBe(false);
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents.some(({ loaded, total }) => total > 0 && loaded >= 0 && loaded <= total)).toBe(true);
    } finally {
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a clone that tracks local-only Obsidian configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-clone-forbidden-tree-"));
    const bare = join(root, "repo.git");
    const seed = join(root, "seed");
    const local = join(root, "local");
    let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
    try {
      await runGit(["init", "--bare", bare]);
      await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
      await mkdir(seed);
      await runGit(["init"], seed);
      await runGit(["checkout", "-b", "main"], seed);
      await runGit(["config", "user.name", "Seed"], seed);
      await runGit(["config", "user.email", "seed@example.test"], seed);
      await mkdir(join(seed, ".obsidian"));
      await writeFile(join(seed, ".obsidian", "app.json"), "remote config\n");
      await runGit(["add", "-f", ".obsidian/app.json"], seed);
      await runGit(["commit", "-m", "Forbidden config"], seed);
      await runGit(["remote", "add", "origin", bare], seed);
      await runGit(["push", "origin", "main"], seed);

      server = await startGitHttpServer(root, async () => undefined);
      const vault = new NodeVault(local);
      await vault.write(".obsidian/app.json", encode("local config\n"));
      const repo = new GitRepository(vault, settings({ gitUrl: server.url }), logger, ".obsidian");
      await expect(repo.clone()).rejects.toThrow("禁止同步路径");
      expect(decode(await vault.read(".obsidian/app.json"))).toBe("local config\n");
      expect(await vault.exists(".git")).toBe(false);
    } finally {
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers from a real Smart HTTP push race without force-pushing", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-push-race-"));
    const bare = join(root, "repo.git");
    const seed = join(root, "seed");
    const racer = join(root, "racer");
    const local = join(root, "local");
    let server: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
    try {
      await runGit(["init", "--bare", bare]);
      await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
      await runGit(["config", "http.receivepack", "true"], bare);

      await mkdir(seed);
      await runGit(["init"], seed);
      await runGit(["checkout", "-b", "main"], seed);
      await runGit(["config", "user.name", "Seed"], seed);
      await runGit(["config", "user.email", "seed@example.test"], seed);
      await writeFile(join(seed, "base.md"), "base\n");
      await runGit(["add", "base.md"], seed);
      await runGit(["commit", "-m", "Base"], seed);
      await runGit(["remote", "add", "origin", bare], seed);
      await runGit(["push", "origin", "main"], seed);

      await runGit(["clone", bare, racer]);
      await runGit(["config", "user.name", "Remote"], racer);
      await runGit(["config", "user.email", "remote@example.test"], racer);
      await writeFile(join(racer, "remote.md"), "remote race\n");
      await runGit(["add", "remote.md"], racer);
      await runGit(["commit", "-m", "Remote race"], racer);
      await runGit(["push", "origin", "HEAD:refs/heads/race-candidate"], racer);
      const candidateOid = await runGit(["rev-parse", "refs/heads/race-candidate"], bare);

      server = await startGitHttpServer(root, async () => {
        await runGit(["update-ref", "refs/heads/main", candidateOid], bare);
      });
      const vault = new NodeVault(local);
      await vault.mkdir("");
      const repo = new GitRepository(vault, settings({ gitUrl: server.url }), logger, ".obsidian");
      await repo.clone();
      await vault.write("local.md", encode("local race\n"));
      await repo.commit("Local race");

      let reconciliations = 0;
      const result = await pushWithNonFastForwardRetry(
        () => repo.push(),
        async () => {
          reconciliations += 1;
          await repo.fetch();
          return { ...(await repo.mergeRemote()), deferred: false };
        }
      );
      expect(result).toEqual({ conflicts: [], deferred: false });
      expect(reconciliations).toBe(1);
      const localHead = await git.resolveRef({ fs: repo.fs, dir: "", ref: "HEAD" });
      expect(await runGit(["rev-parse", "refs/heads/main"], bare)).toBe(localHead);
      const mergedCommit = await git.readCommit({ fs: repo.fs, dir: "", oid: localHead });
      expect(mergedCommit.commit.parent).toHaveLength(2);
      expect(decode(await vault.read("local.md"))).toBe("local race\n");
      expect(decode(await vault.read("remote.md"))).toBe("remote race\n");
      expect(await repo.hasUncommittedChanges()).toBe(false);
    } finally {
      if (server) await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
