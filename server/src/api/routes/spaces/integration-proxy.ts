import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  requireParam,
  requireUser,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiContext, ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  getOAuthIntegrationCredentialForUser,
  type OAuthIntegrationCredential,
  updateOAuthIntegrationTokenSet,
} from "#db/space/oauthIntegrations.ts";
import {
  getOAuthProviderConfiguration,
  type OAuthProviderConfiguration,
  refreshOAuthToken,
} from "#integrations/oauthProviders.ts";
import { parseJobToken } from "#jobs/jobToken.ts";

type IntegrationProxyRequest = {
  method?: string;
  path?: string;
  headers?: Record<string, unknown>;
  body?: string;
};

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const FORWARDED_HEADERS = new Set(["accept", "content-type"]);

async function resolveUserId(context: ApiContext, spaceId: string): Promise<string> {
  const jobToken = context.req.raw.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed?.userId) {
      throw unauthorizedResponse();
    }
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      parsed.userId,
      Permission.VIEWER,
    );
    return parsed.userId;
  }

  const user = requireUser(context);
  await verifyAccess(
    spaceId,
    { type: ResourceType.SPACE, id: spaceId },
    user.id,
    Permission.VIEWER,
  );
  return user.id;
}

function normalizeProxyHeaders(rawHeaders: Record<string, unknown> | undefined): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");

  for (const [name, value] of Object.entries(rawHeaders ?? {})) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = name.trim().toLowerCase();
    if (!FORWARDED_HEADERS.has(normalized)) {
      continue;
    }
    if (value.trim()) {
      headers.set(name, value);
    }
  }

  return headers;
}

function getProviderBaseUrl(providerConfig: OAuthProviderConfiguration): URL {
  if (providerConfig.instanceUrl) {
    return new URL(providerConfig.instanceUrl);
  }
  return new URL(providerConfig.userInfoUrl);
}

/**
 * Resolve the caller's `path` against the configured provider origin. Every
 * request built here carries the caller's OAuth access token, so the result is
 * checked against `base.origin` unconditionally, for every provider, and is
 * confined to the manifest's `apiBasePath` when it declares one.
 */
export function buildIntegrationApiUrl(
  providerConfig: OAuthProviderConfiguration,
  rawPath: string,
): URL {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw badRequestResponse("path is required");
  }

  const base = getProviderBaseUrl(providerConfig);
  const apiBasePath = providerConfig.apiBasePath?.replace(/\/$/, "") || null;
  let resolved: URL;

  if (/^https?:\/\//i.test(trimmed)) {
    resolved = new URL(trimmed);
  } else {
    // `URL` strips tab/CR/LF itself, so `/\t/evil.example` would slip past the
    // protocol-relative check below.
    const stripped = trimmed.replace(/[\t\n\r]/g, "");
    const path = stripped.startsWith("/") ? stripped : `/${stripped}`;
    if (path[1] === "/" || path[1] === "\\") {
      throw badRequestResponse("path must be a plain absolute path");
    }
    resolved = new URL(
      apiBasePath && !path.startsWith(`${apiBasePath}/`) && path !== apiBasePath
        ? `${apiBasePath}${path}`
        : path,
      base,
    );
  }

  if (resolved.origin !== base.origin) {
    throw badRequestResponse(
      `${providerConfig.id} request URL must match configured origin`,
    );
  }

  // Checked after resolution, not on the caller's string: `URL` collapses `..`
  // segments, so a prefixed `/calendar/v3/../drive/v3/files` would otherwise
  // leave the base path while still passing the origin check above.
  if (
    apiBasePath &&
    resolved.pathname !== apiBasePath &&
    !resolved.pathname.startsWith(`${apiBasePath}/`)
  ) {
    throw badRequestResponse(
      `${providerConfig.id} request URL must target ${apiBasePath}`,
    );
  }

  return resolved;
}

/** Seconds before expiry at which we proactively refresh the access token. */
const REFRESH_BUFFER_SECS = 60;

/**
 * Returns a valid access token for the credential, refreshing it first if it
 * is expired or within REFRESH_BUFFER_SECS of expiry.  Throws if the token is
 * expired and no refresh token is available.
 */
async function resolveAccessToken(
  spaceId: string,
  credential: OAuthIntegrationCredential,
  providerConfig: OAuthProviderConfiguration,
): Promise<string> {
  const { accessTokenExpiresAt, refreshToken } = credential;

  const needsRefresh =
    accessTokenExpiresAt !== null &&
    accessTokenExpiresAt.getTime() <= Date.now() + REFRESH_BUFFER_SECS * 1000;

  if (!needsRefresh) {
    return credential.accessToken;
  }

  if (!refreshToken) {
    throw new Error(
      `${credential.provider} access token has expired and no refresh token is available. ` +
        `Please reconnect the integration.`,
    );
  }

  const refreshed = await refreshOAuthToken({ providerConfig, refreshToken });

  await updateOAuthIntegrationTokenSet(await openSpaceStore(spaceId), credential.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshToken, // keep old refresh token if provider didn't return a new one
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope ?? credential.scope,
  });

  return refreshed.accessToken;
}

/**
 * Call the provider's API with the space's stored credentials
 *
 * @tag Integrations
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const providerParam = requireParam(context.var.params, "provider");
    const userId = await resolveUserId(context, spaceId);

    const body = (await context.req.raw
      .json()
      .catch(() => null)) as IntegrationProxyRequest | null;
    if (!body || typeof body !== "object") {
      throw badRequestResponse("Invalid JSON body");
    }

    const method = (body.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw badRequestResponse("method must be one of GET, POST, PUT, PATCH, DELETE");
    }
    if (typeof body.path !== "string") {
      throw badRequestResponse("path is required");
    }
    if (body.body !== undefined && typeof body.body !== "string") {
      throw badRequestResponse("body must be a string");
    }

    const providerConfig = await getOAuthProviderConfiguration(spaceId, providerParam);
    if (!providerConfig) {
      throw badRequestResponse("Unsupported integration provider");
    }
    if (!providerConfig.configured) {
      throw badRequestResponse(
        `${providerParam} is not configured: missing ${providerConfig.missing.join(", ")}`,
      );
    }

    const store = await openSpaceStore(spaceId);
    const credential = await getOAuthIntegrationCredentialForUser(
      store,
      userId,
      providerParam,
    );
    if (!credential) {
      throw badRequestResponse(`${providerParam} is not connected for this user`);
    }
    if (credential.userId !== userId) {
      throw forbiddenResponse("Integration credential does not belong to this user");
    }

    const accessToken = await resolveAccessToken(
      spaceId,
      credential,
      providerConfig.config,
    );

    const headers = normalizeProxyHeaders(body.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);

    const response = await fetch(
      buildIntegrationApiUrl(providerConfig.config, body.path),
      {
        method,
        headers,
        body: method === "GET" || method === "DELETE" ? undefined : body.body,
        // Following a redirect would re-send the access token above to wherever
        // the upstream points, so the 3xx is relayed to the caller instead.
        redirect: "manual",
      },
    );

    const responseText = await response.text();
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      if (
        [
          "content-type",
          // Without this, a relayed 3xx is a dead end the caller cannot act on.
          "location",
          "link",
          "x-next-page",
          "x-page",
          "x-per-page",
          "x-total",
          "x-total-pages",
        ].includes(name.toLowerCase())
      ) {
        responseHeaders[name] = value;
      }
    }

    return jsonResponse({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseText,
    });
  }, "Failed to proxy integration request");
