import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifyExtensionAccess,
  verifySpaceOwnership,
  withApiErrorHandling,
} from "#db/api.ts";
import { deleteExtension, getExtension, setExtensionEnabled } from "#db/extensions.ts";
import { getSpace } from "#db/spaces.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId
 * Get a single extension's metadata.
 * Jobs may read any extension metadata in the same space; user sessions still require extension access.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "editor");

    if (auth.type === "user") {
      await verifyExtensionAccess(spaceId, extensionId, auth.user.id);
    }

    const ext = await getExtension(spaceId, extensionId, { includeDisabled: true });
    if (!ext) {
      return notFoundResponse("Extension");
    }

    return jsonResponse({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      enabled: ext.enabled,
      source: ext.source,
      sourceRef: ext.sourceRef,
      sourcePublisher: ext.sourcePublisher,
      entries: ext.manifest.entries,
      routes: ext.manifest.routes,
      jobs: ext.manifest.jobs,
      createdAt: ext.createdAt.toISOString(),
      updatedAt: ext.updatedAt.toISOString(),
      createdBy: ext.createdBy,
    });
  }, "Failed to get extension");

/**
 * PATCH /api/v1/spaces/:spaceId/extensions/:extensionId
 * Update extension settings (owners only)
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");

    await verifySpaceOwnership(spaceId, user.id, getSpace);

    const body = await parseJsonBody<{ enabled?: unknown }>(context.req.raw);
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }

    const ext = await setExtensionEnabled(spaceId, extensionId, body.enabled);
    if (!ext) {
      return notFoundResponse("Extension");
    }

    return jsonResponse({
      id: ext.id,
      name: ext.manifest.name,
      version: ext.manifest.version,
      description: ext.manifest.description,
      enabled: ext.enabled,
      source: ext.source,
      sourceRef: ext.sourceRef,
      sourcePublisher: ext.sourcePublisher,
      entries: ext.manifest.entries,
      routes: ext.manifest.routes,
      jobs: ext.manifest.jobs,
      createdAt: ext.createdAt.toISOString(),
      updatedAt: ext.updatedAt.toISOString(),
      createdBy: ext.createdBy,
    });
  }, "Failed to update extension");

/**
 * DELETE /api/v1/spaces/:spaceId/extensions/:extensionId
 * Delete an extension (owners only)
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");

    // Only owners can delete extensions
    await verifySpaceOwnership(spaceId, user.id, getSpace);

    const deleted = await deleteExtension(spaceId, extensionId);
    if (!deleted) {
      return notFoundResponse("Extension");
    }

    return successResponse();
  }, "Failed to delete extension");
