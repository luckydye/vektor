import { openSpaceStore } from "#db/client/store.ts";
import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBodyOrEmpty,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { createOAuthIntegrationState } from "#db/space/oauthIntegrations.ts";
import {
  buildOAuthAuthorizationUrl,
  getOAuthCallbackUrl,
  getOAuthProviderConfiguration,
  isOAuthIntegrationProvider,
} from "#integrations/oauthProviders.ts";
import {
  createOAuthState,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  normalizeRedirectPath,
} from "#integrations/oauthUtils.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const store = await openSpaceStore(spaceId);
    const providerParam = requireParam(context.var.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    await verifySpaceRole(spaceId, user.id, Permission.VIEWER);

    const body = await parseJsonBodyOrEmpty<{ redirectTo?: string }>(context.req.raw);
    const redirectTo = normalizeRedirectPath(
      typeof body.redirectTo === "string" ? body.redirectTo : null,
    );

    const configured = getOAuthProviderConfiguration(providerParam);
    if (!configured.configured) {
      throw badRequestResponse(
        `Provider is not configured: missing ${configured.missing.join(", ")}`,
      );
    }
    const state = createOAuthState();
    const codeVerifier = createPkceCodeVerifier();
    const codeChallenge = createPkceCodeChallenge(codeVerifier);
    const redirectUri = getOAuthCallbackUrl(spaceId, providerParam);

    await createOAuthIntegrationState(
      store,
      user.id,
      providerParam,
      state,
      codeVerifier,
      redirectTo,
      configured.config.instanceUrl,
    );

    const authorizeUrl = buildOAuthAuthorizationUrl({
      providerConfig: configured.config,
      state,
      codeChallenge,
      redirectUri,
    });

    return jsonResponse({ authorizeUrl });
  }, "Failed to start integration OAuth flow");
