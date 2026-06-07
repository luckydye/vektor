let _publicEnvVars: Record<string, string> | undefined;

export const DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.5-397b-a17b";
export const DEFAULT_OLLAMA_MODEL = "qwen3:latest";

const publicEnvVars = () => {
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

  return _publicEnvVars;
};

export function config() {
  if (typeof document === "undefined") {
    const process = globalThis.process;
    return {
      // Feature flags
      FEATURE_CANVAS: process.env.WIKI_FEATURE_CANVAS,

      /**
       * Public origin as in the browser
       */
      SITE_URL: process.env.WIKI_SITE_URL,
      /**
       * API host origin (usually same as site_url)
       */
      API_URL: process.env.WIKI_API_URL,
      /**
       * Host origin for sync server
       */
      COLLABORATION_HOST: process.env.WIKI_COLLABORATION_HOST,

      /**
       * The default space to redirect to from root "/"
       */
      DEFAULT_SPACE: process.env.WIKI_DEFAULT_SPACE,
      NO_AUTH: process.env.VEKTOR_NO_AUTH,
      NODE_ENV: process.env.NODE_ENV,

      /**
       * Set to "1"/"true" when a trusted reverse proxy fronts the app; only
       * then are X-Forwarded-* headers honored.
       */
      TRUST_PROXY: process.env.WIKI_TRUST_PROXY,
      /** Hard cap (bytes) for buffered API request bodies. */
      MAX_REQUEST_BYTES: process.env.WIKI_MAX_REQUEST_BYTES,
      /** Set to "1"/"true" to run a headless API server without the Astro frontend. */
      API_ONLY: process.env.VEKTOR_API_ONLY,
      /** Interface the HTTP server binds to (default 0.0.0.0). */
      SERVER_HOST: process.env.HOST,

      EMAIL_AUTH: process.env.VEKTOR_EMAIL_AUTH,
      REQUIRE_EMAIL_VERIFICATION: process.env.VEKTOR_REQUIRE_EMAIL_VERIFICATION,
      /** Comma-separated allowlist of OAuth group claims the IdP may assign. */
      OAUTH_ALLOWED_GROUPS: process.env.OAUTH_ALLOWED_GROUPS,

      WORKFLOW_RUN_STORE_FILE: process.env.VEKTOR_WORKFLOW_RUN_STORE_FILE,

      /** CLI connection settings (vektor document/workflow commands). */
      CLI_HOST: process.env.WIKI_HOST,
      CLI_SPACE_ID: process.env.WIKI_SPACE_ID,
      CLI_ACCESS_TOKEN: process.env.WIKI_ACCESS_TOKEN,

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
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
      OLLAMA_MODEL: process.env.OLLAMA_MODEL,
      SEARCH_EMBEDDINGS_PROVIDER: process.env.WIKI_SEARCH_EMBEDDINGS_PROVIDER,
      SEARCH_EMBEDDINGS_MODEL: process.env.WIKI_SEARCH_EMBEDDINGS_MODEL,
      SEARCH_EMBEDDINGS_BASE_URL: process.env.WIKI_SEARCH_EMBEDDINGS_BASE_URL,
      SEARCH_EMBEDDINGS_API_KEY: process.env.WIKI_SEARCH_EMBEDDINGS_API_KEY,
      SECRETS_ENCRYPTION_KEY: process.env.WIKI_SECRETS_ENCRYPTION_KEY,
      JOB_SANDBOX: process.env.WIKI_JOB_SANDBOX,
      // Escape hatch to run extension jobs in-process (NO isolation). Jobs can
      // read host files, env vars/secrets, and reach internal services, so this
      // must only ever be enabled for trusted local development.
      JOB_ALLOW_UNSANDBOXED: process.env.WIKI_JOB_ALLOW_UNSANDBOXED,

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

  const publicEnv = publicEnvVars();
  return {
    FEATURE_CANVAS: publicEnv.WIKI_FEATURE_CANVAS,
    SITE_URL: publicEnv.WIKI_SITE_URL,
    API_URL: publicEnv.WIKI_API_URL,
    COLLABORATION_HOST: publicEnv.WIKI_COLLABORATION_HOST,
    DEFAULT_SPACE: publicEnv.WIKI_DEFAULT_SPACE,
    NO_AUTH: publicEnv.VEKTOR_NO_AUTH,
    AUTH_LOGIN: publicEnv.AUTH_LOGIN,
    OAUTH_PROVIDER_ID: publicEnv.OAUTH_PROVIDER_ID,
  } as const;
}

export function getConfiguredOpenRouterModel(): string {
  return config().OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function getConfiguredAnthropicModel(): string {
  return config().ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
}

export function getConfiguredOllamaBaseUrl(): string {
  const baseUrl = config().OLLAMA_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("OLLAMA_BASE_URL is required when using Ollama.");
  }
  return baseUrl.replace(/\/$/, "");
}

export function getConfiguredOllamaModel(): string {
  return config().OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
}

/** LLM provider settings passed to job workers via workerData. */
export function getLlmWorkerConfig() {
  return {
    openrouterApiKey: config().OPENROUTER_API_KEY,
    openrouterModel: getConfiguredOpenRouterModel(),
    anthropicApiKey: config().ANTHROPIC_API_KEY,
    anthropicModel: getConfiguredAnthropicModel(),
    ollamaBaseUrl: config().OLLAMA_BASE_URL ? getConfiguredOllamaBaseUrl() : null,
    ollamaModel: config().OLLAMA_BASE_URL ? getConfiguredOllamaModel() : null,
  };
}

/**
 * True when the operator confirmed a trusted reverse proxy fronts the app
 * (WIKI_TRUST_PROXY=1/true); only then may X-Forwarded-* headers be honored.
 */
export function isTrustProxyEnabled(): boolean {
  const raw = config().TRUST_PROXY;
  return raw === "1" || raw === "true";
}

/**
 * Runtime environment exposed to the browser. Single source of truth for the
 * Astro middleware and the Express API adapter — only ever add non-secret
 * values here.
 */
export function getPublicEnv(): App.PublicEnv {
  const appConfig = config();
  return {
    WIKI_FEATURE_CANVAS: appConfig.FEATURE_CANVAS,
    WIKI_SITE_URL: appConfig.SITE_URL,
    WIKI_API_URL: appConfig.API_URL,
    WIKI_COLLABORATION_HOST: appConfig.COLLABORATION_HOST,
    WIKI_DEFAULT_SPACE: appConfig.DEFAULT_SPACE,
    AUTH_LOGIN: appConfig.AUTH_LOGIN,
    OAUTH_PROVIDER_ID: appConfig.OAUTH_PROVIDER_ID,
    VEKTOR_NO_AUTH: appConfig.NO_AUTH,
  };
}

export function getLocalOrigin(): string {
  const argv = globalThis.process?.argv ?? [];
  const portIdx = argv.findIndex((arg) => arg === "--port");
  const portArg =
    portIdx >= 0
      ? argv[portIdx + 1]
      : argv.find((arg) => arg.startsWith("--port="))?.slice("--port=".length);
  const port = portArg ?? "8080";
  return `http://127.0.0.1:${port}`;
}

globalThis.config = config;
