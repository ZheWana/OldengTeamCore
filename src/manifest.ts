import { MANIFEST_PATH, MANIFEST_VERSION } from "./constants";
import { normalizeVaultPath, type BinaryVault } from "./vault";
import type { AssetManifest, AssetManifestEntry, AssetRetentionRecord } from "./types";

export function createEmptyManifest(): AssetManifest {
  return { version: MANIFEST_VERSION, files: {}, retired: {} };
}

export function assetObjectId(entry: Pick<AssetManifestEntry | AssetRetentionRecord, "sha256" | "size">): string {
  return `${entry.sha256}:${entry.size}`;
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
    if (entry.uploadedFrom !== undefined && (typeof entry.uploadedFrom !== "string" || !/^[a-z0-9]{24,128}$/i.test(entry.uploadedFrom))) {
      throw new Error(`Invalid uploader installation for ${rawPath}`);
    }
    files[path] = {
      sha256: entry.sha256,
      size: entry.size,
      mime: entry.mime,
      uploadedAt: new Date(entry.uploadedAt).toISOString(),
      uploadedBy: entry.uploadedBy,
      ...(entry.uploadedFrom ? { uploadedFrom: entry.uploadedFrom } : {})
    };
  }
  const retired: Record<string, AssetRetentionRecord> = {};
  // `retired` was introduced as a backwards-compatible extension to v1. A
  // legacy manifest is still valid and gains an empty shared tombstone set.
  if (input.retired !== undefined) {
    if (!input.retired || typeof input.retired !== "object" || Array.isArray(input.retired)) throw new Error("Invalid retired attachment records");
    for (const [rawId, rawRecord] of Object.entries(input.retired as Record<string, unknown>)) {
      if (!rawRecord || typeof rawRecord !== "object") throw new Error(`Invalid retired attachment record: ${rawId}`);
      const record = rawRecord as Record<string, unknown>;
      if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(record.sha256)) throw new Error(`Invalid retired SHA-256: ${rawId}`);
      if (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0) throw new Error(`Invalid retired attachment size: ${rawId}`);
      if (typeof record.markedAt !== "string" || Number.isNaN(Date.parse(record.markedAt))) throw new Error(`Invalid retired attachment time: ${rawId}`);
      const normalized: AssetRetentionRecord = {
        sha256: record.sha256.toLowerCase(),
        size: record.size,
        markedAt: new Date(record.markedAt).toISOString()
      };
      if (rawId !== assetObjectId(normalized)) throw new Error(`Invalid retired attachment identifier: ${rawId}`);
      retired[rawId] = normalized;
    }
  }
  return { version: MANIFEST_VERSION, files, retired };
}

export function serializeManifest(manifest: AssetManifest): string {
  const valid = validateManifest(manifest);
  const files = Object.fromEntries(Object.entries(valid.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, entry]));
  const retired = Object.fromEntries(Object.entries(valid.retired).sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, entry]));
  return `${JSON.stringify({ version: MANIFEST_VERSION, files, retired }, null, 2)}\n`;
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
  return { version: MANIFEST_VERSION, files: { ...manifest.files, [normalizeVaultPath(path)]: entry }, retired: { ...manifest.retired } };
}

export function removeManifestEntry(manifest: AssetManifest, path: string): AssetManifest {
  const files = { ...manifest.files };
  delete files[normalizeVaultPath(path)];
  return { version: MANIFEST_VERSION, files, retired: { ...manifest.retired } };
}

function entriesEqual(left: AssetManifestEntry | undefined, right: AssetManifestEntry | undefined): boolean {
  if (!left || !right) return left === right;
  return left.sha256 === right.sha256
    && left.size === right.size
    && left.mime === right.mime
    && left.uploadedAt === right.uploadedAt
    && left.uploadedBy === right.uploadedBy
    && left.uploadedFrom === right.uploadedFrom;
}

function equivalentAsset(left: AssetManifestEntry | undefined, right: AssetManifestEntry | undefined): boolean {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size);
}

function deterministicEntry(left: AssetManifestEntry, right: AssetManifestEntry): AssetManifestEntry {
  return JSON.stringify(left).localeCompare(JSON.stringify(right)) <= 0 ? left : right;
}

function retentionEqual(left: AssetRetentionRecord | undefined, right: AssetRetentionRecord | undefined): boolean {
  if (!left || !right) return left === right;
  return left.sha256 === right.sha256 && left.size === right.size && left.markedAt === right.markedAt;
}

function mergeRetentionRecord(base: AssetRetentionRecord | undefined, ours: AssetRetentionRecord | undefined, theirs: AssetRetentionRecord | undefined): AssetRetentionRecord | undefined {
  if (retentionEqual(ours, theirs)) return ours;
  if (retentionEqual(ours, base)) return theirs;
  if (retentionEqual(theirs, base)) return ours;
  if (!ours) return theirs;
  if (!theirs) return ours;
  // Concurrent retirements of identical content keep the first retirement
  // time: the shared recovery window starts at the first actual deletion.
  return ours.markedAt.localeCompare(theirs.markedAt) <= 0 ? ours : theirs;
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

  const activeObjectIds = new Set(Object.values(files).map(assetObjectId));
  const retired: Record<string, AssetRetentionRecord> = {};
  const retiredIds = new Set([
    ...Object.keys(validBase.retired),
    ...Object.keys(validOurs.retired),
    ...Object.keys(validTheirs.retired)
  ]);
  for (const id of retiredIds) {
    if (activeObjectIds.has(id)) continue;
    const merged = mergeRetentionRecord(validBase.retired[id], validOurs.retired[id], validTheirs.retired[id]);
    if (merged) retired[id] = merged;
  }

  return { version: MANIFEST_VERSION, files, retired };
}
