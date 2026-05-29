import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  deleteOAuthIntegrationForUser,
  getOAuthIntegrationForUser,
} from "#db/oauthIntegrations.ts";
import {
  getOAuthProviderConfiguration,
  getOAuthProviderLabel,
  isOAuthIntegrationProvider,
} from "#integrations/oauthProviders.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const providerParam = requireParam(context.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    await verifySpaceRole(spaceId, user.id, "viewer");

    const connection = await getOAuthIntegrationForUser(spaceId, user.id, providerParam);
    const configured = getOAuthProviderConfiguration(providerParam, {
      instanceUrl: connection?.instanceUrl ?? null,
    });

    return jsonResponse({
      connection: {
        provider: providerParam,
        label: getOAuthProviderLabel(providerParam),
        configured: configured.configured,
        missingConfig: configured.configured ? [] : configured.missing,
        connected: !!connection,
        externalAccountId: connection?.externalAccountId ?? null,
        externalUsername: connection?.externalUsername ?? null,
        instanceUrl: connection?.instanceUrl ?? null,
        scopes: connection?.scope?.split(/\s+/).filter(Boolean) ?? [],
        accessTokenExpiresAt: connection?.accessTokenExpiresAt?.toISOString() ?? null,
        createdAt: connection?.createdAt.toISOString() ?? null,
        updatedAt: connection?.updatedAt.toISOString() ?? null,
        lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
      },
    });
  }, "Failed to get integration status");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const providerParam = requireParam(context.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    await verifySpaceRole(spaceId, user.id, "viewer");

    await deleteOAuthIntegrationForUser(spaceId, user.id, providerParam);
    return successResponse();
  }, "Failed to disconnect integration");
