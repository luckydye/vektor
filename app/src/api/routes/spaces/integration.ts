import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  deleteOAuthIntegrationForUser,
  getOAuthIntegrationForUser,
} from "#db/space/oauthIntegrations.ts";

import {
  buildIntegrationView,
  getOAuthProviderDefinition,
} from "#integrations/oauthProviders.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const definition = await getOAuthProviderDefinition(spaceId, providerParam);
    if (!definition) {
      throw badRequestResponse("Unsupported integration provider");
    }

    const store = await openSpaceStore(spaceId);
    const connection = await getOAuthIntegrationForUser(store, user.id, providerParam);

    return jsonResponse({ connection: buildIntegrationView(definition, connection) });
  }, "Failed to get integration status");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    // Disconnecting stays available after the extension is uninstalled, so the
    // stored credential can always be revoked.
    const store = await openSpaceStore(spaceId);
    await deleteOAuthIntegrationForUser(store, user.id, providerParam);
    return successResponse();
  }, "Failed to disconnect integration");
