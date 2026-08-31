import { createHash, randomBytes } from "node:crypto";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBodyOrEmpty,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createOAuthIntegrationState } from "#db/space/oauthIntegrations.ts";
import {
  buildOAuthAuthorizationUrl,
  getOAuthCallbackUrl,
  getOAuthProviderConfiguration,
} from "#integrations/oauthProviders.ts";
import { normalizeRedirectPath, toBase64Url } from "#utils/url.ts";

function createOAuthState(): string {
  return toBase64Url(randomBytes(24));
}

function createPkceCodeVerifier(): string {
  return toBase64Url(randomBytes(48));
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash("sha256").update(codeVerifier).digest());
}

export const POST: ApiRouteHandler = (context) =>
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

    const body = await parseJsonBodyOrEmpty<{ redirectTo?: string }>(context.req.raw);
    const redirectTo = normalizeRedirectPath(
      typeof body.redirectTo === "string" ? body.redirectTo : null,
    );

    const configured = await getOAuthProviderConfiguration(spaceId, providerParam);
    if (!configured) {
      throw badRequestResponse("Unsupported integration provider");
    }
    if (!configured.configured) {
      throw badRequestResponse(
        `Provider is not configured: missing ${configured.missing.join(", ")}`,
      );
    }
    const state = createOAuthState();
    const codeVerifier = createPkceCodeVerifier();
    const codeChallenge = createPkceCodeChallenge(codeVerifier);
    const redirectUri = getOAuthCallbackUrl(spaceId, providerParam);

    const store = await openSpaceStore(spaceId);
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
