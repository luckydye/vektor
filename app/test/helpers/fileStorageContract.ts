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

      it("reports a quoted entity tag, stable across calls", async () => {
        const { storage, space } = context();
        const first = await storage.stat(space, KEY);
        const second = await storage.stat(space, KEY);
        expect(first?.etag).toMatch(/^"..*"$/);
        expect(second?.etag).toBe(first?.etag);
      });

      it("reports a different entity tag for different bytes", async () => {
        const { storage, space } = context();
        const mine = await storage.stat(space, KEY);
        await storage.put(space, "ab/other.bin", Buffer.from("a different body"));
        const theirs = await storage.stat(space, "ab/other.bin");
        expect(theirs?.etag).not.toBe(mine?.etag);
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

    describe("putConditional", () => {
      it("creates a key that is absent, and refuses one that is not", async () => {
        const { storage, space } = context();
        const key = `cas/${name}-create.json`;

        const created = await storage.putConditional(space, key, Buffer.from("first"), {
          ifNoneMatch: true,
        });
        expect(created.ok).toBe(true);

        const again = await storage.putConditional(space, key, Buffer.from("second"), {
          ifNoneMatch: true,
        });
        expect(again.ok).toBe(false);
        expect(await storage.read(space, key)).toEqual(Buffer.from("first"));
      });

      it("applies a write naming the current tag, and reports the new one", async () => {
        const { storage, space } = context();
        const key = `cas/${name}-match.json`;
        await storage.put(space, key, Buffer.from("one"));

        const before = await storage.stat(space, key);
        const written = await storage.putConditional(space, key, Buffer.from("two"), {
          ifMatch: before?.etag as string,
        });

        expect(written).toEqual({ ok: true, etag: expect.any(String) });
        expect(await storage.read(space, key)).toEqual(Buffer.from("two"));
        // The tag has to move, or the next writer would be allowed to act on
        // what it read before this write happened.
        expect(written.ok && written.etag).not.toBe(before?.etag);
        expect((await storage.stat(space, key))?.etag).toBe(written.ok && written.etag);
      });

      it("refuses a write naming a tag that has moved on", async () => {
        const { storage, space } = context();
        const key = `cas/${name}-stale.json`;
        await storage.put(space, key, Buffer.from("one"));
        const stale = (await storage.stat(space, key))?.etag as string;

        await storage.putConditional(space, key, Buffer.from("two"), { ifMatch: stale });
        const late = await storage.putConditional(space, key, Buffer.from("three"), {
          ifMatch: stale,
        });

        expect(late.ok).toBe(false);
        expect(await storage.read(space, key)).toEqual(Buffer.from("two"));
      });

      it("refuses a write against a key that is not there", async () => {
        const { storage, space } = context();
        const absent = await storage.putConditional(
          space,
          `cas/${name}-absent.json`,
          Buffer.from("x"),
          { ifMatch: '"9c-1a-2b"' },
        );
        expect(absent.ok).toBe(false);
      });

      it("lets exactly one of several racing writers through", async () => {
        // The property the whole primitive exists for: concurrent writers that
        // all read the same state must not silently resolve last-writer-wins.
        const { storage, space } = context();
        const key = `cas/${name}-race.json`;
        await storage.put(space, key, Buffer.from("start"));
        const shared = (await storage.stat(space, key))?.etag as string;

        const results = await Promise.all(
          [0, 1, 2, 3, 4].map((n) =>
            storage.putConditional(space, key, Buffer.from(`writer-${n}`), {
              ifMatch: shared,
            }),
          ),
        );

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        const winner = results.findIndex((result) => result.ok);
        expect(await storage.read(space, key)).toEqual(Buffer.from(`writer-${winner}`));
      });
    });

    describe("list", () => {
      it("reports the content-addressable keys of that space alone", async () => {
        const { storage, space } = context();
        const { files } = await storage.list(space);
        const entry = files.find((file) => file.key === KEY);
        expect(entry?.size).toBe(BODY.byteLength);
        expect(files.some((file) => file.key === NEIGHBOUR_KEY)).toBe(false);
      });

      it("lists an explicit prefix, including keys outside the uploads layout", async () => {
        const { storage, space } = context();
        await storage.put(space, "zz/nested/deep.bin", Buffer.from("deep"));
        const { files } = await storage.list(space, { prefix: "zz/" });
        expect(files.map((file) => file.key)).toContain("zz/nested/deep.bin");
      });

      it("keeps a prefixed listing out of the default one", async () => {
        // `zz/nested/deep.bin` is two levels down, so it is not the uploads
        // layout — a default listing must not pick it up.
        const { storage, space } = context();
        const { files } = await storage.list(space);
        expect(files.some((file) => file.key === "zz/nested/deep.bin")).toBe(false);
      });

      it("pages through every key without repeating one", async () => {
        const { storage, space } = context();
        const prefix = "pg/";
        for (let i = 0; i < 5; i++) {
          await storage.put(space, `${prefix}file-${i}.bin`, Buffer.from(String(i)));
        }

        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await storage.list(space, { prefix, cursor, limit: 2 });
          seen.push(...page.files.map((file) => file.key));
          cursor = page.cursor;
          pages++;
          expect(pages).toBeLessThan(20);
        } while (cursor);

        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.sort()).toEqual([
          "pg/file-0.bin",
          "pg/file-1.bin",
          "pg/file-2.bin",
          "pg/file-3.bin",
          "pg/file-4.bin",
        ]);
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
