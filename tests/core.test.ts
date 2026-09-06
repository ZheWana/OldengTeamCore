import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { mkdtemp, mkdir, open, readdir, readFile, rm, stat, rename, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exportPrivateSettings, exportSettings, importPrivateSettings, importSettings, mergeSettings } from "../src/config";
import { base64UrlDecode, base64UrlEncode, base64UrlEncodeBytes, sha256Hex } from "../src/crypto";
import { conflictFilesFromError, GitRepository, isNonFastForwardPushError, isPushReconciliationError, normalizeGitUrl, normalizeRemoteInfo } from "../src/git";
import { createEmptyManifest, mergeAssetManifests, serializeManifest, validateManifest } from "../src/manifest";
import { S3_CHUNKED_DOWNLOAD_THRESHOLD, S3_DOWNLOAD_CHUNK_SIZE, S3Transport } from "../src/s3";
import { createAttachmentStore } from "../src/attachment-store";
import { createPrivateRemote, PrivateNotesSynchronizer, type PrivateSyncRemote } from "../src/private-sync";
import { classifyPrivateLocalChange, classifyPublicFolderDeletionPaths, classifyPublicLocalChange, groupRemoteDeletionPaths, mergePendingPublicMove, planPrivateDraftPublication, planPublicNotePrivatization, pushWithNonFastForwardRetry, shouldCommitManagedChanges, shouldMaterializeRemoteAttachment, shouldNormalizeMovedAttachment, shouldProtectMismatchedLocalAttachment, shouldPublishPrivateDraftRename, shouldTrackPrivateSyncEvent, shouldTrackVaultEvent, takePendingPaths } from "../src/sync";
import { assetPathForHash, collectMarkdownReferences, collectPrivateAttachmentReferences, ensureAssetsExcluded, hashFromAssetPath, isAssetPath, isConfigPath, isHiddenAssetsFolderPath, isImageAttachmentPath, isManagedPath, isPrivateAssetPath, isPrivatePath, isRootAssetsPath, isTrashPath, legacyHashFromAssetPath, listRemoteOverwriteFiles, normalizeVaultPath, pastedImageExtension, pastedImageTargetPath, planFastRemoteReset, pruneEmptyManagedFolders, rewriteAssetReferences } from "../src/vault";
import { applySharedPluginState, mergeSharedPluginIds, mergeSharedPluginState, parseSharedPluginState, readSharedPluginIdsFromGitignore, readSharedPluginState, serializeSharedPluginState, updateSharedPluginsInGitignore, writeSharedPluginState } from "../src/shared-plugins";
import { DEFAULT_SETTINGS, type Logger, type TeamCoreSettings } from "../src/types";
import type { BinaryVault } from "../src/vault";
import git from "isomorphic-git";
import { assignedOrHistoricalAuthors, clearFileAuthors, countResolvedDocumentAuthors, createEmptyFileAuthorRegistry, FileAuthorService, mergeFileAuthorRegistries, parseFileAuthorRegistry, serializeFileAuthorRegistry, setFileAuthors, validateFileAuthorRegistry, writeFileAuthorRegistry } from "../src/file-authors";
import { Buffer as BrowserBuffer } from "../src/browser-shims";
import { PluginLogger, parseLogEntries } from "../src/logger";
import { AuthorDisplayService, parseAuthorDisplayMappings, serializeAuthorDisplayMappings } from "../src/author-display";
import { SerializedPluginData } from "../src/persistence";
import { compressSync, strToU8 } from "fflate";

// Obsidian exposes its request-capable global as window. Keep production code
// on that API while giving Node-based transport tests the equivalent runtime.
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });

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

class MemoryPrivateRemote implements PrivateSyncRemote {
  readonly objects = new Map<string, ArrayBuffer>();
  protected indexRevision = 0;

  async initialize(): Promise<void> {}
  async read(path: string): Promise<ArrayBuffer | undefined> { return this.objects.get(path)?.slice(0); }
  async write(path: string, data: ArrayBuffer): Promise<void> { this.objects.set(path, data.slice(0)); }
  async writeFromChunks(path: string, sha256: string, size: number, _contentType: string, source: (onChunk: (chunk: ArrayBuffer, offset: number, total: number) => Promise<void>) => Promise<void>): Promise<void> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    await source(async (chunk, chunkOffset, total) => {
      if (total !== size || chunkOffset !== offset) throw new Error("invalid test upload chunk");
      chunks.push(new Uint8Array(chunk));
      offset += chunk.byteLength;
    });
    const data = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) { data.set(chunk, cursor); cursor += chunk.byteLength; }
    if (cursor !== size || await sha256Hex(data) !== sha256) throw new Error("invalid test upload hash");
    this.objects.set(path, data.buffer);
  }
  async remove(path: string): Promise<void> { this.objects.delete(path); }
  async readIndex() {
    const data = await this.read("oldeng-team-core-private/v1/index.json");
    return { data, version: data ? String(this.indexRevision) : undefined };
  }
  async writeIndex(data: ArrayBuffer, version: string | undefined) {
    const current = this.objects.has("oldeng-team-core-private/v1/index.json") ? String(this.indexRevision) : undefined;
    if (version !== current) return "conflict" as const;
    this.objects.set("oldeng-team-core-private/v1/index.json", data.slice(0));
    this.indexRevision += 1;
    return "written" as const;
  }
}

class ConcurrentIndexRemote extends MemoryPrivateRemote {
  private injectOnNextIndexWrite: ArrayBuffer | undefined;

  injectConcurrentIndex(data: ArrayBuffer): void {
    this.injectOnNextIndexWrite = data;
  }

  override async writeIndex(data: ArrayBuffer, version: string | undefined) {
    if (this.injectOnNextIndexWrite) {
      this.objects.set("oldeng-team-core-private/v1/index.json", this.injectOnNextIndexWrite);
      this.injectOnNextIndexWrite = undefined;
      this.indexRevision += 1;
    }
    return super.writeIndex(data, version);
  }
}

class HookedIndexRemote extends MemoryPrivateRemote {
  onBeforeIndexWrite: (() => Promise<void>) | undefined;

  override async writeIndex(data: ArrayBuffer, version: string | undefined) {
    await this.onBeforeIndexWrite?.();
    return super.writeIndex(data, version);
  }
}

class CountingIndexRemote extends MemoryPrivateRemote {
  indexWrites = 0;

  override async writeIndex(data: ArrayBuffer, version: string | undefined) {
    this.indexWrites += 1;
    return super.writeIndex(data, version);
  }
}

class ChunkingPrivateRemote extends MemoryPrivateRemote {
  readonly chunkSizes: number[] = [];

  override async readInChunks(path: string, expectedSize: number, onChunk: (chunk: ArrayBuffer, offset: number, total: number) => Promise<void>): Promise<void> {
    const data = await this.read(path);
    if (!data || data.byteLength !== expectedSize) throw new Error("missing test object");
    const bytes = new Uint8Array(data);
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
      this.chunkSizes.push(chunk.byteLength);
      await onChunk(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), offset, bytes.byteLength);
    }
  }
}

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
  async readInChunks(path: string, expectedSize: number, onChunk: (chunk: ArrayBuffer, offset: number, total: number) => Promise<void>): Promise<void> {
    const handle = await open(this.resolve(path), "r");
    try {
      let offset = 0;
      while (offset < expectedSize) {
        const chunk = new Uint8Array(Math.min(8 * 1024 * 1024, expectedSize - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
        if (bytesRead !== chunk.byteLength) throw new Error("short test read");
        await onChunk(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + bytesRead), offset, expectedSize);
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
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

class CountingVault extends NodeVault {
  readonly reads: string[] = [];

  override async read(path: string): Promise<ArrayBuffer> {
    this.reads.push(path);
    return super.read(path);
  }
}

class ListCountingVault extends NodeVault {
  readonly listed: string[] = [];

  override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.listed.push(path);
    return super.list(path);
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

  it("serializes settings and diagnostics writes without losing either change", async () => {
    const writes: Record<string, unknown>[] = [];
    const store = new SerializedPluginData({ retained: "value", diagnosticLogs: ["old"] }, async (data) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      writes.push(data);
    });
    await Promise.all([
      store.update({ gitUrl: "https://git.example.test/updated.git", autoSync: true }),
      store.update({ diagnosticLogs: ["new"] })
    ]);
    expect(writes.at(-1)).toEqual({ retained: "value", diagnosticLogs: ["new"], gitUrl: "https://git.example.test/updated.git", autoSync: true });
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
    const source = settings({ gitUsername: "source-user", debounceMs: 90_000, installationId: "a".repeat(48) });
    const current = settings({ gitUsername: "local-user", debounceMs: 60_000, installationId: "b".repeat(48) });
    const imported = importSettings(exportSettings(source), current);

    expect(imported).toEqual({ ...source, gitUsername: "local-user", installationId: current.installationId });
  });

  it("rejects malformed bundles and invalid timing values", () => {
    expect(() => importSettings("not-base64", settings())).toThrow();
    const encoded = exportSettings(settings({ debounceMs: 0 }));
    expect(() => importSettings(encoded, settings())).toThrow("同步时间");
  });

  it("exports a compressed, self-identifying bundle", () => {
    const source = settings({
      gitUrl: "https://git.example.test/team-core/knowledge.git",
      gitPassword: "shared-password",
      attachmentStorageProvider: "webdav",
      attachmentWebdavUrl: "https://dav.example.test/team/",
      attachmentWebdavUsername: "team-user",
      attachmentWebdavPassword: "team-secret",
      authorDisplayMappings: { xuchenrui: "许宸瑞", gaochenrui: "高晨瑞" }
    });
    const exported = exportSettings(source);
    expect(exported.startsWith("tc1.")).toBe(true);
    expect(exported.length).toBeLessThan(JSON.stringify(source).length * 1.34);
    const imported = importSettings(exported, settings({ gitUsername: "local-user" }));
    expect(imported.gitPassword).toBe(source.gitPassword);
    expect(imported.attachmentStorageProvider).toBe("webdav");
    expect(imported.attachmentWebdavPassword).toBe("team-secret");
  });

  it("never exports diagnostic logs or other plugin-local runtime data", () => {
    const source = settings({ authorDisplayMappings: { xuchenrui: "许宸瑞" }, installationId: "a".repeat(48) });
    const polluted = {
      ...source,
      diagnosticLogs: Array.from({ length: 800 }, (_, index) => ({ index, message: "x".repeat(250) })),
      futureRuntimeCache: "y".repeat(20_000)
    } as TeamCoreSettings;
    expect(exportSettings(polluted)).toBe(exportSettings(settings({ authorDisplayMappings: source.authorDisplayMappings })));
    expect("diagnosticLogs" in mergeSettings(polluted)).toBe(false);
    expect("futureRuntimeCache" in mergeSettings(polluted)).toBe(false);
  });

  it("restores local attachment retention and safety records from plugin data", () => {
    const restored = mergeSettings({
      pendingDeletionPaths: ["notes/obsolete.md"],
      pendingDeletionFolders: ["notes"],
      pendingPublicMoves: [{ from: "notes/a.md", to: "archive/a.md" }],
      assetRetention: [{ sha256: "a".repeat(64), size: 42, markedAt: "2026-09-06T00:00:00.000Z" }]
    });
    expect(restored.pendingDeletionPaths).toEqual(["notes/obsolete.md"]);
    expect(restored.pendingDeletionFolders).toEqual(["notes"]);
    expect(restored.pendingPublicMoves).toEqual([{ from: "notes/a.md", to: "archive/a.md" }]);
    expect(restored.assetRetention).toEqual([{ sha256: "a".repeat(64), size: 42, markedAt: "2026-09-06T00:00:00.000Z" }]);
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

  it("keeps private-note credentials out of shared configuration bundles", () => {
    const source = settings({
      privateSyncEnabled: true,
      privateWebdavUrl: "https://dav.example.test/private/",
      privateWebdavUsername: "private-user",
      privateWebdavPassword: "private-secret"
    });
    const current = settings({ privateWebdavPassword: "local-private-secret" });

    expect(exportSettings(source)).toBe(exportSettings(settings()));
    const imported = importSettings(exportSettings(source), current);
    expect(imported.privateWebdavPassword).toBe("local-private-secret");
    expect(imported.privateSyncEnabled).toBe(false);
  });

  it("round-trips the independent private-note configuration bundle", () => {
    const source = settings({
      privateSyncEnabled: true,
      privateSyncProvider: "s3",
      privateS3Endpoint: "https://private-s3.example.test",
      privateS3Region: "us-east-1",
      privateS3Bucket: "private-notes",
      privateS3Prefix: "alice",
      privateS3AccessKey: "private-access",
      privateS3SecretKey: "private-secret",
      privateSyncWithTeam: true
    });
    const imported = importPrivateSettings(exportPrivateSettings(source), settings({ gitUsername: "local-user" }));

    expect(exportPrivateSettings(source).startsWith("tcp1.")).toBe(true);
    expect(imported.privateSyncEnabled).toBe(true);
    expect(imported.privateSyncWithTeam).toBe(true);
    expect(imported.privateSyncProvider).toBe("s3");
    expect(imported.privateS3SecretKey).toBe("private-secret");
    expect(imported.gitUsername).toBe("local-user");
    expect(imported.privateSyncState.entries).toEqual({});
  });

  it("rejects a malformed Git author display mapping in a configuration bundle", () => {
    const encoded = `tc1.${base64UrlEncodeBytes(compressSync(strToU8(JSON.stringify({ version: 1, settings: { authorDisplayMappings: "not-a-map" } }))))}`;
    expect(() => importSettings(encoded, settings())).toThrow("映射无效");
  });
});

describe("private-note synchronization", () => {
  it("classifies public and private local changes without exposing storage internals", () => {
    expect(classifyPublicLocalChange("notes/plan.md", ".obsidian")).toBe("documents");
    expect(classifyPublicLocalChange(".team/assets-manifest.json", ".obsidian")).toBe("attachments");
    expect(classifyPublicLocalChange(".gitignore", ".obsidian")).toBe("settings");
    expect(classifyPublicLocalChange(".obsidian/plugins/dataview/main.js", ".obsidian")).toBe("settings");
    expect(classifyPublicLocalChange("exports/index.csv", ".obsidian")).toBe("other");
    expect(classifyPrivateLocalChange("draft.md")).toBe("documents");
    expect(classifyPrivateLocalChange("assets/sha256-aabbcc.png")).toBe("attachments");
    expect(classifyPrivateLocalChange("research/data.csv")).toBe("other");
  });

  it("separates knowledge-content and public-configuration deletion prompts", () => {
    expect(groupRemoteDeletionPaths([
      "assets/tc-sha256-deadbeef.png",
      "notes/plan.md",
      ".team/assets-manifest.json",
      ".team/shared-plugins.json",
      ".gitignore",
      ".obsidian/plugins/dataview/main.js"
    ], ".obsidian")).toEqual({
      knowledgePaths: [".team/assets-manifest.json", "assets/tc-sha256-deadbeef.png", "notes/plan.md"],
      configurationPaths: [".gitignore", ".obsidian/plugins/dataview/main.js", ".team/shared-plugins.json"],
      folders: [],
      moves: []
    });
  });

  it("keeps deleted folder roots only when they contain pending deletion paths", () => {
    expect(groupRemoteDeletionPaths([
      "projects/alpha/a.md",
      "projects/alpha/sub/b.md",
      "notes/plan.md"
    ], ".obsidian", ["projects/alpha", "empty-folder"])).toMatchObject({
      folders: ["projects/alpha"]
    });
  });

  it("coalesces public rename event chains into one confirmed move", () => {
    const first = mergePendingPublicMove([], "notes/a.md", "notes/b.md");
    expect(first).toEqual([{ from: "notes/a.md", to: "notes/b.md" }]);
    expect(mergePendingPublicMove(first, "notes/b.md", "archive/a.md"))
      .toEqual([{ from: "notes/a.md", to: "archive/a.md" }]);
    expect(mergePendingPublicMove(first, "notes/b.md", "notes/a.md")).toEqual([]);
  });

  it("expands folder descendants before applying the public-deletion threshold", () => {
    expect(classifyPublicFolderDeletionPaths([
      "projects/alpha/a.md",
      "projects/alpha/b.md",
      "projects/alpha/c.md",
      "projects/alpha/d.md",
      "assets/tc-sha256-deadbeef.png",
      "私人笔记/draft.md",
      ".obsidian/plugins/personal/main.js",
      ".obsidian/plugins/dataview/main.js"
    ], ".obsidian", ["dataview"])).toEqual({
      managedPaths: [
        ".obsidian/plugins/dataview/main.js",
        "projects/alpha/a.md",
        "projects/alpha/b.md",
        "projects/alpha/c.md",
        "projects/alpha/d.md"
      ],
      assetPaths: ["assets/tc-sha256-deadbeef.png"]
    });
  });

  it("does not queue private Vault events while private synchronization is disabled", () => {
    expect(shouldTrackPrivateSyncEvent(settings({ privateSyncEnabled: false }))).toBe(false);
    expect(shouldTrackPrivateSyncEvent(settings({ privateSyncEnabled: true }))).toBe(true);
  });

  it("uses WebDAV ETags for conditional private-index creation", async () => {
    const requests: Array<{ method?: string; headers: import("node:http").IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, headers: request.headers });
      if (request.method === "MKCOL") { response.writeHead(405); response.end(); return; }
      if (request.method === "GET") { response.writeHead(404); response.end(); return; }
      if (request.method === "PUT") { response.writeHead(201, { etag: '"created"' }); response.end(); return; }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve WebDAV test server port");
    try {
      const remote = createPrivateRemote(settings({
        privateSyncProvider: "webdav",
        privateWebdavUrl: `http://127.0.0.1:${address.port}/private/`
      }), logger);
      await remote.initialize();
      const index = await remote.readIndex();
      expect(index).toEqual({ data: undefined, version: undefined });
      await expect(remote.writeIndex(encode("{}"), index.version)).resolves.toBe("written");
      const put = requests.find((request) => request.method === "PUT");
      expect(put?.headers["if-none-match"]).toBe("*");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects a WebDAV weak ETag before attempting an unsafe conditional write", async () => {
    let putCalls = 0;
    const server = createServer((request, response) => {
      if (request.method === "MKCOL") { response.writeHead(405); response.end(); return; }
      if (request.method === "GET") { response.writeHead(200, { etag: 'W/"weak"' }); response.end("{}\n"); return; }
      if (request.method === "PUT") { putCalls += 1; response.writeHead(204); response.end(); return; }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve WebDAV test server port");
    try {
      const remote = createPrivateRemote(settings({ privateSyncProvider: "webdav", privateWebdavUrl: `http://127.0.0.1:${address.port}/private/` }), logger);
      await expect(remote.readIndex()).rejects.toThrow("弱 ETag");
      expect(putCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("streams a large private WebDAV upload without a whole-file request body", async () => {
    let received = 0;
    const server = createServer((request, response) => {
      if (request.method !== "PUT") { response.writeHead(405); response.end(); return; }
      request.on("data", (chunk: Buffer) => { received += chunk.byteLength; });
      request.on("end", () => { response.writeHead(201); response.end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve WebDAV upload test server port");
    try {
      const remote = createPrivateRemote(settings({ privateSyncProvider: "webdav", privateWebdavUrl: `http://127.0.0.1:${address.port}/private/` }), logger);
      const data = new Uint8Array(6 * 1024 * 1024 + 31).fill(19);
      const hash = await sha256Hex(data);
      const sourceChunks: number[] = [];
      await remote.writeFromChunks!("oldeng-team-core-private/v1/files/large", hash, data.byteLength, "application/octet-stream", async (onChunk) => {
        const first = data.subarray(0, 6 * 1024 * 1024);
        const second = data.subarray(first.byteLength);
        sourceChunks.push(first.byteLength, second.byteLength);
        await onChunk(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength), 0, data.byteLength);
        await onChunk(second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength), first.byteLength, data.byteLength);
      });
      expect(sourceChunks).toEqual([6 * 1024 * 1024, 31]);
      expect(received).toBe(data.byteLength);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it("rejects an early WebDAV success response before a private source is fully verified", async () => {
    const originalFetch = window.fetch;
    const chunks = [new Uint8Array(1024).fill(1), new Uint8Array(1024).fill(2), new Uint8Array(1024).fill(3)];
    const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let cursor = 0;
    for (const chunk of chunks) { data.set(chunk, cursor); cursor += chunk.byteLength; }
    window.fetch = async (_url, request) => {
      const stream = request?.body as ReadableStream<Uint8Array>;
      await stream.getReader().read();
      return new Response(undefined, { status: 201 });
    };
    try {
      const remote = createPrivateRemote(settings({ privateSyncProvider: "webdav", privateWebdavUrl: "https://webdav.example.test/private/" }), logger);
      await expect(remote.writeFromChunks!("oldeng-team-core-private/v1/files/early", await sha256Hex(data), data.byteLength, "application/octet-stream", async (onChunk) => {
        let offset = 0;
        for (const chunk of chunks) {
          await onChunk(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), offset, data.byteLength);
          offset += chunk.byteLength;
        }
      })).rejects.toThrow("完整上传前");
    } finally {
      window.fetch = originalFetch;
    }
  });

  it("uploads incrementally, downloads to another vault, and propagates deletions", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "team-core-private-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-second-"));
    try {
      const remote = new HookedIndexRemote();
      const firstVault = new NodeVault(firstRoot);
      const secondVault = new NodeVault(secondRoot);
      const first = new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote);
      const second = new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote);

      await firstVault.write("私人笔记/drafts/idea.md", encode("first draft"));
      const firstSync = await first.sync(firstVault, { version: 1, entries: {} });
      expect(firstSync.uploaded).toBe(1);
      expect(firstSync.downloaded).toBe(0);

      const noChange = await first.sync(firstVault, firstSync.state);
      expect(noChange.uploaded).toBe(0);
      expect(noChange.downloaded).toBe(0);

      const secondSync = await second.sync(secondVault, { version: 1, entries: {} });
      expect(secondSync.downloaded).toBe(1);
      expect(decode(await secondVault.read("私人笔记/drafts/idea.md"))).toBe("first draft");

      await firstVault.remove("私人笔记/drafts/idea.md");
      const deleteSync = await first.sync(firstVault, { ...noChange.state, pendingPaths: ["drafts/idea.md"] });
      expect(deleteSync.deletedRemote).toBe(1);
      // Deletion publishes a tombstone. Immutable bytes are retained until a
      // separate, reference-aware garbage collector can safely remove them.
      expect([...remote.objects.keys()].some((key) => key.includes("/files/"))).toBe(true);

      const receiveDelete = await second.sync(secondVault, secondSync.state);
      expect(receiveDelete.deletedLocal).toBe(1);
      expect(await secondVault.exists("私人笔记/drafts/idea.md")).toBe(false);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("does not conditionally rewrite an unchanged private manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-noop-index-"));
    try {
      const remote = new CountingIndexRemote();
      const vault = new NodeVault(root);
      await vault.write("私人笔记/idea.md", encode("unchanged"));
      const synchronizer = new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote);
      const baseline = await synchronizer.sync(vault, { version: 1, entries: {} });
      remote.indexWrites = 0;
      await synchronizer.sync(vault, baseline.state);
      expect(remote.indexWrites).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a large private download in bounded chunks instead of retaining the batch", async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-chunk-target-"));
    try {
      const remote = new ChunkingPrivateRemote();
      const data = new Uint8Array(8 * 1024 * 1024 + 17).fill(7);
      const hash = await sha256Hex(data);
      const objectKey = `oldeng-team-core-private/v1/files/${base64UrlEncode("large.bin")}-${hash}`;
      remote.objects.set(objectKey, data.buffer.slice(0));
      remote.objects.set("oldeng-team-core-private/v1/index.json", encode(JSON.stringify({
        version: 1,
        entries: { "large.bin": { sha256: hash, size: data.byteLength, updatedAt: 1, objectKey } }
      })));
      const secondVault = new NodeVault(secondRoot);
      const result = await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(secondVault, { version: 1, entries: {} });
      expect(result.downloaded).toBe(1);
      expect(remote.chunkSizes.length).toBeGreaterThan(1);
      expect(Math.max(...remote.chunkSizes)).toBeLessThanOrEqual(1024 * 1024);
      expect((await secondVault.stat("私人笔记/large.bin"))?.size).toBe(data.byteLength);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("uploads a large private local file through bounded chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-large-upload-"));
    try {
      const remote = new MemoryPrivateRemote();
      const vault = new NodeVault(root);
      const data = new Uint8Array(8 * 1024 * 1024 + 1).fill(3);
      await vault.write("私人笔记/large.bin", data.buffer);
      const result = await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(vault, { version: 1, entries: {} });
      expect(result.uploaded).toBe(1);
      const entry = result.state.entries["large.bin"];
      expect(entry?.objectKey).toBeTruthy();
      expect(remote.objects.get(entry!.objectKey!)?.byteLength).toBe(data.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replans after an index compare-and-swap conflict without dropping another device's file", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-cas-"));
    try {
      const remote = new ConcurrentIndexRemote();
      const remoteData = encode("from device A");
      const remoteHash = await sha256Hex(remoteData);
      const remoteKey = `oldeng-team-core-private/v1/files/${base64UrlEncode("a.md")}-${remoteHash}`;
      remote.objects.set(remoteKey, remoteData);
      remote.injectConcurrentIndex(encode(JSON.stringify({
        version: 1,
        entries: { "a.md": { sha256: remoteHash, size: remoteData.byteLength, updatedAt: Date.now(), objectKey: remoteKey } }
      })));

      const vault = new NodeVault(root);
      await vault.write("私人笔记/b.md", encode("from device B"));
      const result = await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(vault, { version: 1, entries: {} });
      expect(result.uploaded).toBe(1);
      expect(decode(await vault.read("私人笔记/a.md"))).toBe("from device A");
      const index = JSON.parse(decode(remote.objects.get("oldeng-team-core-private/v1/index.json")!)) as { entries: Record<string, unknown> };
      expect(index.entries).toHaveProperty("a.md");
      expect(index.entries).toHaveProperty("b.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a failed CAS attempt turn its own download into a newer local edit", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-cas-local-effects-"));
    try {
      const remote = new ConcurrentIndexRemote();
      const firstData = encode("remote revision one");
      const secondData = encode("remote revision two");
      const firstHash = await sha256Hex(firstData);
      const secondHash = await sha256Hex(secondData);
      const firstKey = `oldeng-team-core-private/v1/files/${base64UrlEncode("a.md")}-${firstHash}`;
      const secondKey = `oldeng-team-core-private/v1/files/${base64UrlEncode("a.md")}-${secondHash}`;
      remote.objects.set(firstKey, firstData);
      remote.objects.set(secondKey, secondData);
      remote.objects.set("oldeng-team-core-private/v1/index.json", encode(JSON.stringify({
        version: 1,
        entries: { "a.md": { sha256: firstHash, size: firstData.byteLength, updatedAt: 1, objectKey: firstKey } }
      })));
      remote.injectConcurrentIndex(encode(JSON.stringify({
        version: 1,
        entries: { "a.md": { sha256: secondHash, size: secondData.byteLength, updatedAt: Date.now() + 60_000, objectKey: secondKey } }
      })));

      const vault = new NodeVault(root);
      await vault.write("私人笔记/local.md", encode("local update that forces CAS"));
      await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(vault, { version: 1, entries: {} });

      expect(decode(await vault.read("私人笔记/a.md"))).toBe("remote revision two");
      const index = JSON.parse(decode(remote.objects.get("oldeng-team-core-private/v1/index.json")!)) as { entries: Record<string, { sha256: string }> };
      expect(index.entries["a.md"].sha256).toBe(secondHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a private note edited after index CAS but before local materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-local-race-"));
    try {
      const remote = new HookedIndexRemote();
      const remoteData = encode("remote revision");
      const remoteHash = await sha256Hex(remoteData);
      const remoteKey = `oldeng-team-core-private/v1/files/${base64UrlEncode("race.md")}-${remoteHash}`;
      remote.objects.set(remoteKey, remoteData);
      remote.objects.set("oldeng-team-core-private/v1/index.json", encode(JSON.stringify({
        version: 1,
        entries: { "race.md": { sha256: remoteHash, size: remoteData.byteLength, updatedAt: 1, objectKey: remoteKey } }
      })));
      const vault = new NodeVault(root);
      await vault.write("私人笔记/local.md", encode("local update that forces CAS"));
      remote.onBeforeIndexWrite = () => vault.write("私人笔记/race.md", encode("user edit after commit"));
      await expect(new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(
        vault,
        { version: 1, entries: {} }
      )).rejects.toThrow("同步期间已被修改");
      expect(decode(await vault.read("私人笔记/race.md"))).toBe("user edit after commit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pulls remote private notes without uploading local-only files", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "team-core-private-pull-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-pull-second-"));
    try {
      const remote = new MemoryPrivateRemote();
      const firstVault = new NodeVault(firstRoot);
      await firstVault.write("私人笔记/remote.md", encode("remote note"));
      await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(firstVault, { version: 1, entries: {} });

      const secondVault = new NodeVault(secondRoot);
      await secondVault.write("私人笔记/local-only.md", encode("local note"));
      const result = await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).pull(secondVault, { version: 1, entries: {} });

      expect(result.uploaded).toBe(0);
      expect(decode(await secondVault.read("私人笔记/remote.md"))).toBe("remote note");
      expect(await secondVault.exists("私人笔记/local-only.md")).toBe(true);
      expect(result.preservedLocal).toBe(1);
      expect(result.state.pendingPaths).toEqual(["local-only.md"]);
      const index = JSON.parse(decode(remote.objects.get("oldeng-team-core-private/v1/index.json")!)) as { entries: Record<string, unknown> };
      expect(index.entries).not.toHaveProperty("local-only.md");
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for one malformed remote entry without changing local or remote state", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-malformed-index-"));
    try {
      const remote = new MemoryPrivateRemote();
      const vault = new NodeVault(root);
      await vault.write("私人笔记/local.md", encode("local bytes"));
      remote.objects.set("oldeng-team-core-private/v1/index.json", encode(JSON.stringify({
        version: 1,
        entries: {
          "valid.md": { sha256: "a".repeat(64), size: 1, updatedAt: 1 },
          "broken.md": { sha256: "not-a-hash", size: 1, updatedAt: 1 }
        }
      })));
      await expect(new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(vault, { version: 1, entries: {} }))
        .rejects.toThrow("broken.md");
      expect(decode(await vault.read("私人笔记/local.md"))).toBe("local bytes");
      expect(decode(remote.objects.get("oldeng-team-core-private/v1/index.json")!)).toContain("broken.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes only event-journaled private files during an ordinary incremental sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-private-incremental-"));
    try {
      const remote = new MemoryPrivateRemote();
      const initialVault = new NodeVault(root);
      await initialVault.write("私人笔记/changed.md", encode("before"));
      await initialVault.write("私人笔记/unrelated.md", encode("do not read"));
      const synchronizer = new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote);
      const baseline = await synchronizer.sync(initialVault, { version: 1, entries: {} });
      const vault = new CountingVault(root);
      await vault.write("私人笔记/changed.md", encode("after"));
      vault.reads.length = 0;
      const result = await synchronizer.sync(vault, { ...baseline.state, pendingPaths: ["changed.md"] });
      expect(result.uploaded).toBe(1);
      expect(vault.reads.filter((path) => path.startsWith("私人笔记/")).every((path) => path === "私人笔记/changed.md")).toBe(true);
      expect(vault.reads.filter((path) => path.startsWith("私人笔记/")).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains locally changed matching paths during normal import and only overwrites in reset mode", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "team-core-private-safe-pull-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-safe-pull-second-"));
    try {
      const remote = new MemoryPrivateRemote();
      const firstVault = new NodeVault(firstRoot);
      await firstVault.write("私人笔记/shared.md", encode("remote version"));
      const remoteState = (await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote)
        .sync(firstVault, { version: 1, entries: {} })).state;

      const secondVault = new NodeVault(secondRoot);
      await secondVault.write("私人笔记/shared.md", encode("local unsynced version"));
      const synchronizer = new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote);
      const safePull = await synchronizer.pull(secondVault, remoteState);
      expect(safePull.downloaded).toBe(0);
      expect(safePull.preservedLocal).toBe(1);
      expect(decode(await secondVault.read("私人笔记/shared.md"))).toBe("local unsynced version");

      const forcedPull = await synchronizer.pull(secondVault, remoteState, undefined, true);
      expect(forcedPull.downloaded).toBe(1);
      expect(forcedPull.preservedLocal).toBe(0);
      expect(decode(await secondVault.read("私人笔记/shared.md"))).toBe("remote version");
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("stops before writing a downloaded file whose bytes do not match the private manifest", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "team-core-private-hash-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-hash-second-"));
    try {
      const remote = new MemoryPrivateRemote();
      const firstVault = new NodeVault(firstRoot);
      await firstVault.write("私人笔记/idea.md", encode("expected bytes"));
      await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(firstVault, { version: 1, entries: {} });
      const fileKey = [...remote.objects.keys()].find((key) => key.includes("/files/"));
      if (!fileKey) throw new Error("Expected private remote file");
      remote.objects.set(fileKey, encode("tampered bytes"));

      const secondVault = new NodeVault(secondRoot);
      await expect(new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(secondVault, { version: 1, entries: {} }))
        .rejects.toThrow("校验失败");
      expect(await secondVault.exists("私人笔记/idea.md")).toBe(false);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("rolls back every private local write when a later transaction operation fails", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "team-core-private-transaction-source-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "team-core-private-transaction-target-"));
    try {
      const remote = new MemoryPrivateRemote();
      const firstVault = new NodeVault(firstRoot);
      await firstVault.write("私人笔记/a.md", encode("remote a"));
      await firstVault.write("私人笔记/b.md", encode("remote b"));
      await new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(firstVault, { version: 1, entries: {} });

      const secondVault = new NodeVault(secondRoot);
      const rename = secondVault.rename.bind(secondVault);
      let failed = false;
      secondVault.rename = async (path: string, newPath: string): Promise<void> => {
        if (newPath === "私人笔记/b.md" && !failed) {
          failed = true;
          throw new Error("simulated disk failure");
        }
        await rename(path, newPath);
      };
      await expect(new PrivateNotesSynchronizer(settings({ privateSyncEnabled: true }), logger, remote).sync(secondVault, { version: 1, entries: {} }))
        .rejects.toThrow("simulated disk failure");
      expect(await secondVault.exists("私人笔记/a.md")).toBe(false);
      expect(await secondVault.exists("私人笔记/b.md")).toBe(false);
      expect(await secondVault.exists("private-sync-transaction.json")).toBe(false);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
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

  it("plans confirmed remote reset by top-level public roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-fast-reset-"));
    try {
      const vault = new NodeVault(root);
      await vault.write("assets/nested/large.pdf", encode("asset"));
      await vault.write("notes/readme.md", encode("note"));
      await vault.write(".team/assets-manifest.json", encode("{}"));
      await vault.write(".gitignore", encode("assets/\n"));
      await vault.write(".obsidian/app.json", encode("{}"));
      await vault.write("私人笔记/draft.md", encode("draft"));
      await vault.write(".trash/deleted.md", encode("deleted"));
      await vault.write(".git/HEAD", encode("ref: refs/heads/main\n"));

      await expect(planFastRemoteReset(vault, ".obsidian")).resolves.toEqual({
        files: [".gitignore"],
        directories: [".team", "assets", "notes"],
        hasGitDirectory: true
      });
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
          uploadedBy: "alice",
          uploadedFrom: "a".repeat(48)
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
    expect(manifest.files["assets/z.pdf"].uploadedFrom).toBe("a".repeat(48));
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

  it("uses explicit change signals before starting an expensive Git staging scan", () => {
    expect(shouldCommitManagedChanges({ pendingNotes: 0, attachmentsChanged: false, gitignoreChanged: false, sharedPluginStateChanged: false })).toBe(false);
    expect(shouldCommitManagedChanges({ pendingNotes: 1, attachmentsChanged: false, gitignoreChanged: false, sharedPluginStateChanged: false })).toBe(true);
    expect(shouldCommitManagedChanges({ pendingNotes: 0, attachmentsChanged: true, gitignoreChanged: false, sharedPluginStateChanged: false })).toBe(true);
    expect(shouldCommitManagedChanges({ pendingNotes: 0, attachmentsChanged: false, gitignoreChanged: true, sharedPluginStateChanged: false })).toBe(true);
    expect(shouldCommitManagedChanges({ pendingNotes: 0, attachmentsChanged: false, gitignoreChanged: false, sharedPluginStateChanged: true })).toBe(true);
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
  it("signs S3 index conditions and preserves the returned ETag", async () => {
    const requests: Array<{ method?: string; headers: import("node:http").IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, headers: request.headers });
      if (request.method === "GET") {
        response.writeHead(200, { etag: '"index-v1"', "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "PUT") { response.writeHead(200); response.end(); return; }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve S3 test server port");
    try {
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      const index = await transport.readObjectWithVersion("oldeng-team-core-private/v1/index.json");
      expect(index.version).toBe('"index-v1"');
      await expect(transport.writeObjectIfUnchanged("oldeng-team-core-private/v1/index.json", encode("{}"), "application/json", index.version)).resolves.toBe("written");
      const put = requests.find((request) => request.method === "PUT");
      expect(put?.headers["if-match"]).toBe('"index-v1"');
      expect(put?.headers.authorization).toMatch(/SignedHeaders=[^,]*if-match/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

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

  it("uploads large objects through bounded S3 multipart parts and completes only after hashing the source", async () => {
    const partNumbers: string[] = [];
    const requests: Array<{ method: string | undefined; query: string }> = [];
    let completed = false;
    let sha256Metadata: string | undefined;
    const size = 6 * 1024 * 1024 + 257;
    const data = new Uint8Array(size).fill(11);
    const hash = await sha256Hex(data);
    const server = createServer((request, response) => {
      const address = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${address}`);
      requests.push({ method: request.method, query: url.search });
      if (request.method === "HEAD") {
        if (completed) response.writeHead(200, { "content-length": String(size), "x-amz-meta-sha256": sha256Metadata ?? "" });
        else response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        sha256Metadata = typeof request.headers["x-amz-meta-sha256"] === "string" ? request.headers["x-amz-meta-sha256"] : undefined;
        response.writeHead(200, { "content-type": "application/xml" });
        response.end("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>");
        return;
      }
      if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        partNumbers.push(url.searchParams.get("partNumber") ?? "");
        request.resume();
        request.on("end", () => { response.writeHead(200, { etag: `\"part-${partNumbers[partNumbers.length - 1]}\"` }); response.end(); });
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        completed = true;
        request.resume();
        request.on("end", () => { response.writeHead(200); response.end(); });
        return;
      }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve multipart test server port");
    try {
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      await transport.ensureUploadedFromChunks(hash, size, "application/octet-stream", async (onChunk) => {
        const first = data.subarray(0, 6 * 1024 * 1024);
        const second = data.subarray(first.byteLength);
        await onChunk(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength), 0, size);
        await onChunk(second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength), first.byteLength, size);
      });
      expect(partNumbers).toEqual(["1", "2"]);
      expect(requests.some((request) => request.method === "POST" && request.query.includes("uploads="))).toBe(true);
      expect(requests.some((request) => request.method === "POST" && request.query.includes("uploadId=upload-1"))).toBe(true);
      expect(completed).toBe(true);
      expect(sha256Metadata).toBe(hash);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("aborts a multipart upload when the source changes after planning", async () => {
    let aborted = false;
    const size = 6 * 1024 * 1024;
    const expected = new Uint8Array(size).fill(1);
    const changed = new Uint8Array(size).fill(2);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "HEAD") { response.writeHead(404); response.end(); return; }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        response.writeHead(200); response.end("<UploadId>upload-2</UploadId>"); return;
      }
      if (request.method === "PUT") { request.resume(); request.on("end", () => { response.writeHead(200, { etag: '"part"' }); response.end(); }); return; }
      if (request.method === "DELETE" && url.searchParams.get("uploadId") === "upload-2") { aborted = true; response.writeHead(204); response.end(); return; }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve multipart abort test server port");
    try {
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      await expect(transport.ensureUploadedFromChunks(await sha256Hex(expected), size, "application/octet-stream", (onChunk) =>
        onChunk(changed.buffer, 0, size)
      )).rejects.toThrow("changed");
      expect(aborted).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not reuse a same-sized S3 object without matching SHA-256 metadata", async () => {
    let initiated = false;
    let completed = false;
    const size = 6 * 1024 * 1024;
    const data = new Uint8Array(size).fill(7);
    const hash = await sha256Hex(data);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "HEAD") {
        response.writeHead(200, completed
          ? { "content-length": String(size), "x-amz-meta-sha256": hash }
          : { "content-length": String(size) });
        response.end();
        return;
      }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        initiated = true;
        response.writeHead(200); response.end("<UploadId>upload-meta</UploadId>"); return;
      }
      if (request.method === "PUT") { request.resume(); request.on("end", () => { response.writeHead(200, { etag: '"part"' }); response.end(); }); return; }
      if (request.method === "POST" && url.searchParams.get("uploadId") === "upload-meta") {
        completed = true;
        request.resume(); request.on("end", () => { response.writeHead(200); response.end(); }); return;
      }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve S3 metadata test server port");
    try {
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      await transport.ensureUploadedFromChunks(hash, size, "application/octet-stream", (onChunk) => onChunk(data.buffer, 0, size));
      expect(initiated).toBe(true);
      expect(completed).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("aborts before completion when a source cannot satisfy the S3 multipart part limit", async () => {
    let initiated = false;
    let aborted = false;
    const chunkSize = 8 * 1024 * 1024;
    const size = chunkSize * 10_000 + 1;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "HEAD") { response.writeHead(404); response.end(); return; }
      if (request.method === "POST" && url.searchParams.has("uploads")) {
        initiated = true;
        response.writeHead(200); response.end("<UploadId>upload-limit</UploadId>"); return;
      }
      if (request.method === "DELETE" && url.searchParams.get("uploadId") === "upload-limit") {
        aborted = true;
        response.writeHead(204); response.end(); return;
      }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve S3 part-limit test server port");
    try {
      const transport = new S3Transport(settings({ s3Endpoint: `http://127.0.0.1:${address.port}` }), logger);
      const chunk = new ArrayBuffer(chunkSize);
      await expect(transport.ensureUploadedFromChunks("a".repeat(64), size, "application/octet-stream", (onChunk) => onChunk(chunk, 0, size))).rejects.toThrow("required");
      expect(initiated).toBe(true);
      expect(aborted).toBe(true);
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

describe("public WebDAV attachment storage", () => {
  it("stores, retrieves, and clears content-addressed public attachments under its fixed namespace", async () => {
    const objects = new Map<string, Uint8Array>();
    const methods: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
      methods.push(`${request.method} ${path}`);
      if (request.method === "MKCOL") { response.writeHead(405); response.end(); return; }
      if (request.method === "HEAD") {
        const data = objects.get(path);
        response.writeHead(data ? 200 : 404, data ? { "content-length": String(data.byteLength) } : undefined);
        response.end();
        return;
      }
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => { objects.set(path, new Uint8Array(Buffer.concat(chunks))); response.writeHead(201); response.end(); });
        return;
      }
      if (request.method === "GET") {
        const data = objects.get(path);
        if (!data) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-length": String(data.byteLength) }); response.end(data); return;
      }
      if (request.method === "DELETE" && path.endsWith("/oldeng-team-core-attachments/v1")) {
        for (const key of objects.keys()) if (key.startsWith(`${path}/`)) objects.delete(key);
        response.writeHead(204); response.end(); return;
      }
      response.writeHead(405); response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to resolve public WebDAV test server port");
    try {
      const data = new TextEncoder().encode("team attachment");
      const hash = await sha256Hex(data);
      const store = createAttachmentStore(settings({
        attachmentStorageProvider: "webdav",
        attachmentWebdavUrl: `http://127.0.0.1:${address.port}/team/`,
        attachmentWebdavUsername: "team",
        attachmentWebdavPassword: "secret"
      }), logger);
      await store.ensureUploaded(hash, data.buffer, "text/plain");
      expect(decode(await store.download(hash))).toBe("team attachment");
      const large = new Uint8Array(8 * 1024 * 1024 + 19).fill(23);
      const largeHash = await sha256Hex(large);
      await store.ensureUploadedFromChunks(largeHash, large.byteLength, "application/octet-stream", async (onChunk) => {
        const first = large.subarray(0, 8 * 1024 * 1024);
        const second = large.subarray(first.byteLength);
        await onChunk(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength), 0, large.byteLength);
        await onChunk(second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength), first.byteLength, large.byteLength);
      });
      expect(objects.get(`/team/oldeng-team-core-attachments/v1/sha256/${largeHash}`)?.byteLength).toBe(large.byteLength);
      expect(methods.some((method) => method.includes("MKCOL /team/oldeng-team-core-attachments/v1/sha256"))).toBe(true);
      expect(methods.some((method) => method.includes(`/team/oldeng-team-core-attachments/v1/sha256/${hash}`))).toBe(true);
      expect(await store.clearManagedObjects()).toBe(1);
      expect(objects.size).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
    expect(shouldProtectMismatchedLocalAttachment(false, "wangzhe", "device-a", "device-a", "wangzhe")).toBe(false);
    expect(shouldProtectMismatchedLocalAttachment(true, "wangzhe", "device-a", "device-a", "wangzhe")).toBe(true);
    expect(shouldProtectMismatchedLocalAttachment(true, "wangzhe", "device-b", "device-a", "wangzhe")).toBe(false);
    expect(shouldProtectMismatchedLocalAttachment(true, "wangzhe", undefined, "device-a", "wangzhe")).toBe(true);
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
  it("uses the index as a durable public-change journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-index-journal-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("notes/plan.md", encode("before\n"));
      await repo.commit("Base");

      await vault.write("notes/plan.md", encode("after\n"));
      await repo.stageManagedEventPath("notes/plan.md");
      expect(await repo.listPublicStagedChanges()).toEqual([{ path: "notes/plan.md", status: "modified" }]);
      expect(await repo.hasStagedPublicChanges()).toBe(true);
      await repo.commitStaged("Update vault");
      expect(await repo.listPublicStagedChanges()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not commit a staged private file alongside an indexed public event", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-index-boundary-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("notes/base.md", encode("base\n"));
      await repo.commit("Base");
      await vault.write("私人笔记/secret.md", encode("secret\n"));
      await git.add({ fs: repo.fs, dir: "", filepath: "私人笔记/secret.md" });
      await vault.write("notes/base.md", encode("updated\n"));
      await repo.stageManagedEventPath("notes/base.md");
      const commit = await repo.commitStaged("Public update");
      if (!commit) throw new Error("Expected public commit");
      const tree = await git.listFiles({ fs: repo.fs, dir: "", ref: commit });
      expect(tree).toContain("notes/base.md");
      expect(tree).not.toContain("私人笔记/secret.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Git's final worktree state to discard a move that returned home", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-actual-move-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("power/plan.md", encode("plan\n"));
      await repo.commit("Base");

      await vault.write("ml/plan.md", encode("plan\n"));
      await vault.remove("power/plan.md");
      expect(await repo.actualPublicMoves([{ from: "power/plan.md", to: "ml/plan.md" }]))
        .toEqual([{ from: "power/plan.md", to: "ml/plan.md" }]);
      expect(await repo.actualPublicDeletedPaths(["power/plan.md", "ml/plan.md"]))
        .toEqual(["power/plan.md"]);

      await vault.write("power/plan.md", encode("plan\n"));
      await vault.remove("ml/plan.md");
      expect(await repo.actualPublicMoves([{ from: "power/plan.md", to: "ml/plan.md" }])).toEqual([]);
      expect(await repo.actualPublicDeletedPaths(["power/plan.md", "ml/plan.md"]))
        .toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores only selected deleted paths from HEAD without reverting other edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-restore-selected-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("notes/restore.md", encode("restore this\n"));
      await vault.write("notes/keep.md", encode("keep base\n"));
      await repo.commit("Base");

      await vault.remove("notes/restore.md");
      await vault.write("notes/keep.md", encode("keep local edit\n"));

      expect(await repo.restoreManagedPathsFromHead(["notes/restore.md"])).toEqual(["notes/restore.md"]);
      expect(decode(await vault.read("notes/restore.md"))).toBe("restore this\n");
      expect(decode(await vault.read("notes/keep.md"))).toBe("keep local edit\n");
      expect(await repo.hasUncommittedChanges()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages an event-derived public batch without enumerating private folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-fast-stage-"));
    try {
      const initial = new NodeVault(root);
      const bootstrap = new GitRepository(initial, settings(), logger, ".obsidian");
      await bootstrap.init();
      await initial.write("notes/a.md", encode("before"));
      await bootstrap.commit("Base");
      await initial.write("私人笔记/deep/one.md", encode("private"));
      const vault = new ListCountingVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await vault.write("notes/a.md", encode("after"));
      vault.listed.length = 0;
      await repo.commit("Incremental", [], ["notes/a.md"]);
      // isomorphic-git reads the Vault root to resolve the requested path,
      // but its filtered status walk must not descend into private notes.
      expect(vault.listed.some((path) => path.startsWith("私人笔记/"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes a remote merge without enumerating private folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-fast-merge-"));
    try {
      await createDivergence(root, { "base.md": "base\n" }, { "local.md": "local\n" }, { "remote.md": "remote\n" });
      const seeded = new NodeVault(root);
      await seeded.write("私人笔记/nested/secret.md", encode("private"));
      const vault = new ListCountingVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      vault.listed.length = 0;
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      expect(decode(await vault.read("remote.md"))).toBe("remote\n");
      expect(vault.listed.some((path) => path === "私人笔记" || path.startsWith("私人笔记/"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not read personal plugin files for a remote Markdown-only merge", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-fast-personal-plugin-merge-"));
    try {
      await createDivergence(root, { "base.md": "base\n" }, { "local.md": "local\n" }, { "remote.md": "remote\n" });
      const seeded = new NodeVault(root);
      await seeded.write(".obsidian/plugins/personal/cache.bin", encode("local-only plugin cache"));
      const vault = new CountingVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      vault.reads.length = 0;
      expect(await repo.mergeRemote()).toEqual({ merged: true, conflicts: [] });
      expect(vault.reads.some((path) => path.startsWith(".obsidian/plugins/personal/"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a staged-only private blob before committing an unrelated public change", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-staged-private-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian");
      await repo.init();
      await vault.write("notes/base.md", encode("base"));
      await repo.commit("Base");
      await writeFile(join(root, "private-index-source"), "do not publish");
      const { stdout } = await execFileAsync("git", ["-C", root, "hash-object", "-w", "private-index-source"]);
      await rm(join(root, "private-index-source"));
      await execFileAsync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `100644,${stdout.trim()},私人笔记/staged-only.md`]);
      await vault.write("notes/public.md", encode("safe public change"));
      await repo.commit("Public change");
      const files = await git.listFiles({ fs: repo.fs, dir: "", ref: "HEAD" });
      expect(files).toContain("notes/public.md");
      expect(files).not.toContain("私人笔记/staged-only.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("reconciles direct writes from whitelisted plugins without staging Team Core settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-direct-plugin-config-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian", ["calendar"]);
      await repo.init();
      await repo.ensureGitignore();
      await vault.write(".obsidian/plugins/calendar/data.json", encode('{"weekStart":1}\n'));
      await vault.write(".obsidian/plugins/team-core/data.json", encode('{"gitPassword":"local-only"}\n'));
      await repo.commit("Base shared plugin configuration");
      expect(await readSharedPluginIdsFromGitignore(decode(await vault.read(".gitignore")), ".obsidian")).toEqual(["calendar"]);
      expect(await git.listFiles({ fs: repo.fs, dir: "", ref: "HEAD" })).toContain(".obsidian/plugins/calendar/data.json");

      // Simulate a community plugin writing straight to its adapter rather
      // than through an Obsidian Vault event.
      await vault.write(".obsidian/plugins/calendar/data.json", encode('{"weekStart":0}\n'));
      await vault.write(".obsidian/plugins/team-core/data.json", encode('{"gitPassword":"still-local"}\n'));
      expect(await repo.stageSharedPluginWorktreeChanges()).toEqual([".obsidian/plugins/calendar/data.json"]);
      expect(await repo.listPublicStagedChanges()).toEqual([{ path: ".obsidian/plugins/calendar/data.json", status: "modified" }]);
      await repo.commitStaged("Sync shared plugin configuration");
      const files = await git.listFiles({ fs: repo.fs, dir: "", ref: "HEAD" });
      expect(files).toContain(".obsidian/plugins/calendar/data.json");
      expect(files).not.toContain(".obsidian/plugins/team-core/data.json");
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
      expect(await git.getConfig({ fs: repo.fs, dir: "", path: "core.filemode" })).toBe(false);
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

      // Team Core opts out of executable-bit tracking for knowledge-base
      // files and repairs an already staged same-blob mode-only entry.
      await execFileAsync("git", ["-C", root, "update-index", "--chmod=+x", "notes/readme.md"]);
      await repo.configureWorktreeMode();
      expect(await repo.listPublicWorktreeChanges()).toEqual([]);
      expect(await repo.hasManagedPathChanges(["notes/readme.md"])).toBe(false);
      expect(await repo.hasUncommittedChanges()).toBe(false);
      expect(await repo.recoverManagedWorktree()).toEqual({
        changedManagedPaths: [],
        hasBoundaryRepair: false,
        hasChanges: false
      });

      await vault.write("notes/readme.md", new TextEncoder().encode("second\n").buffer);
      expect(await repo.hasManagedPathChanges(["notes/readme.md"])).toBe(true);
      expect(await repo.hasUncommittedChanges()).toBe(true);
      expect(await repo.listPublicWorktreeChanges()).toEqual([
        { path: "notes/readme.md", status: "modified" }
      ]);
      expect(await repo.recoverManagedWorktree()).toEqual({
        changedManagedPaths: ["notes/readme.md"],
        hasBoundaryRepair: false,
        hasChanges: true
      });
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

  it("summarizes document, shared-plugin, and attachment changes without exposing implementation paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "team-core-commit-changes-"));
    try {
      const vault = new NodeVault(root);
      const repo = new GitRepository(vault, settings(), logger, ".obsidian", ["calendar"]);
      await repo.init();
      await repo.ensureGitignore();
      await vault.write("notes/readme.md", encode("base\n"));
      await vault.write(".obsidian/plugins/calendar/manifest.json", encode(JSON.stringify({ id: "calendar", name: "Calendar" })));
      await vault.write(".obsidian/plugins/calendar/main.js", encode("base plugin\n"));
      const first = await repo.commit("Initial shared content");
      if (!first) throw new Error("Expected initial commit");
      await expect(repo.commitChanges(first)).resolves.toMatchObject({
        markdownPaths: ["notes/readme.md"],
        pluginNames: ["Calendar"],
        attachmentDocumentPaths: []
      });

      await vault.write("notes/readme.md", encode("![[assets/image.png]]\n"));
      await vault.write(".obsidian/plugins/calendar/main.js", encode("updated plugin\n"));
      await vault.write(".team/assets-manifest.json", encode(serializeManifest(validateManifest({
        version: 1,
        files: {
          "assets/image.png": {
            sha256: "a".repeat(64),
            size: 12,
            mime: "image/png",
            uploadedAt: "2026-09-02T00:00:00.000Z",
            uploadedBy: "alice"
          }
        }
      }))));
      const second = await repo.commit("Update shared content");
      if (!second) throw new Error("Expected update commit");

      expect(await repo.commitChanges(second)).toMatchObject({
        markdownPaths: ["notes/readme.md"],
        documentChanges: [{
          path: "notes/readme.md",
          status: "modified",
          previousLineCount: 1,
          currentLineCount: 1
        }],
        pluginNames: ["Calendar"],
        pluginChanges: [{ name: "Calendar", changedFileCount: 1 }],
        attachmentDocumentPaths: ["notes/readme.md"],
        hasUnassociatedAttachmentChanges: false,
        sharedPluginStateChanged: false,
        fileAuthorsChanged: false,
        sharedPluginRulesChanged: false,
        hasOtherChanges: false
      });
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
