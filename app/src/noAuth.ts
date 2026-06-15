import { config } from "./config.ts";

export const LOCAL_USER_ID = "local";

export const LOCAL_USER = {
  id: LOCAL_USER_ID,
  name: "Local User",
  email: "local@localhost",
  emailVerified: true,
  image: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export const LOCAL_SESSION = {
  id: "local-session",
  userId: LOCAL_USER_ID,
  token: "local",
  expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  ipAddress: null,
  userAgent: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export function isNoAuthMode(): boolean {
  return config().NO_AUTH === "1";
}

// No-auth mode makes LOCAL_USER an unauthenticated super-user that bypasses
// every permission check. It must never be enabled in production — fail fast at
// startup rather than silently exposing all data. NODE_ENV alone is not a
// reliable signal (deployments may forget to set it), so also treat any
// non-local public origin as production-like.
if (isNoAuthMode()) {
  if (config().NODE_ENV === "production") {
    throw new Error(
      "VEKTOR_NO_AUTH=1 (no-auth super-user mode) cannot be used with NODE_ENV=production",
    );
  }

  const siteUrl = config().SITE_URL;
  if (siteUrl) {
    let hostname = "";
    try {
      hostname = new URL(siteUrl).hostname;
    } catch {
      // Unparseable SITE_URL: be conservative and treat it as non-local.
    }
    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".localhost");
    if (!isLocalHost) {
      throw new Error(
        `VEKTOR_NO_AUTH=1 (no-auth super-user mode) cannot be used with a non-local VEKTOR_SITE_URL (${siteUrl})`,
      );
    }
  }
}
