import { requestUrl, type RequestUrlParam } from "obsidian";
import { createSHA256 } from "hash-wasm";
import { sha256Hex } from "./crypto";
import { S3NotFoundError, S3Transport, type ChunkDownloadTarget, type ChunkUploadSource } from "./s3";
import type { Logger, TeamCoreSettings } from "./types";
import { VAULT_TRANSFER_CHUNK_SIZE } from "./vault";

export type { ChunkDownloadTarget, ChunkUploadSource } from "./s3";

export interface AttachmentStore {
  enabled(): boolean;
  ensureUploaded(hash: string, data: ArrayBuffer, mime: string): Promise<void>;
  ensureUploadedFromChunks(hash: string, size: number, mime: string, source: ChunkUploadSource): Promise<void>;
  download(hash: string): Promise<ArrayBuffer>;
  downloadInChunks(hash: string, expectedSize: number, onChunk: ChunkDownloadTarget): Promise<void>;
  clearManagedObjects(onDeleted?: (key: string) => void): Promise<number>;
  removeObject(hash: string): Promise<void>;
  managedObjectLocation(): string;
}

const WEB_DAV_ATTACHMENT_ROOT = "oldeng-team-core-attachments/v1";

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function basicAuthorization(username: string, password: string): string | undefined {
  if (!username && !password) return undefined;
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

class WebDavAttachmentStore implements AttachmentStore {
  private readonly root: string;
  private readonly authorization: string | undefined;

  constructor(settings: TeamCoreSettings, private readonly logger: Logger) {
    const address = settings.attachmentWebdavUrl.trim();
    if (!address) throw new Error("公共附件 WebDAV 地址未配置");
    try { this.root = new URL(address.endsWith("/") ? address : `${address}/`).toString(); }
    catch { throw new Error("公共附件 WebDAV 地址无效"); }
    this.authorization = basicAuthorization(settings.attachmentWebdavUsername, settings.attachmentWebdavPassword);
  }

  enabled(): boolean { return Boolean(this.root); }
  managedObjectLocation(): string { return WEB_DAV_ATTACHMENT_ROOT; }

  async ensureUploaded(hash: string, data: ArrayBuffer, mime: string): Promise<void> {
    this.validateHash(hash);
    await this.initialize();
    const path = this.objectPath(hash);
    const existing = await this.request("HEAD", path);
    if (existing.status >= 200 && existing.status < 300 && Number(existing.headers["content-length"] ?? 0) === data.byteLength) return;
    if (existing.status !== 404 && (existing.status < 200 || existing.status >= 300)) throw this.httpError("HEAD", path, existing.status);
    if (await sha256Hex(data) !== hash.toLowerCase()) throw new Error(`附件在上传前已变化：${hash}`);
    const response = await this.request("PUT", path, data, mime);
    if (response.status < 200 || response.status >= 300) throw this.httpError("PUT", path, response.status);
    await this.verifySize(path, data.byteLength);
  }

  async ensureUploadedFromChunks(hash: string, size: number, mime: string, source: ChunkUploadSource): Promise<void> {
    this.validateHash(hash);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`公共附件大小无效：${hash}`);
    await this.initialize();
    const path = this.objectPath(hash);
    const existing = await this.request("HEAD", path);
    if (existing.status >= 200 && existing.status < 300 && Number(existing.headers["content-length"] ?? 0) === size) return;
    if (existing.status !== 404 && (existing.status < 200 || existing.status >= 300)) throw this.httpError("HEAD", path, existing.status);
    await this.putFromChunks(path, hash, size, mime, source);
    await this.verifySize(path, size);
  }

  async download(hash: string): Promise<ArrayBuffer> {
    this.validateHash(hash);
    const path = this.objectPath(hash);
    const response = await this.request("GET", path);
    if (response.status === 404) throw new S3NotFoundError(path);
    if (response.status < 200 || response.status >= 300) throw this.httpError("GET", path, response.status);
    if (await sha256Hex(response.arrayBuffer) !== hash.toLowerCase()) throw new Error(`WebDAV 附件哈希校验失败：${path}`);
    return response.arrayBuffer;
  }

  async downloadInChunks(hash: string, expectedSize: number, onChunk: ChunkDownloadTarget): Promise<void> {
    this.validateHash(hash);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error(`公共附件大小无效：${hash}`);
    const path = this.objectPath(hash);
    const hasher = await createSHA256();
    hasher.init();
    let offset = 0;
    while (offset < expectedSize) {
      const end = Math.min(offset + VAULT_TRANSFER_CHUNK_SIZE, expectedSize) - 1;
      const response = await this.request("GET", path, undefined, undefined, { range: `bytes=${offset}-${end}` });
      if (response.status === 404) throw new S3NotFoundError(path);
      if (response.status !== 206) throw new Error(`WebDAV 未支持公共附件安全分片下载（HTTP ${response.status}）：${path}`);
      const contentRange = response.headers["content-range"] ?? "";
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!range || Number(range[1]) !== offset || Number(range[2]) !== end || Number(range[3]) !== expectedSize || response.arrayBuffer.byteLength !== end - offset + 1) {
        throw new Error(`WebDAV 公共附件分片响应无效：${path}`);
      }
      hasher.update(new Uint8Array(response.arrayBuffer));
      await onChunk(response.arrayBuffer, offset, expectedSize);
      offset = end + 1;
    }
    if (hasher.digest() !== hash.toLowerCase()) throw new Error(`WebDAV 附件哈希校验失败：${path}`);
  }

  async clearManagedObjects(onDeleted?: (key: string) => void): Promise<number> {
    const response = await this.request("DELETE", WEB_DAV_ATTACHMENT_ROOT);
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw this.httpError("DELETE", WEB_DAV_ATTACHMENT_ROOT, response.status);
    if (response.status !== 404) onDeleted?.(WEB_DAV_ATTACHMENT_ROOT);
    return response.status === 404 ? 0 : 1;
  }

  async removeObject(hash: string): Promise<void> {
    this.validateHash(hash);
    const response = await this.request("DELETE", this.objectPath(hash));
    if (response.status !== 404 && (response.status < 200 || response.status >= 300)) throw this.httpError("DELETE", this.objectPath(hash), response.status);
  }

  private async initialize(): Promise<void> {
    let collection = "";
    for (const segment of [...WEB_DAV_ATTACHMENT_ROOT.split("/"), "sha256"]) {
      collection = collection ? `${collection}/${segment}` : segment;
      const response = await this.request("MKCOL", collection);
      if (![200, 201, 204, 405].includes(response.status)) throw this.httpError("MKCOL", collection, response.status);
    }
  }

  private objectPath(hash: string): string { return `${WEB_DAV_ATTACHMENT_ROOT}/sha256/${hash.toLowerCase()}`; }
  private validateHash(hash: string): void { if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error("附件 SHA-256 无效"); }

  private async verifySize(path: string, size: number): Promise<void> {
    const response = await this.request("HEAD", path);
    if (response.status < 200 || response.status >= 300 || Number(response.headers["content-length"] ?? 0) !== size) throw new Error(`WebDAV 公共附件上传校验失败：${path}`);
  }

  private async putFromChunks(path: string, sha256: string, size: number, mime: string, source: ChunkUploadSource): Promise<void> {
    const url = this.url(path);
    const headers: Record<string, string> = { "cache-control": "no-cache", "content-type": mime };
    if (this.authorization) headers.authorization = this.authorization;
    const hasher = await createSHA256();
    hasher.init();
    let offset = 0;
    let wake: (() => void) | undefined;
    let cancelled = false;
    let resolveProducer: () => void;
    let rejectProducer: (error: unknown) => void;
    const producer = new Promise<void>((resolve, reject) => { resolveProducer = resolve; rejectProducer = reject; });
    const cancel = (error: unknown): void => {
      if (cancelled) return;
      cancelled = true;
      wake?.();
      wake = undefined;
      rejectProducer(error);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          try {
            await source(async (chunk, chunkOffset, total) => {
              if (cancelled || total !== size || chunkOffset !== offset || !chunk.byteLength || offset + chunk.byteLength > size) throw new Error(`公共附件上传源在传输期间发生变化：${path}`);
              while (!cancelled && controller.desiredSize !== null && controller.desiredSize <= 0) await new Promise<void>((resolve) => { wake = resolve; });
              if (cancelled) throw new Error(`公共附件大文件上传已取消：${path}`);
              hasher.update(new Uint8Array(chunk));
              controller.enqueue(new Uint8Array(chunk));
              offset += chunk.byteLength;
            });
            if (offset !== size || hasher.digest() !== sha256.toLowerCase()) throw new Error(`公共附件在上传期间已被修改：${path}`);
            controller.close();
            resolveProducer();
          } catch (error) {
            cancel(error);
            controller.error(error);
          }
        })();
      },
      pull: () => { wake?.(); wake = undefined; },
      cancel: () => cancel(new Error(`公共附件大文件上传已取消：${path}`))
    });
    let response: Response;
    try { response = await window.fetch(url, { method: "PUT", headers, body: stream, duplex: "half" } as RequestInit & { duplex: string }); }
    catch (error) { cancel(error); await producer.catch(() => undefined); throw error; }
    // Do not treat a server that responds before consuming the body as a valid object write.
    if (offset !== size || cancelled) {
      const error = new Error(`WebDAV 在完整上传前返回响应：${path}`);
      cancel(error);
      await producer.catch(() => undefined);
      throw error;
    }
    await producer;
    if (response.status < 200 || response.status >= 300) throw this.httpError("PUT", path, response.status);
  }

  private async request(method: string, path: string, body?: ArrayBuffer, contentType?: string, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { "cache-control": "no-cache", ...extraHeaders };
    if (this.authorization) headers.authorization = this.authorization;
    if (contentType) headers["content-type"] = contentType;
    this.logger.debug("Public attachment WebDAV request", { method, path, size: body?.byteLength });
    return requestUrl({ url: this.url(path), method, headers, body, throw: false } satisfies RequestUrlParam);
  }

  private url(path: string): string { return new URL(encodedPath(path), this.root).toString(); }
  private httpError(method: string, path: string, status: number): Error { return new Error(`WebDAV ${method} ${path} 失败（HTTP ${status}）`); }
}

export function createAttachmentStore(settings: TeamCoreSettings, logger: Logger): AttachmentStore {
  return settings.attachmentStorageProvider === "webdav"
    ? new WebDavAttachmentStore(settings, logger)
    : new S3Transport(settings, logger);
}
