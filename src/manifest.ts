import { MANIFEST_PATH, MANIFEST_VERSION } from "./constants";
import { normalizeVaultPath, type BinaryVault } from "./vault";
import type { AssetManifest, AssetManifestEntry } from "./types";

export function createEmptyManifest(): AssetManifest {
  return { version: MANIFEST_VERSION, files: {} };
}

export function validateManifest(value: unknown): AssetManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest must be an object");
  const input = value as Record<string, unknown>;
  if (input.version !== MANIFEST_VERSION || !input.files || typeof input.files !== "object") throw new Error("Unsupported manifest version or shape");
  const files: Record<string, AssetManifestEntry> = {};
  for (const [rawPath, rawEntry] of Object.entries(input.files as Record<string, unknown>)) {
    const path = normalizeVaultPath(rawPath);
    if (!path.startsWith("assets/")) throw new Error(`Manifest path is not an asset: ${rawPath}`);
    if (!rawEntry || typeof rawEntry !== "object") throw new Error(`Invalid manifest entry: ${rawPath}`);
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Invalid SHA-256 for ${rawPath}`);
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid size for ${rawPath}`);
    if (typeof entry.mime !== "string" || !entry.mime) throw new Error(`Invalid MIME for ${rawPath}`);
    if (typeof entry.uploadedAt !== "string" || Number.isNaN(Date.parse(entry.uploadedAt))) throw new Error(`Invalid upload time for ${rawPath}`);
    if (typeof entry.uploadedBy !== "string" || !entry.uploadedBy.trim()) throw new Error(`Invalid uploader for ${rawPath}`);
    files[path] = {
      sha256: entry.sha256,
      size: entry.size,
      mime: entry.mime,
      uploadedAt: new Date(entry.uploadedAt).toISOString(),
      uploadedBy: entry.uploadedBy
    };
  }
  return { version: MANIFEST_VERSION, files };
}

export function serializeManifest(manifest: AssetManifest): string {
  const valid = validateManifest(manifest);
  const files = Object.fromEntries(Object.entries(valid.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, entry]));
  return `${JSON.stringify({ version: MANIFEST_VERSION, files }, null, 2)}\n`;
}

export async function readManifest(vault: BinaryVault): Promise<AssetManifest> {
  if (!(await vault.exists(MANIFEST_PATH))) return createEmptyManifest();
  const bytes = await vault.read(MANIFEST_PATH);
  const text = new TextDecoder().decode(bytes);
  return validateManifest(JSON.parse(text));
}

export async function writeManifest(vault: BinaryVault, manifest: AssetManifest): Promise<void> {
  const text = serializeManifest(manifest);
  await vault.mkdir(".team");
  const encoded = new TextEncoder().encode(text);
  await vault.write(MANIFEST_PATH, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
}

export function updateManifestEntry(manifest: AssetManifest, path: string, entry: AssetManifestEntry): AssetManifest {
  return { version: MANIFEST_VERSION, files: { ...manifest.files, [normalizeVaultPath(path)]: entry } };
}

export function removeManifestEntry(manifest: AssetManifest, path: string): AssetManifest {
  const files = { ...manifest.files };
  delete files[normalizeVaultPath(path)];
  return { version: MANIFEST_VERSION, files };
}

function entriesEqual(left: AssetManifestEntry | undefined, right: AssetManifestEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.sha256 === right.sha256
    && left.size === right.size
    && left.mime === right.mime
    && left.uploadedAt === right.uploadedAt
    && left.uploadedBy === right.uploadedBy;
}

function equivalentAsset(left: AssetManifestEntry | undefined, right: AssetManifestEntry | undefined): boolean {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size);
}

function deterministicEntry(left: AssetManifestEntry, right: AssetManifestEntry): AssetManifestEntry {
  return JSON.stringify(left).localeCompare(JSON.stringify(right)) <= 0 ? left : right;
}

/**
 * Three-way merge for the shared attachment manifest. Independent logical
 * paths are safe to combine; competing changes to one path remain a conflict.
 */
export function mergeAssetManifests(base: AssetManifest, ours: AssetManifest, theirs: AssetManifest): AssetManifest | undefined {
  const validBase = validateManifest(base);
  const validOurs = validateManifest(ours);
  const validTheirs = validateManifest(theirs);
  const files: Record<string, AssetManifestEntry> = {};
  const paths = new Set([...Object.keys(validBase.files), ...Object.keys(validOurs.files), ...Object.keys(validTheirs.files)]);

  for (const path of paths) {
    const baseEntry = validBase.files[path];
    const ourEntry = validOurs.files[path];
    const theirEntry = validTheirs.files[path];
    let merged: AssetManifestEntry | undefined;
    if (entriesEqual(ourEntry, theirEntry)) merged = ourEntry;
    else if (ourEntry && theirEntry && equivalentAsset(ourEntry, theirEntry)) merged = deterministicEntry(ourEntry, theirEntry);
    else if (entriesEqual(ourEntry, baseEntry)) merged = theirEntry;
    else if (entriesEqual(theirEntry, baseEntry)) merged = ourEntry;
    else return undefined;
    if (merged) files[path] = merged;
  }

  return { version: MANIFEST_VERSION, files };
}
