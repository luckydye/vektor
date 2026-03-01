import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { listOAuthIntegrationsForUser } from "#db/oauthIntegrations.ts";
import {
  getOAuthIntegrationProviders,
  getOAuthProviderConfiguration,
  getOAuthProviderLabel,
} from "#integrations/oauthProviders.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "viewer");

    const existing = await listOAuthIntegrationsForUser(spaceId, user.id);

    const connections = getOAuthIntegrationProviders().map((provider) => {
      const connection = existing.find((item) => item.provider === provider) ?? null;
      const providerConfig = getOAuthProviderConfiguration(provider, {
        instanceUrl: connection?.instanceUrl ?? null,
      });

      return {
        provider,
        label: getOAuthProviderLabel(provider),
        configured: providerConfig.configured,
        missingConfig: providerConfig.configured ? [] : providerConfig.missing,
        connected: !!connection,
        externalAccountId: connection?.externalAccountId ?? null,
        externalUsername: connection?.externalUsername ?? null,
        instanceUrl: connection?.instanceUrl ?? null,
        scopes: connection?.scope?.split(/\s+/).filter(Boolean) ?? [],
        accessTokenExpiresAt: connection?.accessTokenExpiresAt?.toISOString() ?? null,
        createdAt: connection?.createdAt.toISOString() ?? null,
        updatedAt: connection?.updatedAt.toISOString() ?? null,
        lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
      };
    });

    return jsonResponse({ connections });
  }, "Failed to list integrations");
