import { createHmac } from "node:crypto";
import { config, integrationOAuthEnv } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { listExtensions } from "#db/space/extensions.ts";
import {
  getOAuthIntegrationCredentialForUser,
  type OAuthIntegrationConnection,
  type OAuthIntegrationCredential,
  updateOAuthIntegrationTokenSet,
} from "#db/space/oauthIntegrations.ts";
import type { ExtensionIntegration } from "#extensions/manifest.ts";
import { appLogger } from "#observability/logger.ts";

export interface OAuthProviderConfiguration {
  id: string;
  label: string;
  clientId: string;
  /** Null for a public client, which proves itself with PKCE alone. */
  clientSecret: string | null;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  /** Null when the profile is read from the `id_token` instead. */
  userInfoUrl: string | null;
  /** Null when the provider redirects back to Vektor's own callback. */
  redirectUri: string | null;
  registration: ExtensionIntegration["registration"] | null;
  tokenParams: Record<string, string>;
  manageUrl: string | null;
  ai: ExtensionIntegration["ai"] | null;
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
  idToken: string | null;
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

  // A manifest-declared public client needs nothing from the operator.
  const clientId = env.clientId || integration.clientId || "";
  const clientSecret = integration.clientId ? null : env.clientSecret;
  const missing: string[] = [];
  if (!clientId) missing.push(`${env.envPrefix}_CLIENT_ID`);
  if (clientSecret === "") missing.push(`${env.envPrefix}_CLIENT_SECRET`);

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
  const userInfoUrl = integration.userInfoUrl
    ? resolveEndpoint(integration.userInfoUrl, instanceUrl, missing, env.envPrefix)
    : null;

  if (missing.length > 0) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      id: integration.id,
      label: integration.label,
      clientId,
      clientSecret,
      scopes: env.scopes.length > 0 ? env.scopes : (integration.scopes ?? []),
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      redirectUri: integration.redirectUri ?? null,
      registration: integration.registration ?? null,
      tokenParams: integration.tokenParams ?? {},
      manageUrl: integration.manageUrl ?? null,
      ai: integration.ai ?? null,
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

/** The redirect URI the provider sends the browser to, and the exchange repeats. */
export function getOAuthRedirectUri(
  spaceId: string,
  providerConfig: OAuthProviderConfiguration,
): string {
  return providerConfig.redirectUri ?? getOAuthCallbackUrl(spaceId, providerConfig.id);
}

/**
 * The stable id a registering provider tells this instance's clients apart by.
 * Derived from the instance's auth secret rather than stored, so it survives
 * disconnects and never identifies a user.
 */
export function getIntegrationHostId(providerId: string): string {
  const secret = config().AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET must be configured");
  const hex = createHmac("sha256", secret)
    .update(`integration-host-id:${providerId}`)
    .digest("hex");
  // Shaped as a version 4 UUID: the version nibble and variant bits are fixed.
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The client a connection's tokens belong to. */
export function getOAuthClientId(
  providerConfig: OAuthProviderConfiguration,
  connection: Pick<OAuthIntegrationConnection, "clientId"> | null,
): string {
  return connection?.clientId ?? providerConfig.clientId;
}

export function buildOAuthAuthorizationUrl(options: {
  providerConfig: OAuthProviderConfiguration;
  /** The client registered on an earlier connection, reused instead of registering again. */
  clientId: string;
  state: string;
  codeChallenge: string;
  redirectUri: string;
}): string {
  const { providerConfig, clientId, state, codeChallenge, redirectUri } = options;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
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
  if (providerConfig.registration) {
    params.set(
      providerConfig.registration.hostIdParam,
      getIntegrationHostId(providerConfig.id),
    );
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

  const idToken =
    typeof json.id_token === "string" && json.id_token ? json.id_token : null;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    idToken,
  };
}

function tokenRequestBody(
  providerConfig: OAuthProviderConfiguration,
  params: Record<string, string>,
): URLSearchParams {
  const body = new URLSearchParams(providerConfig.tokenParams);
  for (const [name, value] of Object.entries(params)) body.set(name, value);
  if (providerConfig.clientSecret) body.set("client_secret", providerConfig.clientSecret);
  return body;
}

export async function exchangeOAuthCode(options: {
  providerConfig: OAuthProviderConfiguration;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokenExchangeResult> {
  const { providerConfig, clientId, code, codeVerifier, redirectUri } = options;
  const body = tokenRequestBody(providerConfig, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
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
  clientId: string;
  refreshToken: string;
}): Promise<OAuthTokenExchangeResult> {
  const { providerConfig, clientId, refreshToken } = options;
  const body = tokenRequestBody(providerConfig, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
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

/** Seconds before expiry at which we proactively refresh the access token. */
const REFRESH_BUFFER_SECS = 60;

/**
 * Refreshes in flight, by connection. Providers that rotate the refresh token
 * accept each one once, so two concurrent refreshes would sign the user out.
 */
const refreshesInFlight = new Map<string, Promise<string>>();

/**
 * Returns a valid access token for the credential, refreshing it first if it
 * is expired or within REFRESH_BUFFER_SECS of expiry.  Throws if the token is
 * expired and no refresh token is available.
 */
function needsRefresh(credential: OAuthIntegrationCredential): boolean {
  return (
    credential.accessTokenExpiresAt !== null &&
    credential.accessTokenExpiresAt.getTime() <= Date.now() + REFRESH_BUFFER_SECS * 1000
  );
}

export async function resolveIntegrationAccessToken(
  spaceId: string,
  credential: OAuthIntegrationCredential,
  providerConfig: OAuthProviderConfiguration,
): Promise<string> {
  if (!needsRefresh(credential)) {
    return credential.accessToken;
  }

  const inFlight = refreshesInFlight.get(credential.id);
  if (inFlight) return inFlight;

  const refresh = (async () => {
    // Re-read inside the exclusive section: a refresh that finished after the
    // caller read its credential has already spent that refresh token.
    const store = await openSpaceStore(spaceId);
    const current = await getOAuthIntegrationCredentialForUser(
      store,
      credential.userId,
      credential.provider,
    );
    if (!current) throw new Error(`${credential.provider} is not connected`);
    if (!needsRefresh(current)) return current.accessToken;

    const { refreshToken } = current;
    if (!refreshToken) {
      throw new Error(
        `${current.provider} access token has expired and no refresh token is available. ` +
          `Please reconnect the integration.`,
      );
    }

    const refreshed = await refreshOAuthToken({
      providerConfig,
      clientId: getOAuthClientId(providerConfig, current),
      refreshToken,
    });

    await updateOAuthIntegrationTokenSet(store, current.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? refreshToken, // keep old refresh token if provider didn't return a new one
      expiresAt: refreshed.expiresAt,
      scope: refreshed.scope ?? current.scope,
    });

    return refreshed.accessToken;
  })().finally(() => refreshesInFlight.delete(credential.id));
  refreshesInFlight.set(credential.id, refresh);
  return refresh;
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

/**
 * The ID token's claims. Its signature is not checked: the token came straight
 * from the token endpoint over TLS, which OpenID Connect Core 3.1.3.7 accepts
 * in place of validating it.
 */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split(".")[1];
  if (!payload) throw new Error("OAuth ID token is malformed");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<
    string,
    unknown
  >;
}

async function fetchOAuthProfile(
  providerConfig: OAuthProviderConfiguration,
  tokenSet: OAuthTokenExchangeResult,
): Promise<Record<string, unknown>> {
  if (!providerConfig.userInfoUrl) {
    if (!tokenSet.idToken) {
      throw new Error(`${providerConfig.label} token response has no id_token`);
    }
    return decodeIdTokenClaims(tokenSet.idToken);
  }

  const response = await fetch(providerConfig.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${tokenSet.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OAuth profile fetch failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

export async function fetchOAuthExternalUser(
  providerConfig: OAuthProviderConfiguration,
  tokenSet: OAuthTokenExchangeResult,
): Promise<OAuthExternalUser> {
  const profile = await fetchOAuthProfile(providerConfig, tokenSet);
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
  /** The browser lands on a dead loopback page whose address the user pastes back. */
  pastesRedirect: boolean;
  manageUrl: string | null;
  /** Set when the integration can run the user's agent chats: lists their models. */
  aiModelsPath: string | null;
  aiModel: string | null;
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
    pastesRedirect: !!definition.integration.redirectUri,
    manageUrl: definition.integration.manageUrl ?? null,
    aiModelsPath: definition.integration.ai?.modelsPath ?? null,
    aiModel: connection?.aiModel ?? null,
    scopes: connection?.scope?.split(/\s+/).filter(Boolean) ?? [],
    accessTokenExpiresAt: connection?.accessTokenExpiresAt?.toISOString() ?? null,
    createdAt: connection?.createdAt.toISOString() ?? null,
    updatedAt: connection?.updatedAt.toISOString() ?? null,
    lastUsedAt: connection?.lastUsedAt?.toISOString() ?? null,
  };
}
