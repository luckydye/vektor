import type { APIRoute } from "astro";
import {
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifyExtensionAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  getStorageValue,
  setStorageValue,
  deleteStorageValue,
} from "#db/extensionStorage.ts";

/**
 * GET /api/v1/spaces/:spaceId/extensions/:extensionId/storage/:key
 * Get a single storage value
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");
    const key = requireParam(context.params, "key");

    await verifyExtensionAccess(spaceId, extensionId, user.id);

    const value = await getStorageValue(spaceId, extensionId, key);
    if (value === null) {
      return notFoundResponse("Storage key");
    }

    return jsonResponse({ key, value });
  }, "Failed to get storage value");

/**
 * PUT /api/v1/spaces/:spaceId/extensions/:extensionId/storage/:key
 * Set a storage value
 */
export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");
    const key = requireParam(context.params, "key");

    await verifyExtensionAccess(spaceId, extensionId, user.id);

    const body = await parseJsonBody(context.request);
    const value = body.value;

    if (typeof value !== "string") {
      return jsonResponse({ error: "Value must be a string" }, 400);
    }

    const entry = await setStorageValue(spaceId, extensionId, key, value);

    return jsonResponse({
      key: entry.key,
      value: entry.value,
      updatedAt: entry.updatedAt.toISOString(),
    });
  }, "Failed to set storage value");

/**
 * DELETE /api/v1/spaces/:spaceId/extensions/:extensionId/storage/:key
 * Delete a storage value
 */
export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const extensionId = requireParam(context.params, "extensionId");
    const key = requireParam(context.params, "key");

    await verifyExtensionAccess(spaceId, extensionId, user.id);

    const deleted = await deleteStorageValue(spaceId, extensionId, key);
    if (!deleted) {
      return notFoundResponse("Storage key");
    }

    return successResponse();
  }, "Failed to delete storage value");
