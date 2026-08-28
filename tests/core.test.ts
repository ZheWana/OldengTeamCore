import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, rename, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exportSettings, importSettings } from "../src/config";
import { base64UrlDecode, base64UrlEncode, sha256Hex } from "../src/crypto";
import { conflictFilesFromError, GitRepository, isNonFastForwardPushError, isPushReconciliationError, normalizeGitUrl, normalizeRemoteInfo } from "../src/git";
import { createEmptyManifest, mergeAssetManifests, serializeManifest, validateManifest } from "../src/manifest";
import { S3Transport } from "../src/s3";
import { pushWithNonFastForwardRetry, shouldMaterializeRemoteAttachment, shouldProtectMismatchedLocalAttachment, shouldTrackVaultEvent } from "../src/sync";
import { assetPathForHash, collectMarkdownReferences, hashFromAssetPath, isAssetPath, isConfigPath, isManagedPath, isPrivatePath, legacyHashFromAssetPath, normalizeVaultPath, rewriteAssetReferences } from "../src/vault";
import { readSharedPluginIdsFromGitignore, updateSharedPluginsInGitignore } from "../src/shared-plugins";
import { DEFAULT_SETTINGS, type Logger, type TeamCoreSettings } from "../src/types";
import type { BinaryVault } from "../src/vault";
import git from "isomorphic-git";

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

describe("manifest and vault path rules", () => {
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
    expect(normalizeVaultPath("/notes\\../assets//a.png")).toBe("assets/a.png");
    expect(isAssetPath("assets/a.png")).toBe(true);
    expect(isManagedPath("notes/readme.md")).toBe(true);
    expect(isManagedPath("assets/a.png")).toBe(false);
    expect(isPrivatePath("私人笔记/秘密.md")).toBe(true);
    expect(isManagedPath("私人笔记/秘密.md")).toBe(false);
    expect(isPrivatePath("私人笔记")).toBe(true);
    expect(isPrivatePath("私人笔记备份/公开.md")).toBe(false);
    expect(isPrivatePath("Private/legacy.md")).toBe(false);
    expect(isManagedPath("Private/legacy.md")).toBe(true);
    expect(isPrivatePath("PrivateNotes/visible.md")).toBe(false);
    expect(isConfigPath(".settings/plugins/team-core/data.json", ".settings")).toBe(true);
    expect(isManagedPath(".settings/plugins/team-core/data.json", ".settings")).toBe(false);
    expect(isManagedPath(".settings/plugins/calendar/main.js", ".settings", ["calendar"])).toBe(true);
    expect(isManagedPath(".settings/plugins/dataview/main.js", ".settings", ["calendar"])).toBe(false);
    expect(isManagedPath(".settings/community-plugins.json", ".settings", ["calendar"])).toBe(false);
    expect(isConfigPath(".settings-backup/visible.md", ".settings")).toBe(false);
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
  });

  it("tracks S3 attachments and only whitelisted configuration paths", () => {
    expect(shouldTrackVaultEvent("assets/new-image.png", ".obsidian", [])).toBe(true);
    expect(shouldTrackVaultEvent("notes/readme.md", ".obsidian", [])).toBe(true);
    expect(shouldTrackVaultEvent(".obsidian/plugins/calendar/main.js", ".obsidian", ["calendar"])).toBe(true);
    expect(shouldTrackVaultEvent(".obsidian/plugins/dataview/main.js", ".obsidian", ["calendar"])).toBe(false);
    expect(shouldTrackVaultEvent(".obsidian/plugins/team-core/data.json", ".obsidian", ["team-core"])).toBe(false);
    expect(shouldTrackVaultEvent("私人笔记/private.md", ".obsidian", [])).toBe(false);
    expect(shouldTrackVaultEvent(".team/assets-manifest.json", ".obsidian", [])).toBe(false);
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
});

describe("S3 transport", () => {
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
      expect(gitignore).not.toContain("Private/\n");
      await vault.write("notes/readme.md", new TextEncoder().encode("first\n").buffer);
      await vault.write("私人笔记/秘密.md", new TextEncoder().encode("never sync\n").buffer);

      const first = await repo.commit("Initial vault");
      expect(first).toMatch(/^[0-9a-f]{40}$/);
      expect(await repo.hasUncommittedChanges()).toBe(false);
      expect(await repo.commit("Private note must stay local")).toBeUndefined();

      await vault.write("notes/readme.md", new TextEncoder().encode("second\n").buffer);
      expect(await repo.hasUncommittedChanges()).toBe(true);
      const second = await repo.commit("Update note");
      expect(second).toMatch(/^[0-9a-f]{40}$/);

      const history = await repo.log("notes/readme.md", 10);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ message: "Update note", author: "Alice.Example", email: "alice.example@knowledgebase.local" });
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
