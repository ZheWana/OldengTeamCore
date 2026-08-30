import { requestUrl, type RequestUrlParam } from "obsidian";
import { hmacSha256, sha256Hex, bytesToHex } from "./crypto";
import type { Logger, TeamCoreSettings } from "./types";

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

  async head(hash: string): Promise<{ size: number; contentType?: string }> {
    const key = this.objectKey(hash);
    const response = await this.request("HEAD", key);
    if (response.status === 404) throw new S3NotFoundError(key);
    if (response.status < 200 || response.status >= 300) throw await this.httpError("HEAD", key, response);
    const size = Number(response.headers["content-length"] ?? response.headers["Content-Length"] ?? 0);
    return { size, contentType: response.headers["content-type"] ?? response.headers["Content-Type"] };
  }

  async ensureUploaded(hash: string, data: ArrayBuffer, mime: string): Promise<void> {
    const key = this.objectKey(hash);
    try {
      const existing = await this.head(hash);
      if (existing.size !== data.byteLength) throw new S3PermanentError(`S3 object size mismatch for ${key}`);
      return;
    } catch (error) {
      if (!(error instanceof S3NotFoundError)) throw error;
    }
    const sizeLimit = 5 * 1024 * 1024 * 1024;
    if (data.byteLength > sizeLimit) throw new S3PermanentError(`Attachment exceeds single-request limit: ${key}`);
    const response = await this.request("PUT", key, data, mime);
    if (response.status < 200 || response.status >= 300) {
      if (response.status === 413) throw new S3PermanentError(`Attachment exceeds provider limit: ${key}`);
      throw await this.httpError("PUT", key, response);
    }
    const verified = await this.head(hash);
    if (verified.size !== data.byteLength) throw new S3PermanentError(`S3 upload verification failed for ${key}`);
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

  private async request(method: string, key: string, body?: ArrayBuffer, contentType?: string, query: Record<string, string> = {}): Promise<S3Response> {
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
