let _publicEnvVars: Record<string, string> | undefined;

const publicEnvVars = (): Record<string, string> => {
  if (_publicEnvVars) {
    return _publicEnvVars;
  }

  if (typeof document === "undefined") {
    return {};
  }

  const script = document.getElementById("env") as HTMLScriptElement | null;
  if (!script) throw new Error('Missing runtime env script element "env"');

  try {
    _publicEnvVars = JSON.parse(script.textContent || "");
  } catch (error) {
    throw new Error(`Failed to parse public environment variables: ${error}`);
  }

  return _publicEnvVars!;
};

export function config() {
  if (typeof document === "undefined") {
    const process = globalThis.process;
    return {
      /**
       * Public origin as in the browser
       */
      SITE_URL: process.env.VEKTOR_SITE_URL,
      /**
       * API host origin (usually same as site_url)
       */
      API_URL: process.env.VEKTOR_API_URL,
      /**
       * Host origin for sync server
       */
      COLLABORATION_HOST: process.env.VEKTOR_COLLABORATION_HOST,

      /**
       * The default space to redirect to from root "/"
       */
      DEFAULT_SPACE: process.env.VEKTOR_DEFAULT_SPACE,
      NO_AUTH: process.env.VEKTOR_NO_AUTH,
      IN_MEMORY_DB: process.env.VEKTOR_IN_MEMORY_DB,
      NODE_ENV: process.env.NODE_ENV,

      /**
       * Set to "1"/"true" when a trusted reverse proxy fronts the app; only
       * then are X-Forwarded-* headers honored.
       */
      TRUST_PROXY: process.env.VEKTOR_TRUST_PROXY,
      /** Hard cap (bytes) for buffered API request bodies. */
      MAX_REQUEST_BYTES: process.env.VEKTOR_MAX_REQUEST_BYTES,
      /** Set to "1"/"true" to run a headless API server without the Astro frontend. */
      API_ONLY: process.env.VEKTOR_API_ONLY,
      /** Interface the HTTP server binds to (default 0.0.0.0). */
      SERVER_HOST: process.env.HOST,

      EMAIL_AUTH: process.env.VEKTOR_EMAIL_AUTH,
      REQUIRE_EMAIL_VERIFICATION: process.env.VEKTOR_REQUIRE_EMAIL_VERIFICATION,
      /** Comma-separated allowlist of OAuth group claims the IdP may assign. */
      OAUTH_ALLOWED_GROUPS: process.env.OAUTH_ALLOWED_GROUPS,

      /** CLI connection settings (vektor document/workflow commands). */
      CLI_HOST: process.env.VEKTOR_HOST,
      CLI_SPACE_ID: process.env.VEKTOR_SPACE_ID,
      CLI_ACCESS_TOKEN: process.env.VEKTOR_ACCESS_TOKEN,

      /**
       * better-auth secret token
       */
      AUTH_SECRET: process.env.AUTH_SECRET,
      AUTH_LOGIN: process.env.AUTH_LOGIN,

      /**
       * OAuth configuration
       */
      OAUTH_PROVIDER_ID: process.env.OAUTH_PROVIDER_ID,
      OAUTH_CLIENT_ID: process.env.OAUTH_CLIENT_ID,
      OAUTH_CLIENT_SECRET: process.env.OAUTH_CLIENT_SECRET,
      OAUTH_SCOPES: process.env.OAUTH_SCOPES,
      OAUTH_AUTHORIZATION_URL: process.env.OAUTH_AUTHORIZATION_URL,
      OAUTH_TOKEN_URL: process.env.OAUTH_TOKEN_URL,
      OAUTH_USERINFO_URL: process.env.OAUTH_USERINFO_URL,
      OAUTH_REDIRECT_URI: process.env.OAUTH_REDIRECT_URI,

      /**
       * Google social login. When both id and secret are set, a "Continue with
       * Google" option is shown on the login screen. The redirect URI defaults
       * to `${SITE_URL}/api/auth/callback/google` unless overridden.
       */
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,

      GITLAB_OAUTH_BASE_URL: process.env.VEKTOR_GITLAB_OAUTH_BASE_URL,
      GITLAB_OAUTH_CLIENT_ID: process.env.VEKTOR_GITLAB_OAUTH_CLIENT_ID,
      GITLAB_OAUTH_CLIENT_SECRET: process.env.VEKTOR_GITLAB_OAUTH_CLIENT_SECRET,
      GITLAB_OAUTH_SCOPES: process.env.VEKTOR_GITLAB_OAUTH_SCOPES,
      GITLAB_OAUTH_AUTHORIZATION_URL: process.env.VEKTOR_GITLAB_OAUTH_AUTHORIZATION_URL,
      GITLAB_OAUTH_TOKEN_URL: process.env.VEKTOR_GITLAB_OAUTH_TOKEN_URL,
      GITLAB_OAUTH_USERINFO_URL: process.env.VEKTOR_GITLAB_OAUTH_USERINFO_URL,

      YOUTRACK_OAUTH_CLIENT_ID: process.env.VEKTOR_YOUTRACK_OAUTH_CLIENT_ID,
      YOUTRACK_OAUTH_CLIENT_SECRET: process.env.VEKTOR_YOUTRACK_OAUTH_CLIENT_SECRET,
      YOUTRACK_OAUTH_SCOPES: process.env.VEKTOR_YOUTRACK_OAUTH_SCOPES,
      YOUTRACK_OAUTH_BASE_URL: process.env.VEKTOR_YOUTRACK_OAUTH_BASE_URL,
      YOUTRACK_OAUTH_AUTHORIZATION_URL:
        process.env.VEKTOR_YOUTRACK_OAUTH_AUTHORIZATION_URL,
      YOUTRACK_OAUTH_TOKEN_URL: process.env.VEKTOR_YOUTRACK_OAUTH_TOKEN_URL,
      YOUTRACK_OAUTH_USERINFO_URL: process.env.VEKTOR_YOUTRACK_OAUTH_USERINFO_URL,

      SEARCH_EMBEDDINGS_PROVIDER: process.env.VEKTOR_SEARCH_EMBEDDINGS_PROVIDER,
      SEARCH_EMBEDDINGS_MODEL: process.env.VEKTOR_SEARCH_EMBEDDINGS_MODEL,
      SEARCH_EMBEDDINGS_BASE_URL: process.env.VEKTOR_SEARCH_EMBEDDINGS_BASE_URL,
      SEARCH_EMBEDDINGS_API_KEY: process.env.VEKTOR_SEARCH_EMBEDDINGS_API_KEY,
      SECRETS_ENCRYPTION_KEY: process.env.VEKTOR_SECRETS_ENCRYPTION_KEY,
      JOB_SANDBOX: process.env.VEKTOR_JOB_SANDBOX,
      // Escape hatch to run extension jobs in-process (NO isolation). Jobs can
      // read host files, env vars/secrets, and reach internal services, so this
      // must only ever be enabled for trusted local development.
      JOB_ALLOW_UNSANDBOXED: process.env.VEKTOR_JOB_ALLOW_UNSANDBOXED,

      /**
       * Comma-separated list of extension sources the server will accept.
       * Valid values: upload, marketplace, system.
       * Defaults to all sources when unset.
       * Example: VEKTOR_EXTENSION_ALLOWED_SOURCES=marketplace,system
       */
      EXTENSION_ALLOWED_SOURCES: process.env.VEKTOR_EXTENSION_ALLOWED_SOURCES,

      // OpenTelemetry
      OTEL_ENABLED: process.env.VEKTOR_OTEL_ENABLED,
      OTEL_SERVICE_NAME: process.env.VEKTOR_OTEL_SERVICE_NAME,
      OTEL_EXPORTER_OTLP_ENDPOINT: process.env.VEKTOR_OTEL_EXPORTER_OTLP_ENDPOINT,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        process.env.VEKTOR_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        process.env.VEKTOR_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
        process.env.VEKTOR_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      OTEL_TRACES_SAMPLER:
        process.env.VEKTOR_OTEL_TRACES_SAMPLER || "parentbased_traceidratio",
      OTEL_TRACES_SAMPLER_ARG: process.env.VEKTOR_OTEL_TRACES_SAMPLER_ARG || "1",
      OTEL_METRICS_EXPORT_INTERVAL_MS:
        process.env.VEKTOR_OTEL_METRICS_EXPORT_INTERVAL_MS || "10000",
      OTEL_LOGS_EXPORT_INTERVAL_MS:
        process.env.VEKTOR_OTEL_LOGS_EXPORT_INTERVAL_MS || "10000",
      OTEL_DIAG_LOG_LEVEL: process.env.VEKTOR_OTEL_DIAG_LOG_LEVEL || "error",
    } as const;
  }

  const publicEnv = publicEnvVars();
  return {
    SITE_URL: publicEnv.VEKTOR_SITE_URL,
    API_URL: publicEnv.VEKTOR_API_URL,
    COLLABORATION_HOST: publicEnv.VEKTOR_COLLABORATION_HOST,
    DEFAULT_SPACE: publicEnv.VEKTOR_DEFAULT_SPACE,
    NO_AUTH: publicEnv.VEKTOR_NO_AUTH,
    AUTH_LOGIN: publicEnv.AUTH_LOGIN,
    OAUTH_PROVIDER_ID: publicEnv.OAUTH_PROVIDER_ID,
    GOOGLE_AUTH_ENABLED: publicEnv.GOOGLE_AUTH_ENABLED,
    EXTENSION_ALLOWED_SOURCES: publicEnv.VEKTOR_EXTENSION_ALLOWED_SOURCES,
  } as const;
}

/**
 * True when the operator confirmed a trusted reverse proxy fronts the app
 * (VEKTOR_TRUST_PROXY=1/true); only then may X-Forwarded-* headers be honored.
 */
export function isTrustProxyEnabled(): boolean {
  const raw = config().TRUST_PROXY;
  return raw === "1" || raw === "true";
}

/**
 * Runtime environment exposed to the browser. Single source of truth for the
 * Astro middleware and the Hono API adapter — only ever add non-secret
 * values here.
 */
export function getPublicEnv(): App.PublicEnv {
  const appConfig = config();
  return {
    VEKTOR_SITE_URL: appConfig.SITE_URL,
    VEKTOR_API_URL: appConfig.API_URL,
    VEKTOR_COLLABORATION_HOST: appConfig.COLLABORATION_HOST,
    VEKTOR_DEFAULT_SPACE: appConfig.DEFAULT_SPACE,
    AUTH_LOGIN: appConfig.AUTH_LOGIN,
    OAUTH_PROVIDER_ID: appConfig.OAUTH_PROVIDER_ID,
    // Never expose the client secret; only a boolean flag reaches the browser.
    GOOGLE_AUTH_ENABLED:
      appConfig.GOOGLE_CLIENT_ID?.trim() && appConfig.GOOGLE_CLIENT_SECRET?.trim()
        ? "1"
        : undefined,
    VEKTOR_NO_AUTH: appConfig.NO_AUTH,
    VEKTOR_EXTENSION_ALLOWED_SOURCES: appConfig.EXTENSION_ALLOWED_SOURCES,
  };
}

export function getLocalOrigin(): string {
  const argv = globalThis.process?.argv ?? [];
  const portIdx = argv.indexOf("--port");
  const portArg =
    portIdx >= 0
      ? argv[portIdx + 1]
      : argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
  const port = portArg ?? "8080";
  return `http://127.0.0.1:${port}`;
}

declare global {
  // Exposed for ad-hoc inspection from the browser/server console.
  // biome-ignore lint: globalThis augmentation requires var
  var config: typeof import("./config.ts").config;
}

globalThis.config = config;
