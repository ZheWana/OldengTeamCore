import { requestUrl, type RequestUrlParam } from "obsidian";
import { createSHA256 } from "hash-wasm";
import { hmacSha256, sha256Hex, bytesToHex } from "./crypto";
import type { Logger, TeamCoreSettings } from "./types";
import type { PrivateIndexWriteResult, PrivateRemoteIndex } from "./private-sync";

export class S3NotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`S3 object not found: ${key}`);
    this.name = "S3NotFoundError";
  }
}

export class S3PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3PermanentError";
  }
}

interface S3Response {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export const S3_DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const S3_CHUNKED_DOWNLOAD_THRESHOLD = S3_DOWNLOAD_CHUNK_SIZE;
const S3_MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024;
const S3_MAX_MULTIPART_PARTS = 10_000;
const S3_SHA256_METADATA_HEADER = "x-amz-meta-sha256";

export interface ChunkDownloadTarget {
  (chunk: ArrayBuffer, offset: number, total: number): Promise<void>;
}

export interface ChunkUploadSource {
  (onChunk: ChunkDownloadTarget): Promise<void>;
}

const encodePath = (value: string): string => value.split("/").map((part) => encodeURIComponent(part).replace(/%2F/gi, "/")).join("/");
const encodeQuery = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function utcStamp(date: Date): { short: string; long: string } {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { short: iso.slice(0, 8), long: iso.slice(0, 15) + "Z" };
}

export class S3Transport {
  private readonly endpoint: string;
  private readonly prefix: string;

  constructor(private readonly settings: TeamCoreSettings, private readonly logger: Logger) {
    this.endpoint = settings.s3Endpoint.replace(/\/+$/, "");
    this.prefix = settings.s3Prefix.replace(/^\/+|\/+$/g, "");
  }

  enabled(): boolean {
    return Boolean(this.endpoint && this.settings.s3Region && this.settings.s3Bucket && this.settings.s3AccessKey && this.settings.s3SecretKey);
  }

  objectKey(hash: string): string {
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("Invalid attachment hash");
    return [this.prefix, `sha256/${hash.toLowerCase()}`].filter(Boolean).join("/");
  }

  managedObjectPrefix(): string {
    return [this.prefix, "sha256/"].filter(Boolean).join("/");
  }

  managedObjectLocation(): string {
    return this.managedObjectPrefix();
  }

  objectUrl(hash: string): string {
    return this.urlForKey(this.objectKey(hash));
  }

  private urlForKey(key: string): string {
    const endpoint = new URL(this.endpoint);
    const bucket = this.settings.s3Bucket.toLowerCase();
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    const virtualHostedBucket = endpoint.hostname.toLowerCase() === bucket || endpoint.hostname.toLowerCase().startsWith(`${bucket}.`);
    const bucketPath = virtualHostedBucket ? "" : `/${encodeURIComponent(this.settings.s3Bucket)}`;
    return `${endpoint.origin}${basePath}${bucketPath}/${encodePath(key)}`;
  }

  async head(hash: string): Promise<{ size: number; contentType?: string; sha256?: string }> {
    const key = this.objectKey(hash);
    const response = await this.request("HEAD", key);
    if (response.status === 404) throw new S3NotFoundError(key);
    if (response.status < 200 || response.status >= 300) throw await this.httpError("HEAD", key, response);
    const size = Number(response.headers["content-length"] ?? response.headers["Content-Length"] ?? 0);
    return {
      size,
      contentType: response.headers["content-type"] ?? response.headers["Content-Type"],
      sha256: response.headers[S3_SHA256_METADATA_HEADER]?.toLowerCase()
    };
  }

  async ensureUploaded(hash: string, data: ArrayBuffer, mime: string): Promise<void> {
    const key = this.objectKey(hash);
    try {
      const existing = await this.head(hash);
      if (existing.size !== data.byteLength) throw new S3PermanentError(`S3 object size mismatch for ${key}`);
      if (existing.sha256 === hash.toLowerCase()) return;
    } catch (error) {
      if (!(error instanceof S3NotFoundError)) throw error;
    }
    const sizeLimit = 5 * 1024 * 1024 * 1024;
    if (data.byteLength > sizeLimit) throw new S3PermanentError(`Attachment exceeds single-request limit: ${key}`);
    const response = await this.request("PUT", key, data, mime, {}, { [S3_SHA256_METADATA_HEADER]: hash.toLowerCase() });
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 413) throw new S3PermanentError(`Attachment exceeds provider limit: ${key}`);
      throw await this.httpError("PUT", key, response);
    }
    const verified = await this.head(hash);
    if (verified.size !== data.byteLength || verified.sha256 !== hash.toLowerCase()) throw new S3PermanentError(`S3 upload verification failed for ${key}`);
  }

  /**
   * Uploads a content-addressed attachment through S3 multipart requests. The
   * source is read once in bounded chunks and verified before the upload is
   * completed, so an edited source can never become the object named by an
   * older SHA-256.
   */
  async ensureUploadedFromChunks(hash: string, size: number, mime: string, source: ChunkUploadSource): Promise<void> {
    await this.ensureObjectUploadedFromChunks(this.objectKey(hash), hash, size, mime, source);
  }

  /** Multipart upload for immutable private objects with a caller-supplied key. */
  async writeObjectFromChunks(key: string, hash: string, size: number, mime: string, source: ChunkUploadSource): Promise<void> {
    await this.ensureObjectUploadedFromChunks(key, hash, size, mime, source);
  }

  private async ensureObjectUploadedFromChunks(key: string, expectedHash: string, size: number, mime: string, source: ChunkUploadSource): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{64}$/i.test(expectedHash)) throw new S3PermanentError(`Invalid multipart upload metadata for ${key}`);
    const existing = await this.request("HEAD", key);
    if (existing.status >= 200 && existing.status < 300) {
      const existingSize = Number(existing.headers["content-length"] ?? 0);
      if (existingSize !== size) throw new S3PermanentError(`S3 object size mismatch for ${key}`);
      if (existing.headers[S3_SHA256_METADATA_HEADER]?.toLowerCase() === expectedHash.toLowerCase()) return;
    } else if (existing.status !== 404) {
      throw await this.httpError("HEAD", key, existing);
    }

    const minimumPartSize = Math.max(S3_MIN_MULTIPART_PART_SIZE, Math.ceil(size / S3_MAX_MULTIPART_PARTS));
    const initiated = await this.request("POST", key, undefined, mime, { uploads: "" }, { [S3_SHA256_METADATA_HEADER]: expectedHash.toLowerCase() });
    if (initiated.status < 200 || initiated.status >= 300) throw await this.httpError("POST", key, initiated);
    const uploadId = xmlTagText(new TextDecoder().decode(initiated.arrayBuffer), "UploadId");
    if (!uploadId) throw new S3PermanentError(`S3 multipart initiation returned no upload ID for ${key}`);

    const parts: Array<{ number: number; etag: string }> = [];
    const hasher = await createSHA256();
    hasher.init();
    let nextOffset = 0;
    try {
      await source(async (chunk, offset, total) => {
        if (total !== size || offset !== nextOffset || !chunk.byteLength || offset + chunk.byteLength > size) {
          throw new S3PermanentError(`S3 multipart source changed during upload: ${key}`);
        }
        if (offset + chunk.byteLength < size && chunk.byteLength < minimumPartSize) {
          throw new S3PermanentError(`S3 multipart chunk is smaller than the required ${minimumPartSize} byte part size: ${key}`);
        }
        if (parts.length >= S3_MAX_MULTIPART_PARTS) throw new S3PermanentError(`S3 multipart part limit exceeded for ${key}`);
        const number = parts.length + 1;
        const response = await this.request("PUT", key, chunk, mime, { partNumber: String(number), uploadId });
        if (response.status < 200 || response.status >= 300) throw await this.httpError("PUT", key, response);
        const etag = response.headers.etag;
        if (!etag) throw new S3PermanentError(`S3 multipart part has no ETag for ${key}`);
        hasher.update(new Uint8Array(chunk));
        parts.push({ number, etag });
        nextOffset += chunk.byteLength;
      });
      if (nextOffset !== size || hasher.digest() !== expectedHash.toLowerCase()) {
        throw new S3PermanentError(`Attachment changed while uploading: ${key}`);
      }
      const bodyText = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const body = new TextEncoder().encode(bodyText);
      const completed = await this.request("POST", key, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), "application/xml", { uploadId });
      if (completed.status < 200 || completed.status >= 300) throw await this.httpError("POST", key, completed);
      if (/<Error(?:\s|>)/.test(new TextDecoder().decode(completed.arrayBuffer))) {
        throw new S3PermanentError(`S3 multipart completion failed for ${key}`);
      }
      const verified = await this.request("HEAD", key);
      if (verified.status < 200 || verified.status >= 300 || Number(verified.headers["content-length"] ?? 0) !== size || verified.headers[S3_SHA256_METADATA_HEADER]?.toLowerCase() !== expectedHash.toLowerCase()) {
        throw new S3PermanentError(`S3 multipart upload verification failed for ${key}`);
      }
    } catch (error) {
      await this.request("DELETE", key, undefined, undefined, { uploadId }).catch(() => undefined);
      throw error;
    }
  }

  async download(hash: string): Promise<ArrayBuffer> {
    const key = this.objectKey(hash);
    const response = await this.request("GET", key);
    if (response.status === 404) throw new S3NotFoundError(key);
    if (response.status < 200 || response.status >= 300) throw await this.httpError("GET", key, response);
    this.logger.debug("S3 response received", { method: "GET", key, status: response.status, size: response.arrayBuffer.byteLength });
    this.logger.debug("S3 download hash verification started", { key, size: response.arrayBuffer.byteLength });
    const actual = await sha256Hex(response.arrayBuffer);
    if (actual !== hash.toLowerCase()) throw new S3PermanentError(`S3 hash verification failed for ${key}`);
    this.logger.debug("S3 download hash verification completed", { key, size: response.arrayBuffer.byteLength });
    return response.arrayBuffer;
  }

  async downloadInChunks(hash: string, expectedSize: number, onChunk: ChunkDownloadTarget, chunkSize = S3_DOWNLOAD_CHUNK_SIZE): Promise<void> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new S3PermanentError("Invalid expected attachment size");
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new S3PermanentError("Invalid attachment chunk size");
    const hasher = await createSHA256();
    hasher.init();
    await this.readObjectInChunks(this.objectKey(hash), expectedSize, async (chunk, offset, total) => {
      if (total !== expectedSize) throw new S3PermanentError("S3 chunk total changed during download");
      hasher.update(new Uint8Array(chunk));
      await onChunk(chunk, offset, total);
    }, chunkSize);
    const actual = hasher.digest();
    if (actual !== hash.toLowerCase()) throw new S3PermanentError(`S3 hash verification failed for ${this.objectKey(hash)}`);
  }

  /** Range-download an arbitrary private object without retaining the whole body. */
  async readObjectInChunks(key: string, expectedSize: number, onChunk: ChunkDownloadTarget, chunkSize = S3_DOWNLOAD_CHUNK_SIZE): Promise<void> {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new S3PermanentError("Invalid expected object size");
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new S3PermanentError("Invalid S3 chunk size");
    const head = await this.request("HEAD", key);
    if (head.status === 404) throw new S3NotFoundError(key);
    if (head.status < 200 || head.status >= 300) throw await this.httpError("HEAD", key, head);
    const remoteSize = Number(head.headers["content-length"] ?? 0);
    if (remoteSize !== expectedSize) throw new S3PermanentError(`S3 object size mismatch for ${key}`);
    let offset = 0;
    while (offset < expectedSize) {
      const end = Math.min(offset + chunkSize, expectedSize) - 1;
      const response = await this.request("GET", key, undefined, undefined, {}, { range: `bytes=${offset}-${end}` });
      if (response.status === 404) throw new S3NotFoundError(key);
      if (response.status < 200 || response.status >= 300) throw await this.httpError("GET", key, response);
      if (response.status !== 206) throw new S3PermanentError(`S3 range request was not honored for ${key}`);
      const expectedChunkSize = end - offset + 1;
      const contentRange = response.headers["content-range"] ?? "";
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== end || Number(range[3]) !== expectedSize || response.arrayBuffer.byteLength !== expectedChunkSize) {
        throw new S3PermanentError(`S3 range response was invalid for ${key}`);
      }
      await onChunk(response.arrayBuffer, offset, expectedSize);
      this.logger.debug("S3 download chunk completed", { key, offset, size: expectedChunkSize, total: expectedSize });
      offset = end + 1;
    }
  }

  async listManagedObjects(): Promise<string[]> {
    const keys: string[] = [];
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: this.managedObjectPrefix() };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.request("GET", "", undefined, undefined, query);
      if (response.status < 200 || response.status >= 300) throw await this.httpError("LIST", this.managedObjectPrefix(), response);
      const document = new DOMParser().parseFromString(new TextDecoder().decode(response.arrayBuffer), "application/xml");
      if (document.getElementsByTagName("parsererror").length) throw new S3PermanentError("S3 object listing returned invalid XML");
      for (const element of Array.from(document.getElementsByTagName("Key"))) {
        const key = element.textContent ?? "";
        if (key.startsWith(this.managedObjectPrefix())) keys.push(key);
      }
      const truncated = document.getElementsByTagName("IsTruncated")[0]?.textContent?.trim().toLowerCase() === "true";
      const nextToken = document.getElementsByTagName("NextContinuationToken")[0]?.textContent?.trim();
      if (!truncated) continuationToken = undefined;
      else if (!nextToken || seenTokens.has(nextToken)) throw new S3PermanentError("S3 object listing pagination is invalid");
      else {
        seenTokens.add(nextToken);
        continuationToken = nextToken;
      }
    } while (continuationToken);
    return keys;
  }

  async deleteManagedObjects(keys: readonly string[], onDeleted?: (key: string) => void): Promise<void> {
    const prefix = this.managedObjectPrefix();
    for (const key of keys) {
      if (!key.startsWith(prefix)) throw new S3PermanentError(`Refusing to delete object outside Oldeng Team Core prefix: ${key}`);
      const response = await this.request("DELETE", key);
      if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw await this.httpError("DELETE", key, response);
      onDeleted?.(key);
    }
  }

  async clearManagedObjects(onDeleted?: (key: string) => void): Promise<number> {
    const keys = await this.listManagedObjects();
    await this.deleteManagedObjects(keys, onDeleted);
    return keys.length;
  }

  /** General object operations used only by the user-owned private-note store. */
  async readObject(key: string): Promise<ArrayBuffer | undefined> {
    return (await this.readObjectWithVersion(key)).data;
  }

  async readObjectWithVersion(key: string): Promise<PrivateRemoteIndex> {
    const response = await this.request("GET", key);
    if (response.status === 404) return { data: undefined, version: undefined };
    if (response.status < 200 || response.status >= 300) throw await this.httpError("GET", key, response);
    const version = response.headers.etag;
    if (!version) throw new Error(`S3 未返回 ETag，无法安全同步私人笔记：${key}`);
    return { data: response.arrayBuffer, version };
  }

  async writeObject(key: string, data: ArrayBuffer, contentType = "application/octet-stream"): Promise<void> {
    const response = await this.request("PUT", key, data, contentType);
    if (response.status < 200 || response.status >= 300) throw await this.httpError("PUT", key, response);
  }

  async writeObjectIfUnchanged(key: string, data: ArrayBuffer, contentType: string, version: string | undefined): Promise<PrivateIndexWriteResult> {
    const condition: Record<string, string> = version ? { "if-match": version } : { "if-none-match": "*" };
    const response = await this.request("PUT", key, data, contentType, {}, condition);
    if (response.status === 409 || response.status === 412) return "conflict";
    if (response.status < 200 || response.status >= 300) throw await this.httpError("PUT", key, response);
    return "written";
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw await this.httpError("DELETE", key, response);
  }

  async removeObject(hash: string): Promise<void> {
    await this.deleteObject(this.objectKey(hash));
  }

  private async request(method: string, key: string, body?: ArrayBuffer, contentType?: string, query: Record<string, string> = {}, extraHeaders: Record<string, string> = {}): Promise<S3Response> {
    if (!this.enabled()) throw new Error("S3 settings are incomplete");
    const canonicalQuery = Object.entries(query)
      .map(([name, value]) => [encodeQuery(name), encodeQuery(value)] as const)
      .sort(([leftName, leftValue], [rightName, rightValue]) => compareAscii(leftName, rightName) || compareAscii(leftValue, rightValue))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const url = `${this.urlForKey(key)}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const parsed = new URL(url);
    const now = new Date();
    const stamp = utcStamp(now);
    const payloadHash = body ? await sha256Hex(body) : await sha256Hex("");
    const headers: Record<string, string> = {
      host: parsed.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp.long
    };
    if (contentType) headers["content-type"] = contentType;
    for (const [name, value] of Object.entries(extraHeaders)) headers[name.toLowerCase()] = value;
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join("");
    const canonicalRequest = [method, parsed.pathname, canonicalQuery, canonicalHeaders, signedHeaderNames.join(";"), payloadHash].join("\n");
    const scope = `${stamp.short}/${this.settings.s3Region}/s3/aws4_request`;
    const signingKey = await this.signingKey(stamp.short);
    const signature = bytesToHex(await hmacSha256(signingKey, `AWS4-HMAC-SHA256\n${stamp.long}\n${scope}\n${await sha256Hex(canonicalRequest)}`));
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.settings.s3AccessKey}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;
    delete headers.host;
    const request: RequestUrlParam = { url, method, headers, body, throw: false };
    this.logger.debug(`${method} S3 object`, { key, size: body?.byteLength });
    const response = await requestUrl(request);
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) responseHeaders[name.toLowerCase()] = String(value);
    return { status: response.status, headers: responseHeaders, arrayBuffer: response.arrayBuffer };
  }

  private async signingKey(date: string): Promise<ArrayBuffer> {
    const dateKey = await hmacSha256(`AWS4${this.settings.s3SecretKey}`, date);
    const regionKey = await hmacSha256(dateKey, this.settings.s3Region);
    const serviceKey = await hmacSha256(regionKey, "s3");
    return hmacSha256(serviceKey, "aws4_request");
  }

  private async httpError(method: string, key: string, response: S3Response): Promise<Error> {
    if (response.status === 413) return new S3PermanentError(`Attachment exceeds provider limit: ${key}`);
    return new Error(`${method} ${key} failed with HTTP ${response.status}`);
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character] ?? character);
}

function xmlTagText(document: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]+)</${name}>`).exec(document);
  return match?.[1]?.trim();
}
