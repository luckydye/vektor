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
  getOAuthProviderConfiguration,
  getOAuthProviderLabel,
  isOAuthIntegrationProvider,
} from "#integrations/oauthProviders.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const connection = await getOAuthIntegrationForUser(store, user.id, providerParam);
    const configured = getOAuthProviderConfiguration(providerParam);
    const instanceUrl = configured.configured
      ? configured.config.instanceUrl
      : (connection?.instanceUrl ?? null);

    return jsonResponse({
      connection: {
        provider: providerParam,
        label: getOAuthProviderLabel(providerParam),
        configured: configured.configured,
        missingConfig: configured.configured ? [] : configured.missing,
        connected: !!connection,
        externalAccountId: connection?.externalAccountId ?? null,
        externalUsername: connection?.externalUsername ?? null,
        instanceUrl,
        scopes: connection?.scope?.split(/\s+/).filter(Boolean) ?? [],
        accessTokenExpiresAt: connection?.accessTokenExpiresAt?.toISOString() ?? null,
        createdAt: connection?.createdAt.toISOString() ?? null,
        updatedAt: connection?.updatedAt.toISOString() ?? null,
        lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
      },
    });
  }, "Failed to get integration status");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    await deleteOAuthIntegrationForUser(store, user.id, providerParam);
    return successResponse();
  }, "Failed to disconnect integration");
