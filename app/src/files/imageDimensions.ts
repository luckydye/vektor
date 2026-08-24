/**
 * Header parsing only. Deliberately free of storage and database imports: the
 * upload path calls this with bytes it already holds, and everything that later
 * wants a stored file's dimensions reads them off the `file` row instead
 * (`#db/space/files.ts`) rather than fetching the file again.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Extensions {@link readImageDimensions} can actually read. A backfill uses this
 * to skip fetching bytes it would only fail to parse — SVG in particular is an
 * image with no pixel header, so it is deliberately absent.
 */
export const DIMENSION_READABLE_EXTENSIONS = new Set([
  "png",
  "gif",
  "jpg",
  "jpeg",
  "webp",
]);

/**
 * Read pixel dimensions from an image's header bytes. Null for unknown formats.
 * Not the native addon: its `metadata()` fully decodes, and the addon's `.node`
 * require breaks in Astro's separate SSR bundle.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  // PNG: dimensions are the first two fields in the IHDR chunk.
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: logical screen width and height.
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG: scan markers until a start-of-frame segment provides dimensions.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + segmentLength + 2 > buffer.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength + 2;
    }
  }

  // WebP: a RIFF container whose first chunk encodes dimensions differently per
  // variant — lossy (VP8 ), lossless (VP8L), or extended (VP8X).
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = buffer.toString("ascii", 12, 16);

    // Lossy: 3-byte frame tag, a 0x9d012a start code, then 14-bit dimensions.
    if (chunk === "VP8 " && buffer.readUIntBE(23, 3) === 0x9d012a) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }

    // Lossless: 0x2f signature, then two 14-bit minus-one fields.
    if (chunk === "VP8L" && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }

    // Extended: 24-bit, minus-one canvas dimensions.
    if (chunk === "VP8X") {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
  }

  return null;
}
