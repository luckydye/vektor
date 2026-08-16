import {
  authenticateJobTokenOrSpaceRole,
  verifyAccess,
  verifyFeatureAccess,
} from "#acl/guards.ts";
import { Feature, Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  deleteExtension,
  getExtension,
  setExtensionEnabled,
} from "#db/space/extensions.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId
 * Get a single extension's metadata.
 * Jobs may read any extension metadata in the same space; user sessions still require extension access.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const extensionId = requireParam(context.var.params, "extensionId");
    const auth = await authenticateJobTokenOrSpaceRole(
      context,
      spaceId,
      Permission.EDITOR,
    );

    if (auth.type === "user") {
      await verifyAccess(
        spaceId,
        { type: ResourceType.EXTENSION, id: extensionId },
        auth.user.id,
        Permission.VIEWER,
      );
    }

    const store = await openSpaceStore(spaceId);
    const ext = await getExtension(store, extensionId, { includeDisabled: true });
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

    await verifyFeatureAccess(spaceId, Feature.MANAGE_EXTENSIONS, user.id);

    const body = await parseJsonBody<{ enabled?: unknown }>(context.req.raw);
    if (typeof body.enabled !== "boolean") {
      return jsonResponse({ error: "enabled must be a boolean" }, 400);
    }

    const store = await openSpaceStore(spaceId);
    const ext = await setExtensionEnabled(store, extensionId, body.enabled);
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

    // Deleting an extension requires the space-wide manage_extensions capability
    await verifyFeatureAccess(spaceId, Feature.MANAGE_EXTENSIONS, user.id);

    const store = await openSpaceStore(spaceId);
    const deleted = await deleteExtension(store, extensionId);
    if (!deleted) {
      return notFoundResponse("Extension");
    }

    return successResponse();
  }, "Failed to delete extension");
