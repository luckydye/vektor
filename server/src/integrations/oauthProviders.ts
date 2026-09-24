import { config, integrationOAuthEnv } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { listExtensions } from "#db/space/extensions.ts";
import type { OAuthIntegrationConnection } from "#db/space/oauthIntegrations.ts";
import type { ExtensionIntegration } from "#extensions/manifest.ts";
import { appLogger } from "#observability/logger.ts";

export interface OAuthProviderConfiguration {
  id: string;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  instanceUrl: string | null;
  /** Every proxied request is forced under this path when set. */
  apiBasePath: string | null;
  /** Extra query parameters the manifest adds to the authorization redirect. */
  authorizationParams: Record<string, string>;
  profile: ExtensionIntegration["profile"];
}

export interface OAuthTokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface OAuthExternalUser {
  accountId: string;
  username: string | null;
}

/** A provider an installed extension declares, before credentials are applied. */
export interface OAuthProviderDefinition {
  extensionId: string;
  integration: ExtensionIntegration;
}

export type OAuthProviderResolution =
  | { configured: true; config: OAuthProviderConfiguration }
  | { configured: false; missing: string[] };

export function normalizeInstanceUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  const raw = value.trim();
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  parsed.hash = "";
  parsed.search = "";

  return parsed.toString().replace(/\/$/, "");
}

/**
 * Providers contributed by the space's enabled extensions. Two extensions
 * claiming one id is a packaging mistake; the first install wins so the space
 * keeps whichever provider its stored connections already point at.
 */
export async function listOAuthProviderDefinitions(
  spaceId: string,
): Promise<OAuthProviderDefinition[]> {
  const extensions = await listExtensions(await openSpaceStore(spaceId));
  const byId = new Map<string, OAuthProviderDefinition>();

  for (const extension of extensions) {
    for (const integration of extension.manifest.integrations ?? []) {
      const existing = byId.get(integration.id);
      if (existing) {
        appLogger.warn("Duplicate OAuth integration id across extensions", {
          spaceId,
          provider: integration.id,
          kept: existing.extensionId,
          ignored: extension.id,
        });
        continue;
      }
      byId.set(integration.id, { extensionId: extension.id, integration });
    }
  }

  return [...byId.values()];
}

export async function getOAuthProviderDefinition(
  spaceId: string,
  providerId: string,
): Promise<OAuthProviderDefinition | null> {
  const definitions = await listOAuthProviderDefinitions(spaceId);
  return definitions.find((entry) => entry.integration.id === providerId) ?? null;
}

/**
 * Endpoints are templated so one manifest serves both a hosted service and a
 * self-hosted instance. A template with no instance URL to fill in is reported
 * as missing configuration rather than fetched with a literal placeholder.
 */
function resolveEndpoint(
  template: string,
  instanceUrl: string | null,
  missing: string[],
  envPrefix: string,
): string {
  if (!template.includes("{instance}")) return template;
  if (!instanceUrl) {
    if (!missing.includes(`${envPrefix}_BASE_URL`)) missing.push(`${envPrefix}_BASE_URL`);
    return "";
  }
  return template.replaceAll("{instance}", instanceUrl);
}

export function resolveOAuthProviderConfiguration(
  definition: OAuthProviderDefinition,
): OAuthProviderResolution {
  const { integration } = definition;
  const env = integrationOAuthEnv(integration.id);
  const instanceUrl =
    normalizeInstanceUrl(env.baseUrl) ||
    normalizeInstanceUrl(integration.defaultInstanceUrl) ||
    null;

  const missing: string[] = [];
  if (!env.clientId) missing.push(`${env.envPrefix}_CLIENT_ID`);
  if (!env.clientSecret) missing.push(`${env.envPrefix}_CLIENT_SECRET`);

  const authorizationUrl = resolveEndpoint(
    integration.authorizationUrl,
    instanceUrl,
    missing,
    env.envPrefix,
  );
  const tokenUrl = resolveEndpoint(
    integration.tokenUrl,
    instanceUrl,
    missing,
    env.envPrefix,
  );
  const userInfoUrl = resolveEndpoint(
    integration.userInfoUrl,
    instanceUrl,
    missing,
    env.envPrefix,
  );

  if (missing.length > 0) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      id: integration.id,
      label: integration.label,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      scopes: env.scopes.length > 0 ? env.scopes : (integration.scopes ?? []),
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      instanceUrl,
      apiBasePath: integration.apiBasePath ?? null,
      authorizationParams: integration.authorizationParams ?? {},
      profile: integration.profile,
    },
  };
}

/** Null when no installed extension declares the provider. */
export async function getOAuthProviderConfiguration(
  spaceId: string,
  providerId: string,
): Promise<OAuthProviderResolution | null> {
  const definition = await getOAuthProviderDefinition(spaceId, providerId);
  return definition ? resolveOAuthProviderConfiguration(definition) : null;
}

export function getOAuthCallbackUrl(spaceId: string, provider: string): string {
  return `${config().SITE_URL}/api/v1/spaces/${spaceId}/integrations/${provider}/callback`;
}

export function buildOAuthAuthorizationUrl(options: {
  providerConfig: OAuthProviderConfiguration;
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const { providerConfig, state, codeChallenge, redirectUri } = options;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: providerConfig.clientId,
    redirect_uri: redirectUri,
    scope: providerConfig.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  // Appended rather than merged in: the manifest is validated against the set
  // above, so nothing here can overwrite `state` or the PKCE challenge.
  for (const [name, value] of Object.entries(providerConfig.authorizationParams)) {
    params.set(name, value);
  }

  return `${providerConfig.authorizationUrl}?${params.toString()}`;
}

function parseTokenExchangeResponse(
  json: Record<string, unknown>,
): OAuthTokenExchangeResult {
  const accessToken = String(json.access_token || "").trim();
  if (!accessToken) {
    throw new Error("OAuth token response missing access_token");
  }

  const refreshTokenRaw = json.refresh_token;
  const refreshToken =
    typeof refreshTokenRaw === "string" && refreshTokenRaw.trim()
      ? refreshTokenRaw.trim()
      : null;

  const expiresInRaw = json.expires_in;
  const expiresInSec =
    typeof expiresInRaw === "number"
      ? expiresInRaw
      : typeof expiresInRaw === "string"
        ? Number(expiresInRaw)
        : NaN;
  const expiresAt = Number.isFinite(expiresInSec)
    ? new Date(Date.now() + Math.max(0, expiresInSec) * 1000)
    : null;

  const scopeRaw = json.scope;
  const scope = typeof scopeRaw === "string" && scopeRaw.trim() ? scopeRaw.trim() : null;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
  };
}

export async function exchangeOAuthCode(options: {
  providerConfig: OAuthProviderConfiguration;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokenExchangeResult> {
  const { providerConfig, code, codeVerifier, redirectUri } = options;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(providerConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  return parseTokenExchangeResponse(json);
}

export async function refreshOAuthToken(options: {
  providerConfig: OAuthProviderConfiguration;
  refreshToken: string;
}): Promise<OAuthTokenExchangeResult> {
  const { providerConfig, refreshToken } = options;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
  });

  const response = await fetch(providerConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OAuth token refresh failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  return parseTokenExchangeResponse(json);
}

/** First field that holds a non-empty scalar, following the manifest's order. */
function pickProfileField(
  profile: Record<string, unknown>,
  fields: string[] | undefined,
): string | null {
  for (const field of fields ?? []) {
    const value = profile[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

export async function fetchOAuthExternalUser(
  providerConfig: OAuthProviderConfiguration,
  accessToken: string,
): Promise<OAuthExternalUser> {
  const response = await fetch(providerConfig.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OAuth profile fetch failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  const profile = (await response.json()) as Record<string, unknown>;
  const accountId = pickProfileField(profile, providerConfig.profile.accountId);
  if (!accountId) {
    throw new Error(
      `${providerConfig.label} profile is missing ${providerConfig.profile.accountId.join(" / ")}`,
    );
  }

  return {
    accountId,
    username: pickProfileField(profile, providerConfig.profile.username),
  };
}

/** One provider as the settings UI sees it: what it is, plus this user's link to it. */
export interface OAuthIntegrationView {
  provider: string;
  label: string;
  description: string | null;
  extensionId: string;
  configured: boolean;
  missingConfig: string[];
  connected: boolean;
  externalAccountId: string | null;
  externalUsername: string | null;
  instanceUrl: string | null;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
}

export function buildIntegrationView(
  definition: OAuthProviderDefinition,
  connection: OAuthIntegrationConnection | null,
): OAuthIntegrationView {
  const resolved = resolveOAuthProviderConfiguration(definition);
  const instanceUrl = resolved.configured
    ? resolved.config.instanceUrl
    : (connection?.instanceUrl ?? null);

  return {
    provider: definition.integration.id,
    label: definition.integration.label,
    description: definition.integration.description ?? null,
    extensionId: definition.extensionId,
    configured: resolved.configured,
    missingConfig: resolved.configured ? [] : resolved.missing,
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
}
