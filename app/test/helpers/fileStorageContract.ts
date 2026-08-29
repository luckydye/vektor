/**
 * The behaviour every {@link FileStorageAdapter} owes its callers, run against
 * each implementation.
 *
 * Serving, text extraction and image probing all go through this interface
 * rather than the filesystem, so a backend that differs here differs for the
 * whole application — and the containment rules are a security boundary, not a
 * convenience.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { FileStorageAdapter } from "#files/storage.ts";

export async function collectStream(
  stream: ReadableStream<Uint8Array> | null,
): Promise<Buffer> {
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

export interface FileStorageContext {
  storage: FileStorageAdapter;
  /** The space under test. */
  space: string;
  /** A second space, to have something worth escaping towards. */
  neighbour: string;
}

const BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
const KEY = "ab/file.bin";
const NEIGHBOUR_KEY = "cd/secret.bin";

/**
 * `context` is a getter rather than a value: the suite is registered before the
 * spec's own `beforeAll` has built the adapter.
 */
export function describeFileStorageContract(
  name: string,
  context: () => FileStorageContext,
): void {
  describe(name, () => {
    beforeAll(async () => {
      const { storage, space, neighbour } = context();
      await storage.put(space, KEY, BODY);
      await storage.put(neighbour, NEIGHBOUR_KEY, Buffer.from("not yours"));
    });

    describe("stat", () => {
      it("reports size without reading the bytes", async () => {
        const { storage, space } = context();
        const info = await storage.stat(space, KEY);
        expect(info?.size).toBe(BODY.byteLength);
        expect(info?.updatedAt).toBeInstanceOf(Date);
      });

      it("is null for a key that is not stored", async () => {
        const { storage, space } = context();
        expect(await storage.stat(space, "ab/missing.bin")).toBeNull();
      });
    });

    describe("read", () => {
      it("returns the whole object", async () => {
        const { storage, space } = context();
        expect(await storage.read(space, KEY)).toEqual(BODY);
      });

      it("is null for a key that is not stored", async () => {
        const { storage, space } = context();
        expect(await storage.read(space, "ab/missing.bin")).toBeNull();
      });
    });

    describe("readStream", () => {
      it("streams the whole object", async () => {
        const { storage, space } = context();
        expect(await collectStream(await storage.readStream(space, KEY))).toEqual(BODY);
      });

      it("streams an inclusive byte range, as HTTP means it", async () => {
        const { storage, space } = context();
        const out = await collectStream(
          await storage.readStream(space, KEY, { start: 0, end: 3 }),
        );
        expect(out.toString()).toBe("0123");
        expect(out.byteLength).toBe(4);
      });

      it("streams a range that ends at the last byte", async () => {
        const { storage, space } = context();
        const end = BODY.byteLength - 1;
        const out = await collectStream(
          await storage.readStream(space, KEY, { start: end - 2, end }),
        );
        expect(out.toString()).toBe("xyz");
      });

      it("is null — not a failing stream — for a missing key", async () => {
        // The body is already the response by the time a stream errors, so a
        // miss has to be answerable before one is handed out.
        const { storage, space } = context();
        expect(await storage.readStream(space, "ab/missing.bin")).toBeNull();
      });
    });

    describe("putHashed", () => {
      it("stores under the digest of its own bytes and reports the size", async () => {
        const { storage, space } = context();
        const payload = Buffer.from(`hashed-${name}`);
        const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
        const stored = await storage.putHashed(
          space,
          "bin",
          new Response(payload).body as ReadableStream<Uint8Array>,
        );

        expect(stored.key).toBe(`${digest.slice(0, 2)}/${digest}.bin`);
        expect(stored.size).toBe(payload.byteLength);
        expect(stored.url).toBe(storage.url(space, stored.key));
        expect(await storage.read(space, stored.key)).toEqual(payload);
      });
    });

    describe("list", () => {
      it("reports the content-addressable keys of that space alone", async () => {
        const { storage, space } = context();
        const listed = await storage.list(space);
        const entry = listed.find((file) => file.key === KEY);
        expect(entry?.size).toBe(BODY.byteLength);
        expect(listed.some((file) => file.key === NEIGHBOUR_KEY)).toBe(false);
      });
    });

    describe("delete", () => {
      it("removes the object", async () => {
        const { storage, space } = context();
        await storage.put(space, "ef/doomed.bin", Buffer.from("x"));
        await storage.delete(space, "ef/doomed.bin");
        expect(await storage.stat(space, "ef/doomed.bin")).toBeNull();
      });
    });

    describe("key containment", () => {
      const escapes = [
        "../space_2/secret.bin",
        "ab/../../space_2/secret.bin",
        "/etc/passwd",
        "..",
      ];

      for (const key of escapes) {
        it(`refuses to resolve ${JSON.stringify(key)}`, async () => {
          const { storage, space } = context();
          expect(await storage.stat(space, key)).toBeNull();
          expect(await storage.read(space, key)).toBeNull();
          expect(await storage.readStream(space, key)).toBeNull();
        });
      }

      it("does not reach a neighbouring space", async () => {
        const { storage, space, neighbour } = context();
        expect(await storage.read(space, `../${neighbour}/${NEIGHBOUR_KEY}`)).toBeNull();
      });

      it("does not delete outside the space", async () => {
        const { storage, space, neighbour } = context();
        await storage.delete(space, `../${neighbour}/${NEIGHBOUR_KEY}`);
        expect(await storage.stat(neighbour, NEIGHBOUR_KEY)).not.toBeNull();
      });

      it("throws rather than silently writing outside the space", async () => {
        const { storage, space, neighbour } = context();
        await expect(
          storage.put(space, `../${neighbour}/planted.bin`, Buffer.from("x")),
        ).rejects.toThrow(/outside the space/);
        expect(await storage.stat(neighbour, "planted.bin")).toBeNull();
      });

      it("still resolves an ordinary nested key", async () => {
        const { storage, space } = context();
        expect(await storage.read(space, KEY)).toEqual(BODY);
      });
    });
  });
}
