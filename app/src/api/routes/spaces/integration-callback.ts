import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  consumeOAuthIntegrationState,
  upsertOAuthIntegrationForUser,
} from "#db/oauthIntegrations.ts";
import { getSpace } from "#db/spaces.ts";
import {
  exchangeOAuthCode,
  fetchOAuthExternalUser,
  getOAuthCallbackUrl,
  getOAuthProviderConfiguration,
  isOAuthIntegrationProvider,
} from "#integrations/oauthProviders.ts";
import { appendQueryParams, normalizeRedirectPath } from "#integrations/oauthUtils.ts";
import { appLogger } from "#observability/logger.ts";

function redirectToPath(path: string): Response {
  return Response.redirect(path, 302);
}

function defaultSettingsPath(spaceSlug: string): string {
  return `/${spaceSlug}`;
}

async function resolveFallbackPath(spaceId: string): Promise<string> {
  const space = await getSpace(spaceId);
  if (!space) {
    return "/";
  }
  return defaultSettingsPath(space.slug);
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");

    if (!isOAuthIntegrationProvider(providerParam)) {
      return badRequestResponse("Unsupported integration provider");
    }

    // Authenticate before anything else, and outside the try below. A denial
    // has to reach the caller as 401/403: the catch turns failures into a
    // redirect, and that redirect's path is derived from the space slug, which
    // an unauthorized caller must not learn.
    const user = requireUser(context);
    await verifySpaceRole(spaceId, user.id, Permission.VIEWER);

    const fallbackPath = await resolveFallbackPath(spaceId);

    const redirectWithResult = (
      params: Record<string, string>,
      overridePath?: string | null,
    ): Response => {
      const path = normalizeRedirectPath(overridePath || undefined) || fallbackPath;
      return redirectToPath(appendQueryParams(path, params));
    };

    try {
      const url = new URL(context.req.raw.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");
      const oauthErrorDescription = url.searchParams.get("error_description");

      if (oauthError) {
        return redirectWithResult({
          integration: providerParam,
          status: "error",
          message: oauthErrorDescription || oauthError,
        });
      }

      if (!code || !state) {
        return redirectWithResult({
          integration: providerParam,
          status: "error",
          message: "Missing OAuth callback parameters",
        });
      }

      const statePayload = await consumeOAuthIntegrationState(
        spaceId,
        user.id,
        providerParam,
        state,
      );

      if (!statePayload) {
        return redirectWithResult({
          integration: providerParam,
          status: "error",
          message: "OAuth state is invalid or expired",
        });
      }

      const configured = getOAuthProviderConfiguration(providerParam);
      if (!configured.configured) {
        return redirectWithResult(
          {
            integration: providerParam,
            status: "error",
            message: `Provider is not configured: missing ${configured.missing.join(", ")}`,
          },
          statePayload.redirectTo,
        );
      }

      const redirectUri = getOAuthCallbackUrl(spaceId, providerParam);
      const tokenSet = await exchangeOAuthCode({
        providerConfig: configured.config,
        code,
        codeVerifier: statePayload.codeVerifier,
        redirectUri,
      });

      const externalUser = await fetchOAuthExternalUser(
        providerParam,
        configured.config,
        tokenSet.accessToken,
      );

      await upsertOAuthIntegrationForUser(
        spaceId,
        user.id,
        providerParam,
        externalUser.accountId,
        externalUser.username,
        configured.config.instanceUrl,
        tokenSet,
      );

      return redirectWithResult(
        {
          integration: providerParam,
          status: "connected",
        },
        statePayload.redirectTo,
      );
    } catch (error) {
      // Guards and helpers signal refusal by throwing a Response. Turning one
      // into a "something went wrong" redirect would hide the real status.
      if (error instanceof Response) throw error;

      appLogger.error("OAuth integration callback error", { error });
      const message = error instanceof Error ? error.message : "OAuth callback failed";
      return redirectWithResult({
        integration: providerParam,
        status: "error",
        message,
      });
    }
  }, "OAuth callback failed");
