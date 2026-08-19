import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { NO_GROUPS, sanitizeOAuthGroups } from "#acl/oauthGroups.ts";
import { config, isHttpsSite } from "./config.ts";
import type { Database } from "./db/client/connection.ts";
import { getAuthDb } from "./db/client/db.ts";
import * as schema from "./db/schema/auth.ts";

type AppConfig = ReturnType<typeof config>;

function trustedOriginsFor(appConfig: AppConfig): string[] {
  return [
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://127.0.0.1:4321",
    "http://localhost:4321",
    ...(appConfig.SITE_URL ? [appConfig.SITE_URL] : []),
  ];
}

/**
 * Google social login is enabled only when both the client id and secret are
 * present. Returns `undefined` (rather than a partial config) so better-auth
 * never registers a half-configured provider.
 */
function getGoogleConfig(appConfig: AppConfig) {
  const clientId = appConfig.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = appConfig.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return {
    google: {
      clientId,
      clientSecret,
      overrideUserInfoOnSignIn: true,
      ...(appConfig.GOOGLE_REDIRECT_URI
        ? { redirectURI: appConfig.GOOGLE_REDIRECT_URI }
        : {}),
    },
  };
}

function getOAuthConfig(appConfig: AppConfig): GenericOAuthConfig[] {
  if (
    !appConfig.OAUTH_PROVIDER_ID ||
    !appConfig.OAUTH_CLIENT_ID ||
    !appConfig.OAUTH_CLIENT_SECRET
  ) {
    return [];
  }
  return [
    {
      redirectURI: appConfig.OAUTH_REDIRECT_URI,
      providerId: appConfig.OAUTH_PROVIDER_ID,
      clientId: appConfig.OAUTH_CLIENT_ID,
      clientSecret: appConfig.OAUTH_CLIENT_SECRET,
      scopes: appConfig.OAUTH_SCOPES?.split(","),
      authorizationUrl: appConfig.OAUTH_AUTHORIZATION_URL,
      tokenUrl: appConfig.OAUTH_TOKEN_URL,
      userInfoUrl: appConfig.OAUTH_USERINFO_URL,
      // Re-apply the mapped profile on every sign-in. Without it better-auth
      // writes it at account creation only, so a group revoked in the IdP would
      // go on granting ACL access here forever.
      overrideUserInfo: true,
      mapProfileToUser: async (profile) => ({
        id: profile.id,
        email: profile.email,
        name: profile.name,
        image: profile.image,
        emailVerified: profile.emailVerified || false,
        groups: sanitizeOAuthGroups(profile.wiki_groups),
      }),
    },
  ];
}

/**
 * Config and database are arguments so a test can drive the real provider
 * configuration, group claim mapping included, against its own database.
 */
export function createAuth(appConfig: AppConfig, authDb: Database) {
  const googleConfig = getGoogleConfig(appConfig);

  return betterAuth({
    baseURL: appConfig.SITE_URL || "http://localhost:8080",

    secret: appConfig.AUTH_SECRET,

    database: drizzleAdapter(authDb, {
      provider: "sqlite",
      schema,
      usePlural: false,
    }),

    user: {
      additionalFields: {
        groups: {
          type: "string",
          required: false,
          defaultValue: NO_GROUPS,
          input: false,
        },
      },
    },

    emailAndPassword: {
      enabled: !!import.meta.env.DEV || appConfig.EMAIL_AUTH === "1",
      minPasswordLength: 12,
      // Require verified email before login when an email sender is wired up.
      requireEmailVerification: appConfig.REQUIRE_EMAIL_VERIFICATION === "1",
    },

    // Throttle abuse (credential stuffing, enumeration) with stricter limits on
    // the sensitive auth endpoints.
    rateLimit: {
      enabled: appConfig.NODE_ENV !== "test",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/forget-password": { window: 60, max: 3 },
      },
    },

    advanced: {
      // Cookies must be Secure whenever the app is served over HTTPS.
      useSecureCookies: isHttpsSite(),
      cookiePrefix: "vektor",
    },

    trustedOrigins: trustedOriginsFor(appConfig),

    socialProviders: googleConfig,

    // When Google login is enabled, let a Google sign-in attach to a pre-existing
    // account with the same email (e.g. one created via SSO or email/password)
    // instead of failing with "account_not_linked". Google is a trusted provider
    // because it verifies email ownership; `requireLocalEmailVerified: false`
    // additionally permits linking onto local accounts whose email was never
    // verified (this app allows unverified email/password sign-up). On a shared
    // instance this is a mild account-takeover surface — an attacker who
    // pre-registers an unverified local account under a victim's email could have
    // the victim's later Google login land on it — so keep email/password sign-up
    // restricted (VEKTOR_EMAIL_AUTH) if that matters to you.
    ...(googleConfig
      ? {
          account: {
            accountLinking: {
              enabled: true,
              trustedProviders: ["google" as const],
              requireLocalEmailVerified: false,
              updateUserInfoOnLink: true,
            },
          },
        }
      : {}),

    plugins: [
      genericOAuth({
        config: getOAuthConfig(appConfig),
      }),
    ],
  });
}

const appConfig = config();
const authDb = getAuthDb();

if (!authDb) {
  throw new Error("Failed to get authDb");
}

export const authTrustedOrigins = trustedOriginsFor(appConfig);

export const auth = createAuth(appConfig, authDb);
