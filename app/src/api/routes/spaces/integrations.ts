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

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const existing = await listOAuthIntegrationsForUser(store, user.id);
    const definitions = await listOAuthProviderDefinitions(spaceId);

    const connections = definitions.map((definition) =>
      buildIntegrationView(
        definition,
        existing.find((item) => item.provider === definition.integration.id) ?? null,
      ),
    );

    return jsonResponse({ connections });
  }, "Failed to list integrations");
