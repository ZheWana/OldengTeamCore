import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportSettings, importSettings } from "../src/config";
import { base64UrlDecode, base64UrlEncode, sha256Hex } from "../src/crypto";
import { GitRepository, normalizeGitUrl, normalizeRemoteInfo } from "../src/git";
import { createEmptyManifest, serializeManifest, validateManifest } from "../src/manifest";
import { S3Transport } from "../src/s3";
import { shouldMaterializeRemoteAttachment, shouldProtectMismatchedLocalAttachment } from "../src/sync";
import { assetPathForHash, collectMarkdownReferences, hashFromAssetPath, isAssetPath, isConfigPath, isManagedPath, isPrivatePath, legacyHashFromAssetPath, normalizeVaultPath, rewriteAssetReferences } from "../src/vault";
import { DEFAULT_SETTINGS, type Logger, type TeamCoreSettings } from "../src/types";
import type { BinaryVault } from "../src/vault";
import { compareVersions, validatePluginReleaseIndex } from "../src/updater";

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

describe("plugin release updates", () => {
  const release = (version: string) => ({
    version,
    minAppVersion: "1.5.0",
    publishedAt: "2026-08-27T00:00:00.000Z",
    notes: "test release",
    files: Object.fromEntries(["main.js", "manifest.json", "styles.css"].map((name) => [name, {
      path: `releases/${version}/${name}`,
      sha256: "a".repeat(64),
      size: 10
    }]))
  });

  it("compares stable and prerelease semantic versions", () => {
    expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
  });

  it("accepts exactly two ordered releases and rejects redirected file paths", () => {
    const index = validatePluginReleaseIndex({ schemaVersion: 1, pluginId: "team-core", latest: release("0.1.1"), previous: release("0.1.0") }, "team-core");
    expect(index.latest.version).toBe("0.1.1");
    expect(index.previous?.version).toBe("0.1.0");

    const invalid = release("0.1.2");
    invalid.files["main.js"].path = "https://example.test/main.js";
    expect(() => validatePluginReleaseIndex({ schemaVersion: 1, pluginId: "team-core", latest: invalid, previous: release("0.1.1") }, "team-core")).toThrow("路径");
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
    expect(isConfigPath(".settings-backup/visible.md", ".settings")).toBe(false);
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

describe("Git repository adapter", () => {
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
});
