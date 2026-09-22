import assert from "node:assert/strict";
import test from "node:test";
import {
  BlobError,
  BlobPreconditionFailedError,
  type GetBlobResult,
} from "@vercel/blob";
import { createCloudStorage, type CloudStorageSDK } from "../lib/cloud-storage";
import { StoreError } from "../lib/store";

const status = (expected: number) => (error: unknown) =>
  error instanceof StoreError && error.status === expected;
function response(
  bytes: Buffer,
  options: {
    size?: number;
    etag?: string;
    cancel?: () => void;
    headers?: HeadersInit;
  } = {},
): GetBlobResult {
  return {
    statusCode: 200,
    headers: new Headers(
      options.headers ?? {
        "content-length": String(options.size ?? bytes.length),
      },
    ),
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
      },
      pull(controller) {
        controller.close();
      },
      cancel() {
        options.cancel?.();
      },
    }),
    blob: {
      url: "https://private.example/object",
      downloadUrl: "https://private.example/object",
      pathname: "object",
      contentDisposition: "attachment",
      cacheControl: "private",
      uploadedAt: new Date(),
      etag: options.etag ?? '"revision-1"',
      contentType: "application/json",
      size: options.size ?? bytes.length,
    },
  };
}
function sdk(overrides: Partial<CloudStorageSDK> = {}): CloudStorageSDK {
  return {
    get: async () => null,
    put: async () => {
      throw new Error("unexpected put");
    },
    list: (async () => ({
      blobs: [],
      hasMore: false,
    })) as CloudStorageSDK["list"],
    ...overrides,
  };
}

test("JSON read returns bytes and revision from one uncached private response", async () => {
  let calls = 0;
  const storage = createCloudStorage(
    sdk({
      get: async (key, options) => {
        calls++;
        assert.equal(key, "reviews/run_1/T01-1.json");
        assert.equal(options.access, "private");
        assert.equal(options.useCache, false);
        assert.equal(
          new Headers(options.headers).get("accept-encoding"),
          "identity",
        );
        assert.ok(options.abortSignal instanceof AbortSignal);
        return response(Buffer.from('{"note":"saved"}'));
      },
    }),
  );
  assert.deepEqual(await storage.readJSON("reviews/run_1/T01-1.json"), {
    value: { note: "saved" },
    etag: '"revision-1"',
  });
  assert.equal(calls, 1);
});

test("missing JSON is absent; missing binary is a 404", async () => {
  const storage = createCloudStorage(sdk());
  assert.equal(await storage.readJSON("reviews/missing.json"), null);
  await assert.rejects(storage.readBytes("runs/missing.jpg", 100), status(404));
});

test("safe keys reject traversal, URL addressing, escaped separators, and hidden segments", async () => {
  let calls = 0;
  const storage = createCloudStorage(
    sdk({
      get: async () => {
        calls++;
        return null;
      },
    }),
  );
  for (const key of [
    "",
    "/root",
    "a//b",
    "a/../b",
    "a/./b",
    "a\\b",
    "a%2fb",
    "https://host/key",
    ".env",
    "a\u0000b",
    "a/",
    "a/" + "x".repeat(201),
  ]) {
    await assert.rejects(storage.readJSON(key), status(400));
  }
  assert.equal(calls, 0);
});

test("oversized advertised bodies are cancelled before consumption", async () => {
  let cancelled = false;
  const storage = createCloudStorage(
    sdk({
      get: async () =>
        response(Buffer.from("x"), {
          size: 17 * 1024 * 1024,
          cancel: () => {
            cancelled = true;
          },
        }),
    }),
  );
  await assert.rejects(storage.readJSON("run/result.json"), status(413));
  assert.equal(cancelled, true);
});

test("stream bounds reject dishonest sizes and partial responses", async () => {
  const oversized = createCloudStorage(
    sdk({ get: async () => response(Buffer.from("12345"), { size: 1 }) }),
  );
  await assert.rejects(oversized.readBytes("x.jpg", 4), status(413));
  const incomplete = createCloudStorage(
    sdk({ get: async () => response(Buffer.from("123"), { size: 4 }) }),
  );
  await assert.rejects(incomplete.readBytes("x.jpg", 4), status(503));
});

test("invalid JSON and malformed UTF-8 cannot become replacement data", async () => {
  for (const bytes of [Buffer.from("{"), Buffer.from([34, 0xff, 34])]) {
    const storage = createCloudStorage(
      sdk({ get: async () => response(bytes) }),
    );
    await assert.rejects(storage.readJSON("run/result.json"), status(503));
  }
});

test("chunked and compressed Blob responses use decoded stream bounds instead of SDK size", async () => {
  const bytes = Buffer.from(JSON.stringify({ note: "saved ".repeat(200) }));
  const headerCases: Record<string, string>[] = [
    { "content-encoding": "br", "transfer-encoding": "chunked" },
    { "content-encoding": "br", "content-length": "40" },
    { "transfer-encoding": "chunked" },
  ];
  for (const headers of headerCases) {
    const storage = createCloudStorage(
      sdk({ get: async () => response(bytes, { size: 0, headers }) }),
    );
    assert.deepEqual(
      (await storage.readJSON("index.json"))?.value,
      JSON.parse(bytes.toString()),
    );
    await assert.rejects(storage.readBytes("index.json", 100), status(413));
  }
});

test("weak response revisions cannot trigger unsafe or misleading conditional writes", async () => {
  let writes = 0;
  const storage = createCloudStorage(
    sdk({
      put: async () => {
        writes++;
        throw new Error("unexpected");
      },
    }),
  );
  await assert.rejects(
    storage.writeJSON("note.json", {}, 'W/"revision"'),
    status(503),
  );
  assert.equal(writes, 0);
});

test("creates are immutable and updates use CAS; returned revision is the write revision", async () => {
  const optionsSeen: Parameters<CloudStorageSDK["put"]>[2][] = [];
  const storage = createCloudStorage(
    sdk({
      put: async (key, bytes, options) => {
        assert.ok(Buffer.isBuffer(bytes));
        optionsSeen.push(options);
        return {
          url: "private",
          downloadUrl: "private",
          pathname: key,
          contentType: options.contentType!,
          contentDisposition: "attachment",
          etag: '"write-version"',
        };
      },
    }),
  );
  assert.deepEqual(
    await storage.writeJSON("notes/one.json", { note: "new" }, null),
    { etag: '"write-version"' },
  );
  await storage.writeJSON(
    "notes/one.json",
    { note: "updated" },
    '"read-version"',
  );
  await storage.writeBytes(
    "runs/image.jpg",
    Buffer.from([0xff, 0xd8]),
    "image/jpeg",
  );
  assert.deepEqual(
    optionsSeen.map((options) => [
      options.access,
      options.allowOverwrite,
      options.addRandomSuffix,
      options.ifMatch,
    ]),
    [
      ["private", false, false, undefined],
      ["private", true, false, '"read-version"'],
      ["private", false, false, undefined],
    ],
  );
});

test("concurrent readers cannot overwrite the winning save", async () => {
  let saved = Buffer.from('{"note":"original"}');
  let revision = '"one"';
  const storage = createCloudStorage(
    sdk({
      get: async () => response(saved, { etag: revision }),
      put: async (key, bytes, options) => {
        if (options.ifMatch !== revision)
          throw new BlobPreconditionFailedError();
        saved = Buffer.from(bytes as Buffer);
        revision = '"two"';
        return {
          url: "private",
          downloadUrl: "private",
          pathname: key,
          contentType: "application/json",
          contentDisposition: "attachment",
          etag: revision,
        };
      },
    }),
  );
  const [first, second] = await Promise.all([
    storage.readJSON("note.json"),
    storage.readJSON("note.json"),
  ]);
  await storage.writeJSON("note.json", { note: "winner" }, first!.etag);
  await assert.rejects(
    storage.writeJSON("note.json", { note: "loser" }, second!.etag),
    status(409),
  );
  assert.deepEqual((await storage.readJSON("note.json"))?.value, {
    note: "winner",
  });
});

test("provider failures conceal secrets while preserving conflict responses", async () => {
  for (const error of [
    new BlobPreconditionFailedError(),
    new BlobError("This blob already exists"),
  ]) {
    const storage = createCloudStorage(
      sdk({
        put: async () => {
          throw error;
        },
      }),
    );
    await assert.rejects(storage.writeJSON("x.json", {}, null), status(409));
  }
  const storage = createCloudStorage(
    sdk({
      get: async () => {
        throw new Error("secret-token private-url");
      },
    }),
  );
  await assert.rejects(storage.readJSON("x.json"), (error: unknown) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /secret|private-url/);
    return true;
  });
});

test("invalid revisions and oversized writes fail without replacing data", async () => {
  let calls = 0;
  const storage = createCloudStorage(
    sdk({
      put: async () => {
        calls++;
        throw new Error("unexpected");
      },
    }),
  );
  await assert.rejects(storage.writeJSON("x.json", {}, ""), status(503));
  await assert.rejects(
    storage.writeJSON("x.json", undefined, null),
    status(400),
  );
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(
    storage.writeJSON("x.json", circular, null),
    status(400),
  );
  await assert.rejects(
    storage.writeJSON("x.json", "x".repeat(16 * 1024 * 1024), null),
    status(413),
  );
  await assert.rejects(
    storage.writeBytes(
      "x.jpg",
      Buffer.alloc(10 * 1024 * 1024 + 1),
      "image/jpeg",
    ),
    status(413),
  );
  await assert.rejects(
    storage.writeBytes(
      "x.jpg",
      Buffer.alloc(1),
      "image/jpeg\r\nCookie: invalid",
    ),
    status(400),
  );
  assert.equal(calls, 0);
});

const listed = (pathname: string) => ({
  pathname,
  url: "private",
  downloadUrl: "private",
  uploadedAt: new Date(),
  size: 1,
  etag: '"one"',
});
test("listing paginates to its bound and reports truncation", async () => {
  const pages: Array<{ cursor?: string; limit?: number }> = [];
  const storage = createCloudStorage(
    sdk({
      list: (async (options: { cursor?: string; limit?: number }) => {
        pages.push(options);
        return options.cursor
          ? {
              blobs: [listed("runs/b.json")],
              hasMore: true,
              cursor: "next-again",
            }
          : { blobs: [listed("runs/a.json")], hasMore: true, cursor: "next" };
      }) as CloudStorageSDK["list"],
    }),
  );
  assert.deepEqual(await storage.listKeys("runs/", 2), {
    keys: ["runs/a.json", "runs/b.json"],
    truncated: true,
  });
  assert.deepEqual(
    pages.map(({ cursor, limit }) => [cursor, limit]),
    [
      [undefined, 2],
      ["next", 1],
    ],
  );
});

test("empty and complete listings succeed; stalled or out-of-prefix listings fail", async () => {
  assert.deepEqual(await createCloudStorage(sdk()).listKeys("runs/"), {
    keys: [],
    truncated: false,
  });
  const complete = createCloudStorage(
    sdk({
      list: (async () => ({
        blobs: [listed("runs/a")],
        hasMore: false,
      })) as CloudStorageSDK["list"],
    }),
  );
  assert.deepEqual(await complete.listKeys("runs/", 1), {
    keys: ["runs/a"],
    truncated: false,
  });
  for (const page of [
    { blobs: [], hasMore: true, cursor: "next" },
    { blobs: [listed("other/a")], hasMore: false },
  ]) {
    const storage = createCloudStorage(
      sdk({ list: (async () => page) as CloudStorageSDK["list"] }),
    );
    await assert.rejects(storage.listKeys("runs/"), status(503));
  }
});
