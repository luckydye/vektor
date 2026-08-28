/**
 * Tests for image header parsing and upload URL → storage key resolution.
 *
 * The parser is cross-checked against the native addon's `metadata()`, which
 * fully decodes the image: the two must agree on every format the app serves.
 *
 * Run with:
 *   bunx --bun vitest run test/image-dimensions.spec.ts
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  getUploadImageAspectRatio,
  getUploadImageDimensions,
  readImageDimensions,
} from "#files/imageDimensions.ts";
import { getNativeImage } from "#files/native.ts";
import {
  type FileStorageAdapter,
  getFileStorage,
  setFileStorage,
} from "#files/storage.ts";
import { uploadKeyFromUrl } from "#files/uploads.ts";

const native = await getNativeImage();
if (!native) {
  throw new Error(
    "native image addon unavailable — run: cd native/image && bun run build",
  );
}

// ---------------------------------------------------------------------------
// readImageDimensions — cross-checked against a full native decode
// ---------------------------------------------------------------------------

describe("readImageDimensions", () => {
  for (const format of ["png", "jpeg", "webp", "gif"]) {
    it(`matches the native decode for ${format}`, () => {
      // Non-square on purpose: a transposed read still passes on a square image.
      const buf = Buffer.from(native.encodeSolid(100, 200, 200, 50, 50, format, 80));
      const expected = native.metadata(buf);
      expect(readImageDimensions(buf)).toEqual({
        width: expected.width,
        height: expected.height,
      });
    });
  }

  // encodeSolid only emits lossy VP8, so the other two RIFF variants are
  // asserted against hand-built headers.
  it("reads lossless WebP (VP8L) dimensions", () => {
    const buf = Buffer.alloc(30);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    buf.write("VP8L", 12, "ascii");
    buf[20] = 0x2f;
    buf.writeUInt32LE((99 & 0x3fff) | ((199 & 0x3fff) << 14), 21);
    expect(readImageDimensions(buf)).toEqual({ width: 100, height: 200 });
  });

  it("reads extended WebP (VP8X) canvas dimensions", () => {
    const buf = Buffer.alloc(30);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    buf.write("VP8X", 12, "ascii");
    buf.writeUIntLE(99, 24, 3);
    buf.writeUIntLE(199, 27, 3);
    expect(readImageDimensions(buf)).toEqual({ width: 100, height: 200 });
  });

  it("returns null for unrecognised and truncated buffers", () => {
    expect(readImageDimensions(Buffer.from("not an image at all, really"))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull();

    const png = Buffer.from(native.encodeSolid(10, 10, 0, 0, 0, "png", 80));
    expect(readImageDimensions(png.subarray(0, 12))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// uploadKeyFromUrl
// ---------------------------------------------------------------------------

describe("uploadKeyFromUrl", () => {
  it("extracts the key from a relative upload URL", () => {
    expect(uploadKeyFromUrl("space_1", "/api/v1/spaces/space_1/uploads/ab/abc.png")).toBe(
      "ab/abc.png",
    );
  });

  it("extracts the key from an absolute upload URL with a query string", () => {
    expect(
      uploadKeyFromUrl(
        "space_1",
        "https://vektor.example/api/v1/spaces/space_1/uploads/ab/abc.png?w=640",
      ),
    ).toBe("ab/abc.png");
  });

  it("rejects another space's uploads", () => {
    expect(
      uploadKeyFromUrl("space_1", "/api/v1/spaces/space_2/uploads/ab/abc.png"),
    ).toBeNull();
  });

  it("rejects external URLs and non-upload paths", () => {
    expect(uploadKeyFromUrl("space_1", "https://example.com/photo.jpg")).toBeNull();
    expect(uploadKeyFromUrl("space_1", "/api/v1/spaces/space_1/documents/d1")).toBeNull();
  });

  it("rejects traversal, including percent-encoded", () => {
    expect(
      uploadKeyFromUrl("space_1", "/api/v1/spaces/space_1/uploads/../../secret.png"),
    ).toBeNull();
    expect(
      uploadKeyFromUrl("space_1", "/api/v1/spaces/space_1/uploads/%2e%2e%2fsecret.png"),
    ).toBeNull();
  });

  it("rejects an empty key and missing input", () => {
    expect(uploadKeyFromUrl("space_1", "/api/v1/spaces/space_1/uploads/")).toBeNull();
    expect(uploadKeyFromUrl("space_1", undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUploadImageDimensions / getUploadImageAspectRatio
// ---------------------------------------------------------------------------

describe("upload image dimensions", () => {
  const originalStorage = getFileStorage();
  const png = Buffer.from(native.encodeSolid(300, 100, 10, 20, 30, "png", 80));
  const files = new Map<string, Buffer>([
    ["ab/wide.png", png],
    ["ab/notimage.pdf", Buffer.from("%PDF-1.4 not really")],
  ]);
  let reads = 0;

  const stub: FileStorageAdapter = {
    async put() {
      throw new Error("unused");
    },
    async putHashed() {
      throw new Error("unused");
    },
    async read(_spaceId, key) {
      reads++;
      return files.get(key) ?? null;
    },
    async delete() {},
    async list() {
      return [];
    },
    url: (spaceId, key) => `/api/v1/spaces/${spaceId}/uploads/${key}`,
  };
  setFileStorage(stub);

  afterAll(() => {
    setFileStorage(originalStorage);
  });

  const url = (key: string) => `/api/v1/spaces/space_1/uploads/${key}`;

  it("reads dimensions and the derived aspect ratio", async () => {
    expect(await getUploadImageDimensions("space_1", url("ab/wide.png"))).toEqual({
      width: 300,
      height: 100,
    });
    expect(await getUploadImageAspectRatio("space_1", url("ab/wide.png"))).toBe(3);
  });

  it("takes the first entry of a multi-valued property", async () => {
    expect(
      await getUploadImageAspectRatio("space_1", [
        url("ab/wide.png"),
        url("ab/other.png"),
      ]),
    ).toBe(3);
  });

  it("caches per key, including misses", async () => {
    const before = reads;
    await getUploadImageDimensions("space_1", url("ab/wide.png"));
    await getUploadImageDimensions("space_1", url("ab/missing.png"));
    await getUploadImageDimensions("space_1", url("ab/missing.png"));
    // Only the first miss reaches storage; the hit was cached above.
    expect(reads).toBe(before + 1);
  });

  it("returns null for external URLs without touching storage", async () => {
    const before = reads;
    expect(
      await getUploadImageAspectRatio("space_1", "https://example.com/photo.jpg"),
    ).toBeNull();
    expect(await getUploadImageAspectRatio("space_1", undefined)).toBeNull();
    expect(reads).toBe(before);
  });

  it("returns null for a stored file that is not a known image format", async () => {
    expect(await getUploadImageAspectRatio("space_1", url("ab/notimage.pdf"))).toBeNull();
  });
});
