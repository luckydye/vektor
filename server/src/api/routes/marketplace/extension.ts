import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import { registryErrorResponse } from "#api/routes/marketplace/errors.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { absolutizeListing, fetchRegistryExtension } from "#extensions/registry.ts";

/**
 * Read one store listing
 *
 * GET /api/v1/marketplace/extensions/:extensionId
 * One store listing in full: README, screenshots, and every published version.
 *
 * @tag Marketplace
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    requireUser(context);
    const extensionId = requireParam(context.var.params, "extensionId");

    try {
      return jsonResponse(absolutizeListing(await fetchRegistryExtension(extensionId)));
    } catch (error) {
      return registryErrorResponse(error);
    }
  }, "Failed to load the extension listing");
