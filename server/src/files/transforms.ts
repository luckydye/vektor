import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { servedFileSecurityHeaders } from "#utils/csp.ts";
import { type BlobStore, containedKey } from "./storage.ts";

export { withTransformParams } from "./transformUrl.ts";

import { TRANSFORMABLE_EXTENSIONS } from "./transformUrl.ts";

export { TRANSFORMABLE_EXTENSIONS };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformParams {
  w: number; // 0 = unset
  h: number; // 0 = unset
  format: "webp" | "jpeg" | "png" | null; // null = keep original format
  quality: number; // 1–100
}

const OUTPUT_FORMATS = new Set(["webp", "jpeg", "png"]);

// Allowed discrete widths/heights for image transforms.
// Snapping to these presets bounds the transform cache to a finite number of
// variants per image — preventing CPU and disk exhaustion via crafted params.
const ALLOWED_DIMENSIONS = [160, 320, 640, 960, 1280, 1920];
const FIXED_QUALITY = 80;

/** Ceiling on the original served in place of a transform that could not run. */
const MAX_UNTRANSFORMED_FALLBACK = 2 * 1024 * 1024;

function snapToPreset(value: number, presets: number[]): number {
  if (value <= 0) return 0;
  return presets.reduce((best, preset) =>
    Math.abs(preset - value) < Math.abs(best - value) ? preset : best,
  );
}

const OUTPUT_MIME: Record<string, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

// ---------------------------------------------------------------------------
// Param parsing
// ---------------------------------------------------------------------------

/**
 * Parse transform query params from a request URL.
 * Returns null if the file extension is not transformable or no recognised
 * params are present — callers should fall through to the default serve path.
 */
export function parseTransformParams(
  searchParams: URLSearchParams,
  ext: string,
): TransformParams | null {
  if (!TRANSFORMABLE_EXTENSIONS.has(ext.toLowerCase())) return null;

  const wRaw = searchParams.get("w");
  const hRaw = searchParams.get("h");
  const formatRaw = searchParams.get("format");

  const w = wRaw
    ? snapToPreset(Math.max(0, Math.floor(Number(wRaw))), ALLOWED_DIMENSIONS)
    : 0;
  const h = hRaw
    ? snapToPreset(Math.max(0, Math.floor(Number(hRaw))), ALLOWED_DIMENSIONS)
    : 0;
  const format =
    formatRaw && OUTPUT_FORMATS.has(formatRaw)
      ? (formatRaw as TransformParams["format"])
      : null;
  const quality = FIXED_QUALITY;

  // Only proceed if at least one meaningful param was provided
  if (!w && !h && !format) return null;
  // Ignore NaN inputs
  if ((wRaw && Number.isNaN(Number(wRaw))) || (hRaw && Number.isNaN(Number(hRaw))))
    return null;

  return { w, h, format, quality };
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Deterministic key of a transformed variant in the space's transform cache.
 * Example: ab/abc123.jpg_800x0_webp_q80.webp
 */
export function transformCacheKey(
  originalPath: string, // e.g. "ab/abc123.jpg"
  params: TransformParams,
): string {
  const outputExt =
    params.format === "jpeg"
      ? "jpg"
      : params.format
        ? params.format
        : originalPath.split(".").pop()?.toLowerCase();

  const suffix = `_${params.w}x${params.h}_${params.format ?? "orig"}_q${params.quality}.${outputExt}`;
  return originalPath + suffix;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Apply a transform to an image buffer using the platform's image transformer.
 * Images are never enlarged (fit-inside, no upscale).
 *
 * Returns null when the transform could not be applied (transformer unavailable
 * or decode/encode failure). Callers must NOT cache a null result — serving the
 * unchanged original is a graceful fallback, but persisting it would poison the
 * cache for the (correct) params key.
 */
export async function applyTransform(
  platform: Platform,
  input: Buffer,
  params: TransformParams,
): Promise<Buffer | null> {
  try {
    return await platform.imageTransformer.transform(input, {
      w: params.w,
      h: params.h,
      // null format preserves the input format; the transformer expects "".
      format: params.format ?? "",
      quality: params.quality,
    });
  } catch (e) {
    appLogger.error("[transforms] native transform failed — serving original", {
      error: e,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

/**
 * Full transform-and-cache flow:
 *  1. Check the platform's transform cache — serve if hit.
 *  2. On miss: read original via storage adapter (works for both local and
 *     object storage), apply transform, write to the cache, stream result.
 */
export async function serveTransformed(
  platform: Platform,
  spaceId: string,
  originalPath: string,
  params: TransformParams,
  storage: BlobStore,
): Promise<Response> {
  const cache = platform.transformCache;
  const cacheKey = transformCacheKey(originalPath, params);

  // Security: ensure the cache key stays inside the space's cache
  if (containedKey(spaceId, cacheKey) === null) {
    return new Response("Invalid path", { status: 400 });
  }

  const outputExt = cacheKey.split(".").pop()!;
  const mimeType = OUTPUT_MIME[outputExt] ?? "image/jpeg";

  const responseHeaders = (contentLength: number): Record<string, string> => ({
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Cache-Control": "private, max-age=3600",
    ...servedFileSecurityHeaders(outputExt),
  });

  // Cache hit — one read, since variants are snapped to small presets
  const cached = await cache.read(spaceId, cacheKey);
  if (cached) {
    return new Response(new Uint8Array(cached), {
      status: 200,
      headers: responseHeaders(cached.byteLength),
    });
  }

  // Cache miss — read original, transform, write cache
  const original = await storage.read(spaceId, originalPath);
  if (!original) {
    return new Response("File not found", { status: 404 });
  }

  const buffer = await applyTransform(platform, original, params);

  // Transform unavailable/failed: serve the original bytes with their own
  // content type and DO NOT cache — caching here would poison the params key
  // with untransformed bytes that get served forever once the addon recovers.
  if (!buffer) {
    const origExt = originalPath.split(".").pop()?.toLowerCase() ?? "";

    // Past a point the fallback is worse than no image: a caller asking for a
    // 320px thumbnail must never be handed hundreds of megabytes, which is what
    // an image too large for the decoder's memory limit would send.
    if (original.byteLength > MAX_UNTRANSFORMED_FALLBACK) {
      appLogger.warn("[transforms] transform failed and the original is too large", {
        originalPath,
        bytes: original.byteLength,
      });
      return new Response("Image could not be transformed", { status: 502 });
    }

    return new Response(new Uint8Array(original), {
      status: 200,
      headers: {
        "Content-Type": OUTPUT_MIME[origExt] ?? "application/octet-stream",
        "Content-Length": String(original.byteLength),
        // Deliberately not "immutable": this is a degraded fallback that
        // should be re-fetched (and transformed) once the addon is available.
        "Cache-Control": "private, no-store",
        ...servedFileSecurityHeaders(origExt),
      },
    });
  }

  // Write cache entry (best-effort — don't fail the request if the write fails)
  try {
    await cache.put(spaceId, cacheKey, buffer, mimeType);
  } catch (err) {
    appLogger.error("Failed to write transform cache", { spaceId, cacheKey, error: err });
  }

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: responseHeaders(buffer.byteLength),
  });
}
