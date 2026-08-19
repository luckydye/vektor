import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
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
  getOAuthIntegrationProviders,
  getOAuthProviderConfiguration,
  getOAuthProviderLabel,
} from "#integrations/oauthProviders.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.VIEWER);

    const store = await openSpaceStore(spaceId);
    const existing = await listOAuthIntegrationsForUser(store, user.id);

    const connections = getOAuthIntegrationProviders().map((provider) => {
      const connection = existing.find((item) => item.provider === provider) ?? null;
      const providerConfig = getOAuthProviderConfiguration(provider);
      const instanceUrl = providerConfig.configured
        ? providerConfig.config.instanceUrl
        : (connection?.instanceUrl ?? null);

      return {
        provider,
        label: getOAuthProviderLabel(provider),
        configured: providerConfig.configured,
        missingConfig: providerConfig.configured ? [] : providerConfig.missing,
        connected: !!connection,
        externalAccountId: connection?.externalAccountId ?? null,
        externalUsername: connection?.externalUsername ?? null,
        instanceUrl,
        scopes: connection?.scope?.split(/\s+/).filter(Boolean) ?? [],
        accessTokenExpiresAt: connection?.accessTokenExpiresAt?.toISOString() ?? null,
        createdAt: connection?.createdAt.toISOString() ?? null,
        updatedAt: connection?.updatedAt.toISOString() ?? null,
        lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
      };
    });

    return jsonResponse({ connections });
  }, "Failed to list integrations");
