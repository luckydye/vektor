import type { APIRoute } from "astro";
import {
  notFoundResponse,
  requireParam,
  requireUser,
  verifyExtensionAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  extractFile,
  getExtensionPackage,
} from "#db/extensions.ts";

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
};

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId/assets/*
 * Serve assets from extension zip package.
 *
 * Assets are extracted on-demand from the stored zip.
 * Access is granted if user is an editor on the space OR has explicit ACL entry for the extension.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");
    const assetPath = context.params.path;

    if (!assetPath) {
      return notFoundResponse("Asset path");
    }

    // Check ACL-based access to extension
    await verifyExtensionAccess(spaceId, extensionId, user.id);

    const packageBuffer = await getExtensionPackage(spaceId, extensionId);
    if (!packageBuffer) {
      return notFoundResponse("Extension");
    }

    let fileData: Buffer | null = null;
    try {
      fileData = extractFile(packageBuffer, assetPath);
    } catch (err) {
      console.warn(
        `Failed to extract extension asset '${assetPath}' for '${extensionId}':`,
        err,
      );
      return notFoundResponse("Asset");
    }
    if (!fileData) {
      return notFoundResponse("Asset");
    }

    const mimeType = getMimeType(assetPath);

    return new Response(fileData, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  }, "Failed to serve asset");
