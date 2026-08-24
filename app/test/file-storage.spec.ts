/**
 * The local storage adapter: ranged reads, and what it refuses to resolve.
 *
 * Serving goes through this adapter rather than the filesystem, so the key
 * containment that used to sit in the route is now the adapter's own — and a
 * key reaches it from a URL, from the `file` table and from a disk listing.
 *
 * Run with:
 *   bunx --bun vitest run test/file-storage.spec.ts
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileStorage, type FileStorageAdapter } from "#files/storage.ts";

// Its own root, and no touching of the process adapter: the server project runs
// `isolate: false`, so a spec that changed either would change it for every
// spec after it.
let root: string;
let storage: FileStorageAdapter;
const SPACE = "space_1";
const BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vektor-storage-"));
  storage = createLocalFileStorage(root);
  await storage.put(SPACE, "ab/file.bin", BODY);
  // A sibling space, to have something worth escaping towards.
  mkdirSync(join(root, "space_2"), { recursive: true });
  writeFileSync(join(root, "space_2", "secret.txt"), "not yours");
  mkdirSync(join(root, SPACE, "adir"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function collect(stream: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  if (!stream) throw new Error("expected a stream");
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

describe("stat", () => {
  it("reports size without reading the bytes", async () => {
    const info = await storage.stat(SPACE, "ab/file.bin");
    expect(info?.size).toBe(BODY.byteLength);
    expect(info?.updatedAt).toBeInstanceOf(Date);
  });

  it("is null for a key that is not stored", async () => {
    expect(await storage.stat(SPACE, "ab/missing.bin")).toBeNull();
  });

  it("is null for a directory, which is not a stored object", async () => {
    expect(await storage.stat(SPACE, "adir")).toBeNull();
  });
});

describe("readStream", () => {
  it("streams the whole object", async () => {
    expect(await collect(await storage.readStream(SPACE, "ab/file.bin"))).toEqual(BODY);
  });

  it("streams an inclusive byte range, as HTTP means it", async () => {
    const out = await collect(
      await storage.readStream(SPACE, "ab/file.bin", { start: 0, end: 3 }),
    );
    expect(out.toString()).toBe("0123");
    expect(out.byteLength).toBe(4);
  });

  it("streams a range that ends at the last byte", async () => {
    const end = BODY.byteLength - 1;
    const out = await collect(
      await storage.readStream(SPACE, "ab/file.bin", { start: end - 2, end }),
    );
    expect(out.toString()).toBe("xyz");
  });

  it("is null — not a failing stream — for a missing key", async () => {
    // The body is already the response by the time a stream errors, so a miss
    // has to be answerable before one is handed out.
    expect(await storage.readStream(SPACE, "ab/missing.bin")).toBeNull();
  });
});

describe("key containment", () => {
  const escapes = [
    "../space_2/secret.txt",
    "ab/../../space_2/secret.txt",
    "/etc/passwd",
    "..",
  ];

  for (const key of escapes) {
    it(`refuses to resolve ${JSON.stringify(key)}`, async () => {
      expect(await storage.stat(SPACE, key)).toBeNull();
      expect(await storage.read(SPACE, key)).toBeNull();
      expect(await storage.readStream(SPACE, key)).toBeNull();
    });
  }

  it("does not delete outside the space", async () => {
    const victim = join(root, "space_2", "secret.txt");
    await storage.delete(SPACE, "../space_2/secret.txt");
    expect(existsSync(victim)).toBe(true);
  });

  it("throws rather than silently writing outside the space", async () => {
    await expect(
      storage.put(SPACE, "../space_2/planted.txt", Buffer.from("x")),
    ).rejects.toThrow(/outside the space/);
    expect(existsSync(join(root, "space_2", "planted.txt"))).toBe(false);
  });

  it("still resolves an ordinary nested key", async () => {
    expect(await storage.read(SPACE, "ab/file.bin")).toEqual(BODY);
  });
});
