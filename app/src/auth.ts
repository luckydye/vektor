import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { getAuthDb } from "./db/db.ts";
import * as schema from "./db/schema/auth.ts";
import { config } from "./config.ts";

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
    enabled: !!import.meta.env.DEV,
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
            const groups = profile.wiki_groups || [];
            const groupsString = Array.isArray(groups)
              ? JSON.stringify(groups)
              : JSON.stringify([]);

            return {
              id: profile.id,
              email: profile.email,
              name: profile.name,
              image: profile.image,
              emailVerified: profile.emailVerified || false,
              groups: groupsString,
            };
          },
        },
      ],
    }),
  ],
});
