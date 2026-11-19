import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { extractFile, getExtension, getExtensionPackage } from "#db/space/extensions.ts";
import {
  cacheExtensionArchive,
  getCachedExtensionArchive,
} from "#extensions/packageCache.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { EXTENSION_ASSET_CSP, EXTENSION_ASSET_CSP_SCRIPT } from "#utils/csp.ts";

const MIME_TYPES: Record<string, string> = {
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  css: "text/css",
  html: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
};

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Serve a file from the extension package
 *
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId/assets/*
 * Serve assets from extension zip package.
 * Assets are extracted on-demand from the stored zip.
 * Access is granted if user is an editor on the space OR has explicit ACL entry for the extension.
 *
 * @tag Extensions
 * @param path Path of the asset inside the extension package.
 * @media any
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");
    const assetPath = context.var.params.path;

    if (!assetPath) {
      return notFoundResponse("Asset path");
    }

    // Check ACL-based access to extension
    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.EXTENSION, id: extensionId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(context.var.platform, spaceId);
    // A disabled extension is not served: the client unloads it, and its files
    // should not stay fetchable.
    const extension = await getExtension(store, extensionId);
    if (!extension) {
      return notFoundResponse("Extension");
    }

    const archiveKey = `${spaceId}:${extensionId}:${extension.updatedAt.getTime()}`;
    let packageBuffer = getCachedExtensionArchive(archiveKey);
    if (!packageBuffer) {
      const stored = await getExtensionPackage(store, extensionId);
      if (!stored) {
        return notFoundResponse("Extension");
      }
      cacheExtensionArchive(archiveKey, stored);
      packageBuffer = stored;
    }

    let fileData: Buffer | null = null;
    try {
      fileData = extractFile(packageBuffer, assetPath);
    } catch (err) {
      appLogger.warn(
        `Failed to extract extension asset '${assetPath}' for '${extensionId}'`,
        { error: err },
      );
      return notFoundResponse("Asset");
    }
    if (!fileData) {
      return notFoundResponse("Asset");
    }

    const mimeType = getMimeType(assetPath);
    const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
    // JS/CSS are loaded via dynamic import() / <link>. Any CSP on the module
    // script response (sandbox or default-src) causes Chrome to hang the
    // import() promise indefinitely. Omit CSP entirely for these types.
    const isScript = ext === "js" || ext === "mjs" || ext === "css";
    const csp = isScript ? EXTENSION_ASSET_CSP_SCRIPT : EXTENSION_ASSET_CSP;
    // The manager appends `?v=<updatedAt>` to entry URLs, so a versioned asset
    // can be cached for as long as the version stays the same.
    const versioned = new URL(context.req.url).searchParams.has("v");

    const headers: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Length": String(fileData.length),
      "Cache-Control": versioned
        ? "private, max-age=31536000, immutable"
        : "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    };
    if (csp !== null) {
      headers["Content-Security-Policy"] = csp;
    }

    return new Response(fileData as unknown as BodyInit, { status: 200, headers });
  }, "Failed to serve asset");
