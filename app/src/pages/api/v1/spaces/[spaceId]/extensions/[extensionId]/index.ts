import type { APIRoute } from "astro";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  successResponse,
  verifyExtensionAccess,
  verifySpaceOwnership,
  withApiErrorHandling,
} from "#db/api.ts";
import { getSpace } from "#db/spaces.ts";
import { deleteExtension, getExtension } from "#db/extensions.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId
 * Get a single extension's metadata.
 * Jobs may read any extension metadata in the same space; user sessions still require extension access.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    if (auth.type === "user") {
      await verifyExtensionAccess(spaceId, extensionId, auth.user.id);
    }

    const ext = await getExtension(spaceId, extensionId);
    if (!ext) {
      return notFoundResponse("Extension");
    }

    return jsonResponse({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      entries: ext.manifest.entries,
      routes: ext.manifest.routes,
      jobs: ext.manifest.jobs,
      dataSources: ext.manifest.dataSources,
      createdAt: ext.createdAt.toISOString(),
      updatedAt: ext.updatedAt.toISOString(),
      createdBy: ext.createdBy,
    });
  }, "Failed to get extension");

/**
 * DELETE /api/v1/spaces/:spaceId/extensions/:extensionId
 * Delete an extension (owners only)
 */
export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");

    // Only owners can delete extensions
    await verifySpaceOwnership(spaceId, user.id, getSpace);

    const deleted = await deleteExtension(spaceId, extensionId);
    if (!deleted) {
      return notFoundResponse("Extension");
    }

    return successResponse();
  }, "Failed to delete extension");
