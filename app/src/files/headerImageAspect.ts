import { getFileStorage } from "./storage.ts";

const aspectRatioCache = new Map<string, number | null>();

// TODO: Replace this format-specific header parser with the native image
// metadata addon once Astro SSR and the document API share one server-side
// document enrichment path. Importing the addon from Astro's separate server
// bundle currently breaks its path inside the compiled executable.
function readImageDimensions(buffer: Buffer): { width: number; height: number } | null {
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

  // WebP: VP8X stores 24-bit, minus-one dimensions.
  if (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    buffer.toString("ascii", 12, 16) === "VP8X"
  ) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }

  return null;
}

function getUploadKey(
  spaceId: string,
  value: string | string[] | undefined,
): string | null {
  const url = Array.isArray(value) ? value[0] : value;
  if (!url) return null;

  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return null;
  }
  const prefix = `/api/v1/spaces/${encodeURIComponent(spaceId)}/uploads/`;
  if (!pathname.startsWith(prefix)) return null;

  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return key && !key.includes("..") ? key : null;
}

/**
 * Read a document header image's natural width/height ratio from storage.
 * Upload keys are content-addressed, so the result is safe to cache for the
 * lifetime of the server process. External image URLs are intentionally not
 * fetched.
 */
export async function getHeaderImageAspectRatio(
  spaceId: string,
  headerImage: string | string[] | undefined,
): Promise<number | null> {
  const key = getUploadKey(spaceId, headerImage);
  if (!key) return null;

  const cacheKey = `${spaceId}:${key}`;
  const cached = aspectRatioCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const buffer = await getFileStorage().read(spaceId, key);
  if (!buffer) {
    aspectRatioCache.set(cacheKey, null);
    return null;
  }

  const dimensions = readImageDimensions(buffer);
  const ratio =
    dimensions && dimensions.height > 0
      ? dimensions.width / dimensions.height
      : null;
  aspectRatioCache.set(cacheKey, ratio);
  return ratio;
}
