import {
  get,
  put,
  list,
  BlobError,
  BlobPreconditionFailedError,
} from "@vercel/blob";
import { StoreError } from "./store";

const JSON_LIMIT = 16 * 1024 * 1024;
const BINARY_LIMIT = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
export type CloudStorageSDK = Pick<
  typeof import("@vercel/blob"),
  "get" | "put" | "list"
>;

function keyPath(key: string, prefix = false): void {
  const path = prefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if (prefix && key === "") return;
  if (
    !path ||
    key.length > 1024 ||
    path
      .split("/")
      .some(
        (segment) =>
          !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(segment) ||
          segment.includes(".."),
      )
  )
    throw new StoreError("Invalid storage key", 400);
}

function etag(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    /[\r\n]/.test(value)
  ) {
    throw new StoreError("Storage returned an invalid revision", 503);
  }
  return value;
}

function storageError(error: unknown): never {
  if (error instanceof StoreError) throw error;
  if (
    error instanceof BlobPreconditionFailedError ||
    (error instanceof BlobError &&
      /\b(?:blob|file) already exists\b/i.test(error.message))
  ) {
    throw new StoreError(
      "Saved data changed. Reload it before saving again.",
      409,
    );
  }
  // SDK errors may include URLs and credentials; never relay their messages.
  throw new StoreError("Cloud storage is unavailable. Please try again.", 503);
}

function contentLength(headers: Pick<Headers, "get">): number | null {
  const encoding = headers.get("content-encoding");
  const raw = headers.get("content-length");
  if ((encoding && encoding.toLowerCase() !== "identity") || raw === null)
    return null;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new StoreError("Storage returned an invalid file size", 503);
  }
  return Number(raw);
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  size: number | null,
  limit: number,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
      throw new StoreError("Storage returned an invalid file size", 503);
    }
    if (size !== null && size > limit)
      throw new StoreError("Stored file exceeds the size limit", 413);
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new StoreError("Invalid storage stream", 503);
      length += value.byteLength;
      if (length > limit)
        throw new StoreError("Stored file exceeds the size limit", 413);
      chunks.push(Buffer.from(value));
    }
    if (size !== null && size !== length)
      throw new StoreError("Stored file was incomplete", 503);
    return Buffer.concat(chunks, length);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Private durable storage. Callers own authentication and validation of JSON schemas. */
export function createCloudStorage(sdk: CloudStorageSDK = { get, put, list }) {
  async function read(key: string, limit: number) {
    keyPath(key);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > JSON_LIMIT) {
      throw new StoreError("Invalid storage read limit", 400);
    }
    try {
      const result = await sdk.get(key, {
        access: "private",
        useCache: false,
        // Compressed CDN responses use weak ETags, which cannot authorize CAS writes.
        // Request the original representation so the ETag belongs to stored bytes.
        headers: { "accept-encoding": "identity" },
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!result) return null;
      if (result.statusCode !== 200 || !result.stream) {
        throw new StoreError("Storage returned an unexpected response", 503);
      }
      // The revision and bytes belong to this one response; a separate head() races writers.
      let revision: string;
      let expectedLength: number | null;
      try {
        revision = etag(result.blob.etag);
        expectedLength = contentLength(result.headers);
      } catch (error) {
        await result.stream.cancel().catch(() => undefined);
        throw error;
      }
      return {
        // SDK blob.size is zero when Content-Length is absent, and encoded
        // Content-Length counts compressed bytes while fetch streams decoded bytes.
        bytes: await consume(result.stream, expectedLength, limit),
        etag: revision,
      };
    } catch (error) {
      storageError(error);
    }
  }

  async function write(
    key: string,
    bytes: Buffer,
    contentType: string,
    expectedEtag: string | null,
  ) {
    keyPath(key);
    if (expectedEtag !== null) etag(expectedEtag);
    if (expectedEtag?.startsWith("W/")) {
      throw new StoreError(
        "Storage returned a revision that cannot be updated safely. Reload and try again.",
        503,
      );
    }
    try {
      const result = await sdk.put(key, bytes, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: expectedEtag !== null,
        ...(expectedEtag !== null ? { ifMatch: expectedEtag } : {}),
        contentType,
        cacheControlMaxAge: 60,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { etag: etag(result.etag) };
    } catch (error) {
      storageError(error);
    }
  }

  return {
    async readJSON<T>(key: string): Promise<{ value: T; etag: string } | null> {
      const result = await read(key, JSON_LIMIT);
      if (!result) return null;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          result.bytes,
        );
        return { value: JSON.parse(text) as T, etag: result.etag };
      } catch {
        throw new StoreError(
          "Saved data is corrupt. It has not been changed.",
          503,
        );
      }
    },
    async writeJSON(
      key: string,
      value: unknown,
      expectedEtag: string | null,
    ): Promise<{ etag: string }> {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch {
        throw new StoreError("Data cannot be saved as JSON", 400);
      }
      if (serialized === undefined)
        throw new StoreError("Data cannot be saved as JSON", 400);
      if (Buffer.byteLength(serialized) > JSON_LIMIT)
        throw new StoreError("JSON exceeds the size limit", 413);
      return write(
        key,
        Buffer.from(serialized),
        "application/json",
        expectedEtag,
      );
    },
    async readBytes(key: string, limit: number): Promise<Buffer> {
      const result = await read(key, limit);
      if (!result) throw new StoreError("Stored file not found", 404);
      return result.bytes;
    },
    async writeBytes(
      key: string,
      bytes: Buffer,
      contentType: string,
    ): Promise<{ etag: string }> {
      if (!Buffer.isBuffer(bytes))
        throw new StoreError("Invalid file data", 400);
      if (bytes.length > BINARY_LIMIT)
        throw new StoreError("File exceeds the size limit", 413);
      if (
        !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) ||
        contentType.length > 127
      ) {
        throw new StoreError("Invalid file content type", 400);
      }
      return write(key, bytes, contentType, null);
    },
    async listKeys(
      prefix: string,
      limit = 200,
    ): Promise<{ keys: string[]; truncated: boolean }> {
      keyPath(prefix, true);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new StoreError("Invalid listing limit", 400);
      const keys: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const page = await sdk.list({
            prefix,
            limit: limit - keys.length,
            cursor,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
          });
          for (const blob of page.blobs) {
            keyPath(blob.pathname);
            if (
              !blob.pathname.startsWith(prefix) ||
              keys.includes(blob.pathname)
            ) {
              throw new StoreError("Storage returned an invalid listing", 503);
            }
            if (keys.length === limit) return { keys, truncated: true };
            keys.push(blob.pathname);
          }
          if (!page.hasMore) return { keys, truncated: false };
          if (keys.length === limit) return { keys, truncated: true };
          if (!page.cursor || cursors.has(page.cursor) || !page.blobs.length) {
            throw new StoreError("Storage listing could not be completed", 503);
          }
          cursor = page.cursor;
          cursors.add(cursor);
        } while (true);
      } catch (error) {
        storageError(error);
      }
    },
  };
}

export const { readJSON, writeJSON, readBytes, writeBytes, listKeys } =
  createCloudStorage();
