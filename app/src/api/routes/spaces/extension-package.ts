import { verifyFeatureAccess } from "#acl/guards.ts";
import { Feature } from "#acl/permissions.ts";
import {
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getExtensionPackage } from "#db/space/extensions.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId/package
 * Download the raw extension ZIP. Useful for debugging broken packages.
 * Owners only (same restriction as delete).
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");

    await verifyFeatureAccess(spaceId, Feature.MANAGE_EXTENSIONS, user.id);

    const pkg = await getExtensionPackage(spaceId, extensionId);
    if (!pkg) {
      return notFoundResponse("Extension");
    }

    return new Response(pkg as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${extensionId}.zip"`,
      },
    });
  }, "Failed to download extension package");
