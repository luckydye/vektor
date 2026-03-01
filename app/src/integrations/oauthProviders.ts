import { config } from "#config";
import type { OAuthIntegrationProvider } from "#db/oauthIntegrations.ts";

export interface OAuthProviderConfiguration {
  id: OAuthIntegrationProvider;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  instanceUrl: string | null;
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

export function isOAuthIntegrationProvider(
  value: string,
): value is OAuthIntegrationProvider {
  return value === "gitlab" || value === "youtrack";
}

export function getOAuthIntegrationProviders(): OAuthIntegrationProvider[] {
  return ["gitlab", "youtrack"];
}

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

export function getOAuthProviderConfiguration(
  provider: OAuthIntegrationProvider,
  options?: { instanceUrl?: string | null },
): { configured: true; config: OAuthProviderConfiguration } | {
  configured: false;
  missing: string[];
} {
  const appConfig = config();
  const requestedInstance = normalizeInstanceUrl(options?.instanceUrl);

  if (provider === "gitlab") {
    const baseUrl =
      requestedInstance ||
      normalizeInstanceUrl(appConfig.GITLAB_OAUTH_BASE_URL) ||
      "https://gitlab.com";

    const clientId = appConfig.GITLAB_OAUTH_CLIENT_ID?.trim() || "";
    const clientSecret = appConfig.GITLAB_OAUTH_CLIENT_SECRET?.trim() || "";
    const scopes = (appConfig.GITLAB_OAUTH_SCOPES || "read_api read_user")
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);

    const authorizationUrl =
      requestedInstance != null
        ? `${baseUrl}/oauth/authorize`
        : appConfig.GITLAB_OAUTH_AUTHORIZATION_URL?.trim() || `${baseUrl}/oauth/authorize`;
    const tokenUrl =
      requestedInstance != null
        ? `${baseUrl}/oauth/token`
        : appConfig.GITLAB_OAUTH_TOKEN_URL?.trim() || `${baseUrl}/oauth/token`;
    const userInfoUrl =
      requestedInstance != null
        ? `${baseUrl}/api/v4/user`
        : appConfig.GITLAB_OAUTH_USERINFO_URL?.trim() || `${baseUrl}/api/v4/user`;

    const missing: string[] = [];
    if (!clientId) missing.push("WIKI_GITLAB_OAUTH_CLIENT_ID");
    if (!clientSecret) missing.push("WIKI_GITLAB_OAUTH_CLIENT_SECRET");

    if (missing.length > 0) {
      return { configured: false, missing };
    }

    return {
      configured: true,
      config: {
        id: "gitlab",
        label: "GitLab",
        clientId,
        clientSecret,
        scopes,
        authorizationUrl,
        tokenUrl,
        userInfoUrl,
        instanceUrl: requestedInstance,
      },
    };
  }

  const baseUrl =
    requestedInstance || normalizeInstanceUrl(appConfig.YOUTRACK_OAUTH_BASE_URL) || null;

  const clientId = appConfig.YOUTRACK_OAUTH_CLIENT_ID?.trim() || "";
  const clientSecret = appConfig.YOUTRACK_OAUTH_CLIENT_SECRET?.trim() || "";
  const scopes = (appConfig.YOUTRACK_OAUTH_SCOPES || "YouTrack")
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const authorizationUrl =
    baseUrl != null
      ? `${baseUrl}/hub/api/rest/oauth2/auth`
      : appConfig.YOUTRACK_OAUTH_AUTHORIZATION_URL?.trim() || "";
  const tokenUrl =
    baseUrl != null
      ? `${baseUrl}/hub/api/rest/oauth2/token`
      : appConfig.YOUTRACK_OAUTH_TOKEN_URL?.trim() || "";
  const userInfoUrl =
    baseUrl != null
      ? `${baseUrl}/hub/api/rest/users/me?fields=id,login,name,email,ringId`
      : appConfig.YOUTRACK_OAUTH_USERINFO_URL?.trim() || "";

  const missing: string[] = [];
  if (!clientId) missing.push("WIKI_YOUTRACK_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("WIKI_YOUTRACK_OAUTH_CLIENT_SECRET");
  if (!authorizationUrl) missing.push("WIKI_YOUTRACK_OAUTH_AUTHORIZATION_URL or instanceUrl");
  if (!tokenUrl) missing.push("WIKI_YOUTRACK_OAUTH_TOKEN_URL or instanceUrl");
  if (!userInfoUrl) missing.push("WIKI_YOUTRACK_OAUTH_USERINFO_URL or instanceUrl");

  if (missing.length > 0) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      id: "youtrack",
      label: "YouTrack",
      clientId,
      clientSecret,
      scopes,
      authorizationUrl,
      tokenUrl,
      userInfoUrl,
      instanceUrl: requestedInstance,
    },
  };
}

export function getOAuthProviderLabel(provider: OAuthIntegrationProvider): string {
  return provider === "gitlab" ? "GitLab" : "YouTrack";
}

export function getOAuthCallbackUrl(
  spaceId: string,
  provider: OAuthIntegrationProvider,
): string {
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

  return `${providerConfig.authorizationUrl}?${params.toString()}`;
}

function parseTokenExchangeResponse(json: Record<string, unknown>): OAuthTokenExchangeResult {
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
    throw new Error(`OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  return parseTokenExchangeResponse(json);
}

export async function fetchOAuthExternalUser(
  provider: OAuthIntegrationProvider,
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

  if (provider === "gitlab") {
    const accountId = String(profile.id || "").trim();
    if (!accountId) {
      throw new Error("GitLab profile missing id");
    }
    const usernameRaw = profile.username ?? profile.name ?? profile.email ?? null;
    const username =
      typeof usernameRaw === "string" && usernameRaw.trim() ? usernameRaw.trim() : null;
    return { accountId, username };
  }

  const accountId = String(profile.id || profile.ringId || "").trim();
  if (!accountId) {
    throw new Error("YouTrack profile missing id");
  }
  const usernameRaw =
    profile.login ?? profile.username ?? profile.name ?? profile.email ?? null;
  const username =
    typeof usernameRaw === "string" && usernameRaw.trim() ? usernameRaw.trim() : null;
  return { accountId, username };
}
