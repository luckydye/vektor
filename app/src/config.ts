let _publicEnvVars: Record<string, string> | undefined;

const publicEnvVars = () => {
  if (_publicEnvVars) {
    return _publicEnvVars;
  }

  if (typeof globalThis.document !== "undefined") {
    const script = document.getElementById("env") as HTMLScriptElement;
    if (!script) return {};
    try {
      _publicEnvVars = JSON.parse(script.textContent || "");
    } catch (error) {
      console.error("Failed to parse public environment variables:", error);
      return {};
    }
  }

  return _publicEnvVars;
};

export function config() {
  const process = globalThis.process || { env: {} };

  return {
    // Feature flags
    FEATURE_CANVAS:
      process.env.WIKI_FEATURE_CANVAS || publicEnvVars()?.WIKI_FEATURE_CANVAS,

    /**
     * Public origin as in the browser
     */
    SITE_URL: process.env.WIKI_SITE_URL || publicEnvVars()?.WIKI_SITE_URL,
    /**
     * API host origin (usually same as site_url)
     */
    API_URL: process.env.WIKI_API_URL || publicEnvVars()?.WIKI_API_URL,
    /**
     * Host origin for sync server
     */
    COLLABORATION_HOST:
      process.env.WIKI_COLLABORATION_HOST || publicEnvVars()?.WIKI_COLLABORATION_HOST,

    /**
     * The default space to redirect to from root "/"
     */
    DEFAULT_SPACE: process.env.WIKI_DEFAULT_SPACE,

    /**
     * better-auth secret token
     */
    AUTH_SECRET: process.env.AUTH_SECRET,

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

    GITLAB_OAUTH_BASE_URL: process.env.WIKI_GITLAB_OAUTH_BASE_URL,
    GITLAB_OAUTH_CLIENT_ID: process.env.WIKI_GITLAB_OAUTH_CLIENT_ID,
    GITLAB_OAUTH_CLIENT_SECRET: process.env.WIKI_GITLAB_OAUTH_CLIENT_SECRET,
    GITLAB_OAUTH_SCOPES: process.env.WIKI_GITLAB_OAUTH_SCOPES,
    GITLAB_OAUTH_AUTHORIZATION_URL: process.env.WIKI_GITLAB_OAUTH_AUTHORIZATION_URL,
    GITLAB_OAUTH_TOKEN_URL: process.env.WIKI_GITLAB_OAUTH_TOKEN_URL,
    GITLAB_OAUTH_USERINFO_URL: process.env.WIKI_GITLAB_OAUTH_USERINFO_URL,

    YOUTRACK_OAUTH_CLIENT_ID: process.env.WIKI_YOUTRACK_OAUTH_CLIENT_ID,
    YOUTRACK_OAUTH_CLIENT_SECRET: process.env.WIKI_YOUTRACK_OAUTH_CLIENT_SECRET,
    YOUTRACK_OAUTH_SCOPES: process.env.WIKI_YOUTRACK_OAUTH_SCOPES,
    YOUTRACK_OAUTH_BASE_URL: process.env.WIKI_YOUTRACK_OAUTH_BASE_URL,
    YOUTRACK_OAUTH_AUTHORIZATION_URL: process.env.WIKI_YOUTRACK_OAUTH_AUTHORIZATION_URL,
    YOUTRACK_OAUTH_TOKEN_URL: process.env.WIKI_YOUTRACK_OAUTH_TOKEN_URL,
    YOUTRACK_OAUTH_USERINFO_URL: process.env.WIKI_YOUTRACK_OAUTH_USERINFO_URL,

    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
    SEARCH_EMBEDDINGS_PROVIDER: process.env.WIKI_SEARCH_EMBEDDINGS_PROVIDER,
    SEARCH_EMBEDDINGS_MODEL: process.env.WIKI_SEARCH_EMBEDDINGS_MODEL,
    SEARCH_EMBEDDINGS_BASE_URL: process.env.WIKI_SEARCH_EMBEDDINGS_BASE_URL,
    SEARCH_EMBEDDINGS_API_KEY: process.env.WIKI_SEARCH_EMBEDDINGS_API_KEY,
    SECRETS_ENCRYPTION_KEY: process.env.WIKI_SECRETS_ENCRYPTION_KEY,

    // OpenTelemetry
    OTEL_ENABLED: process.env.WIKI_OTEL_ENABLED,
    OTEL_SERVICE_NAME: process.env.WIKI_OTEL_SERVICE_NAME,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.WIKI_OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
      process.env.WIKI_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
      process.env.WIKI_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: process.env.WIKI_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    OTEL_TRACES_SAMPLER:
      process.env.WIKI_OTEL_TRACES_SAMPLER || "parentbased_traceidratio",
    OTEL_TRACES_SAMPLER_ARG: process.env.WIKI_OTEL_TRACES_SAMPLER_ARG || "1",
    OTEL_METRICS_EXPORT_INTERVAL_MS:
      process.env.WIKI_OTEL_METRICS_EXPORT_INTERVAL_MS || "10000",
    OTEL_LOGS_EXPORT_INTERVAL_MS:
      process.env.WIKI_OTEL_LOGS_EXPORT_INTERVAL_MS || "10000",
    OTEL_DIAG_LOG_LEVEL: process.env.WIKI_OTEL_DIAG_LOG_LEVEL || "error",
  } as const;
}

globalThis.config = config;
