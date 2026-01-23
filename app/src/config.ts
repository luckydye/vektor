export function config() {
  return {
    /**
     * Public origin as in the browser
     */
    SITE_URL: import.meta.env.WIKI_SITE_URL,
    /**
     * API host origin (usually same as site_url)
     */
    API_URL: import.meta.env.WIKI_API_URL,
    /**
     * Host origin for sync server
     */
    COLLABORATION_HOST: import.meta.env.WIKI_COLLABORATION_HOST,

    /**
     * The default space to redirect to from root "/"
     */
    DEFAULT_SPACE: import.meta.env.WIKI_DEFAULT_SPACE,

    /**
     * better-auth secret token
     */
    AUTH_SECRET: import.meta.env.AUTH_SECRET,

    /**
     * OAuth configuration
     */
    OAUTH_PROVIDER_ID: import.meta.env.OAUTH_PROVIDER_ID,
    OAUTH_CLIENT_ID: import.meta.env.OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET: import.meta.env.OAUTH_CLIENT_SECRET,
    OAUTH_SCOPES: import.meta.env.OAUTH_SCOPES,
    OAUTH_AUTHORIZATION_URL: import.meta.env.OAUTH_AUTHORIZATION_URL,
    OAUTH_TOKEN_URL: import.meta.env.OAUTH_TOKEN_URL,
    OAUTH_USERINFO_URL: import.meta.env.OAUTH_USERINFO_URL,
    OAUTH_REDIRECT_URI: import.meta.env.OAUTH_REDIRECT_URI,

    // Feature flags
    FEATURE_CANVAS: import.meta.env.WIKI_FEATURE_CANVAS,
  } as const;
}

globalThis.config = config;
