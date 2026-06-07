import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { config } from "./config.ts";
import { GROUP_NAME_PATTERN } from "./db/acl.ts";
import { getAuthDb } from "./db/db.ts";
import * as schema from "./db/schema/auth.ts";

const appConfig = config();
const authDb = getAuthDb();

export const authTrustedOrigins = [
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "http://127.0.0.1:4321",
  "http://localhost:4321",
  ...(appConfig.SITE_URL ? [appConfig.SITE_URL] : []),
];

if (!authDb) {
  throw new Error("Failed to get authDb");
}

// Cookies must be Secure whenever the app is served over HTTPS.
const useSecureCookies = (appConfig.SITE_URL ?? "").startsWith("https://");

// Optional allowlist of group claims the IdP is permitted to assign. When set
// (comma-separated), any group outside the list is dropped.
const OAUTH_ALLOWED_GROUPS = (appConfig.OAUTH_ALLOWED_GROUPS ?? "")
  .split(",")
  .map((g) => g.trim())
  .filter(Boolean);

/**
 * Sanitize the `wiki_groups` claim from an OAuth IdP before it is persisted and
 * used for authorization. Group membership drives ACL access, so a compromised
 * or loosely-configured IdP must not be able to inject arbitrary/privileged
 * group names. We keep only well-formed string entries, cap the count, and
 * (when configured) intersect with an explicit allowlist.
 */
function sanitizeOAuthGroups(raw: unknown): string {
  if (!Array.isArray(raw)) return "[]";
  let groups = raw
    .filter((g): g is string => typeof g === "string" && GROUP_NAME_PATTERN.test(g))
    .slice(0, 100);
  if (OAUTH_ALLOWED_GROUPS.length > 0) {
    groups = groups.filter((g) => OAUTH_ALLOWED_GROUPS.includes(g));
  }
  return JSON.stringify([...new Set(groups)]);
}

export const auth = betterAuth({
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
        defaultValue: "[]",
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
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/forget-password": { window: 60, max: 3 },
    },
  },

  advanced: {
    useSecureCookies,
    cookiePrefix: "vektor",
  },

  trustedOrigins: authTrustedOrigins,

  plugins: [
    genericOAuth({
      config: [
        {
          redirectURI: appConfig.OAUTH_REDIRECT_URI,
          providerId: appConfig.OAUTH_PROVIDER_ID,
          clientId: appConfig.OAUTH_CLIENT_ID,
          clientSecret: appConfig.OAUTH_CLIENT_SECRET,
          scopes: appConfig.OAUTH_SCOPES?.split(","),
          authorizationUrl: appConfig.OAUTH_AUTHORIZATION_URL,
          tokenUrl: appConfig.OAUTH_TOKEN_URL,
          userInfoUrl: appConfig.OAUTH_USERINFO_URL,
          mapProfileToUser: async (profile) => {
            return {
              id: profile.id,
              email: profile.email,
              name: profile.name,
              image: profile.image,
              emailVerified: profile.emailVerified || false,
              groups: sanitizeOAuthGroups(profile.wiki_groups),
            };
          },
        },
      ],
    }),
  ],
});
