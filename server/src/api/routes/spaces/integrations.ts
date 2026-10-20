import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  jsonResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";

import {
  buildIntegrationView,
  listOAuthProviderDefinitions,
} from "#integrations/oauthProviders.ts";
import type { Platform } from "#platform/platform.ts";

/**
 * List the integrations configured for a space
 *
 * @tag Integrations
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      context.var.platform,
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(context.var.platform, spaceId);
    const existing = await listOAuthIntegrationsForUser(store, user.id);
    const definitions = await listOAuthProviderDefinitions(context.var.platform, spaceId);

    const connections = definitions.map((definition) =>
      buildIntegrationView(
        definition,
        existing.find((item) => item.provider === definition.integration.id) ?? null,
      ),
    );

    return jsonResponse({ connections });
  }, "Failed to list integrations");
