import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

// Use the WebAssembly build of sharp — no native libvips dependency, so the
// compiled binary is fully self-contained.
let _sharp: typeof import("sharp").default | null | undefined;
async function getSharp() {
  if (_sharp === undefined) {
    try {
      // @vite-ignore: no "." export; bun resolves this at compile time.
      const mod = await import(/* @vite-ignore */ "@img/sharp-wasm32/sharp.node");
      // CJS .node addons may nest the callable under .default.default
      const fn = mod.default?.default ?? mod.default ?? mod;
      _sharp = typeof fn === "function" ? fn : null;
    } catch (e) {
      console.warn(
        "[transforms] sharp-wasm32 unavailable — image transforms disabled",
        e,
      );
      _sharp = null;
    }
  }
  return _sharp;
}

import { contentDisposition, SERVED_FILE_CSP } from "#utils/servedFiles.ts";
import type { FileStorageAdapter } from "./storage.ts";
import { getTransformCacheRoot, isWithinTransformCache } from "./uploads.ts";

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

const OUTPUT_MIME: Record<string, string> = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

// Extensions eligible for transformation
export const TRANSFORMABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const UPLOAD_PATH_PREFIX = "/api/v1/spaces/";

/**
 * Append transform query params to an internal upload URL.
 * Returns the URL unchanged if it is external, an SVG, or already has a query
 * string (to avoid double-processing).
 */
export function withTransformParams(
  url: string,
  params: { w?: number; format?: "webp" | "jpeg" | "png"; q?: number },
): string {
  if (!url.startsWith(UPLOAD_PATH_PREFIX)) return url;

  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (!TRANSFORMABLE_EXTENSIONS.has(ext)) return url;

  const search = new URLSearchParams();
  if (params.w) search.set("w", String(params.w));
  if (params.format) search.set("format", params.format);
  if (params.q) search.set("q", String(params.q));

  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

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
  const qRaw = searchParams.get("q");

  const w = wRaw ? Math.max(0, Math.floor(Number(wRaw))) : 0;
  const h = hRaw ? Math.max(0, Math.floor(Number(hRaw))) : 0;
  const format =
    formatRaw && OUTPUT_FORMATS.has(formatRaw)
      ? (formatRaw as TransformParams["format"])
      : null;
  const quality = qRaw ? Math.min(100, Math.max(1, Math.floor(Number(qRaw)))) : 80;

  // Only proceed if at least one meaningful param was provided
  if (!w && !h && !format && !qRaw) return null;
  // Ignore NaN inputs
  if ((wRaw && Number.isNaN(Number(wRaw))) || (hRaw && Number.isNaN(Number(hRaw))))
    return null;

  return { w, h, format, quality };
}

// ---------------------------------------------------------------------------
// Cache path
// ---------------------------------------------------------------------------

/**
 * Deterministic local cache path for a transformed variant.
 * Example: data/transforms/space1/ab/abc123.jpg_800x0_webp_q80.webp
 */
export function transformCachePath(
  spaceId: string,
  originalPath: string, // e.g. "ab/abc123.jpg"
  params: TransformParams,
): string {
  const outputExt =
    params.format === "jpeg"
      ? "jpg"
      : params.format
        ? params.format
        : originalPath.split(".").pop()!.toLowerCase();

  const suffix = `_${params.w}x${params.h}_${params.format ?? "orig"}_q${params.quality}.${outputExt}`;
  const cacheFilename = originalPath + suffix;
  return `${getTransformCacheRoot(spaceId)}/${cacheFilename}`;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Apply a transform to an image buffer using sharp.
 * Images are never enlarged (withoutEnlargement).
 */
export async function applyTransform(
  input: Buffer,
  params: TransformParams,
): Promise<Buffer> {
  const sharpFn = await getSharp();
  if (!sharpFn) return input; // sharp unavailable — pass through unchanged

  let pipeline = sharpFn(input);

  if (params.w || params.h) {
    pipeline = pipeline.resize({
      width: params.w || undefined,
      height: params.h || undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  if (params.format === "webp") {
    pipeline = pipeline.webp({ quality: params.quality });
  } else if (params.format === "jpeg") {
    pipeline = pipeline.jpeg({ quality: params.quality });
  } else if (params.format === "png") {
    pipeline = pipeline.png({ quality: params.quality });
  }
  // null format: sharp preserves the input format

  return pipeline.toBuffer();
}

// ---------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------

/**
 * Full transform-and-cache flow:
 *  1. Check local disk cache — stream if hit.
 *  2. On miss: read original via storage adapter (works for both local and
 *     object storage), apply transform, write to local cache, stream result.
 *
 * The transform cache is always local filesystem regardless of storage backend.
 */
export async function serveTransformed(
  spaceId: string,
  originalPath: string,
  params: TransformParams,
  storage: FileStorageAdapter,
): Promise<Response> {
  const cachePath = transformCachePath(spaceId, originalPath, params);

  // Security: ensure the resolved cache path stays inside the transform root
  if (!isWithinTransformCache(spaceId, cachePath)) {
    return new Response("Invalid path", { status: 400 });
  }

  const outputExt = cachePath.split(".").pop()!;
  const mimeType = OUTPUT_MIME[outputExt] ?? "image/jpeg";

  const responseHeaders = (contentLength: number): Record<string, string> => ({
    "Content-Type": mimeType,
    "Content-Length": String(contentLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": contentDisposition(outputExt),
    "Content-Security-Policy": SERVED_FILE_CSP,
    "X-Content-Type-Options": "nosniff",
  });

  // Cache hit — stream directly
  try {
    const cachedStat = await stat(cachePath);
    if (cachedStat.isFile()) {
      const stream = Readable.toWeb(createReadStream(cachePath)) as ReadableStream;
      return new Response(stream, {
        status: 200,
        headers: responseHeaders(cachedStat.size),
      });
    }
  } catch {
    // ENOENT — fall through to transform
  }

  // Cache miss — read original, transform, write cache
  const original = await storage.read(spaceId, originalPath);
  if (!original) {
    return new Response("File not found", { status: 404 });
  }

  const buffer = await applyTransform(original, params);

  // Write cache file (best-effort — don't fail the request if the write fails)
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, buffer);
  } catch (err) {
    console.error("Failed to write transform cache", { cachePath, err });
  }

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: responseHeaders(buffer.byteLength),
  });
}
