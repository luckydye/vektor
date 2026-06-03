import type { APIContext, APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  requireParam,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  getOAuthIntegrationCredentialForUser,
  type OAuthIntegrationProvider,
} from "#db/oauthIntegrations.ts";
import {
  getOAuthProviderConfiguration,
  type OAuthProviderConfiguration,
  isOAuthIntegrationProvider,
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

async function resolveUserId(context: APIContext, spaceId: string): Promise<string> {
  const jobToken = context.request.headers.get("X-Job-Token");
  if (jobToken) {
    const parsed = parseJobToken(jobToken, spaceId);
    if (!parsed?.userId) {
      throw unauthorizedResponse();
    }
    await verifySpaceRole(spaceId, parsed.userId, "viewer");
    return parsed.userId;
  }

  const user = requireUser(context);
  await verifySpaceRole(spaceId, user.id, "viewer");
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

function buildIntegrationApiUrl(
  provider: OAuthIntegrationProvider,
  providerConfig: OAuthProviderConfiguration,
  rawPath: string,
): URL {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw badRequestResponse("path is required");
  }

  const base = getProviderBaseUrl(providerConfig);

  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.origin !== base.origin) {
      throw badRequestResponse(`${provider} request URL must match configured origin`);
    }
    if (
      provider === "gitlab" &&
      !parsed.pathname.startsWith("/api/v4/") &&
      parsed.pathname !== "/api/v4"
    ) {
      throw badRequestResponse("GitLab request URL must target /api/v4");
    }
    return parsed;
  }

  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (provider === "gitlab") {
    return new URL(path.startsWith("/api/v4") ? path : `/api/v4${path}`, base);
  }
  return new URL(path, base);
}

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.params, "spaceId");
    const providerParam = requireParam(context.params, "provider");
    if (!isOAuthIntegrationProvider(providerParam)) {
      throw badRequestResponse("Unsupported integration provider");
    }

    const userId = await resolveUserId(context, spaceId);

    const body = (await context.request.json().catch(() => null)) as
      | IntegrationProxyRequest
      | null;
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

    const providerConfig = getOAuthProviderConfiguration(providerParam);
    if (!providerConfig.configured) {
      throw badRequestResponse(
        `${providerParam} is not configured: missing ${providerConfig.missing.join(", ")}`,
      );
    }

    const credential = await getOAuthIntegrationCredentialForUser(
      spaceId,
      userId,
      providerParam,
    );
    if (!credential) {
      throw badRequestResponse(`${providerParam} is not connected for this user`);
    }

    const headers = normalizeProxyHeaders(body.headers);
    headers.set("Authorization", `Bearer ${credential.accessToken}`);

    const response = await fetch(
      buildIntegrationApiUrl(providerParam, providerConfig.config, body.path),
      {
        method,
        headers,
        body: method === "GET" || method === "DELETE" ? undefined : body.body,
      },
    );

    const responseText = await response.text();
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of response.headers.entries()) {
      if (
        [
          "content-type",
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
