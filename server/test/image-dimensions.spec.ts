/**
 * Tests for image header parsing and upload URL → storage key resolution.
 *
 * Pixel dimensions themselves are stored on the `file` row at upload time; this
 * file covers the parser that produces them and the key resolution in front of
 * the lookup.
 *
 * The parser is cross-checked against the native addon's `metadata()`, which
 * fully decodes the image: the two must agree on every format the app serves.
 *
 * Run with:
 *   bunx --bun vitest run test/image-dimensions.spec.ts
 */

import { describe, expect, it } from "vitest";
import { getUploadImageAspectRatio, getUploadImageDimensions } from "#db/space/files.ts";
import { readImageDimensions } from "#files/imageDimensions.ts";
import { getNativeImage } from "#files/native.ts";
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
// getUploadImageDimensions — the paths that answer before opening a database
// ---------------------------------------------------------------------------

/**
 * Dimensions now come off the `file` row, written at upload, so the cases that
 * used to be about storage reads and a per-process cache are gone with it. What
 * is still worth pinning here is that a URL which names no upload is refused on
 * its shape, ahead of any space lookup — the rest needs a seeded space and is
 * exercised through the upload route.
 */
describe("upload image dimensions", () => {
  it("returns null for a URL that names no upload", async () => {
    expect(
      await getUploadImageAspectRatio("space_1", "https://example.com/photo.jpg"),
    ).toBeNull();
    expect(await getUploadImageAspectRatio("space_1", undefined)).toBeNull();
    expect(await getUploadImageDimensions("space_1", "/not/an/upload/url")).toBeNull();
  });
});
