import { jsonResponse, requireUser, withApiErrorHandling } from "#api/http.ts";
import { registryErrorResponse } from "#api/routes/marketplace/errors.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  absolutizeListing,
  fetchRegistryIndex,
  registryBaseUrl,
} from "#extensions/registry.ts";

/**
 * GET /api/v1/marketplace/extensions
 * The extension store catalogue.
 *
 * The server fetches it rather than the browser: the registry is
 * operator-configured (it may be an internal mirror the browser cannot reach),
 * the response is cached once for the whole instance, and a store that is
 * switched off simply has no catalogue here. Being signed in is enough — this
 * is public information, and installing is gated separately.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    requireUser(context);

    if (!registryBaseUrl()) {
      return jsonResponse({ enabled: false, registry: null, extensions: [] });
    }

    try {
      const index = await fetchRegistryIndex();
      return jsonResponse({
        enabled: true,
        registry: registryBaseUrl(),
        generatedAt: index.generatedAt,
        extensions: index.extensions.map(absolutizeListing),
      });
    } catch (error) {
      return registryErrorResponse(error);
    }
  }, "Failed to load the extension store");
