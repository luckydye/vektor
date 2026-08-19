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

      NO_AUTH: process.env.VEKTOR_NO_AUTH,
      IN_MEMORY_DB: process.env.VEKTOR_IN_MEMORY_DB,
      /**
       * Auth database connection URL. The URL scheme selects the database mode:
       * file: for local storage, libsql:/https: for hosted libSQL.
       * Remote credentials may be supplied with the authToken query parameter.
       */
      DATABASE_URL: process.env.VEKTOR_DATABASE_URL,
      NODE_ENV: process.env.NODE_ENV,

      /**
       * Set to "1"/"true" when a trusted reverse proxy fronts the app; only
       * then are X-Forwarded-* headers honored.
       */
      TRUST_PROXY: process.env.VEKTOR_TRUST_PROXY,
      /** Hard cap (bytes) for buffered API request bodies. */
      MAX_REQUEST_BYTES: process.env.VEKTOR_MAX_REQUEST_BYTES,

      /** Set to "0"/"false" to turn API rate limiting off entirely. */
      RATE_LIMIT: process.env.VEKTOR_RATE_LIMIT,
      /** Requests per window on routes without a tighter rule. */
      RATE_LIMIT_MAX: process.env.VEKTOR_RATE_LIMIT_MAX,
      /** Rate limit window, in seconds. */
      RATE_LIMIT_WINDOW: process.env.VEKTOR_RATE_LIMIT_WINDOW,
      /**
       * Killswitch: comma-separated rate limit keys to refuse outright, as they
       * appear in the 429 log line (`ip:<addr>`, `token:<hash>`).
       */
      RATE_LIMIT_BLOCK: process.env.VEKTOR_RATE_LIMIT_BLOCK,
      /** Set to "1"/"true" to run a headless API server without the Astro frontend. */
      API_ONLY: process.env.VEKTOR_API_ONLY,
      /** Interface the HTTP server binds to (default 0.0.0.0). */
      SERVER_HOST: process.env.HOST,

      /**
       * Base URL of a Gravatar-compatible avatar API (e.g. https://gravatar.com
       * or a self-hosted Libravatar); `<host>/avatar/<email-hash>` is then used
       * for users whose login provider supplied no picture. Unset means no
       * lookup: it would disclose an email hash to that host, which would also
       * see the IP of everyone viewing the avatar.
       */
      GRAVATAR_URL: process.env.VEKTOR_GRAVATAR_URL,

      EMAIL_AUTH: process.env.VEKTOR_EMAIL_AUTH,
      REQUIRE_EMAIL_VERIFICATION: process.env.VEKTOR_REQUIRE_EMAIL_VERIFICATION,
      EMAIL_FROM: process.env.VEKTOR_EMAIL_FROM,
      SMTP_HOST: process.env.VEKTOR_SMTP_HOST,
      SMTP_PORT: process.env.VEKTOR_SMTP_PORT,
      SMTP_SECURE: process.env.VEKTOR_SMTP_SECURE,
      SMTP_USER: process.env.VEKTOR_SMTP_USER,
      SMTP_PASSWORD: process.env.VEKTOR_SMTP_PASSWORD,

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
      /** Seconds a group claim may age before the next re-read. 0 is off. */
      OAUTH_GROUP_SYNC_INTERVAL: process.env.OAUTH_GROUP_SYNC_INTERVAL,
      /**
       * Comma-separated OAuth group ids whose members may create spaces of
       * their own. Unset leaves creation open to every signed-in user, which is
       * what it has always been. Set but naming no usable group means nobody
       * may create one — a misconfigured allow list has to deny, not open up.
       */
      SPACE_CREATION_GROUPS: process.env.VEKTOR_SPACE_CREATION_GROUPS,

      /**
       * Comma-separated OAuth group ids whose members administer the instance:
       * owner on every space that exists, which is what lets them list and
       * delete spaces they do not belong to. Unset means nobody — the opposite
       * default to the allow list above, since an absent setting must not hand
       * everyone authority over every space.
       */
      ADMIN_GROUPS: process.env.VEKTOR_ADMIN_GROUPS,

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

      SECRETS_ENCRYPTION_KEY: process.env.VEKTOR_SECRETS_ENCRYPTION_KEY,

      /**
       * Which runtime executes extension jobs and workflow scripts. Only "boa"
       * ships today; the setting names the choice so another executor can be
       * plugged in without touching call sites. Isolation is not optional — there
       * is no unsandboxed path.
       */
      JOB_RUNTIME: process.env.VEKTOR_JOB_RUNTIME,
      /**
       * Allow server-side fetches of user-configured URLs — job `fetch`, and an AI
       * provider base URL — to reach loopback and private address ranges. Off by
       * default: that is where the internal API, the database and cloud metadata
       * endpoints live. Enabling it for a self-hosted Ollama also lets a space
       * owner aim the server at any internal host, with viewers reading the reply.
       */
      JOB_FETCH_ALLOW_PRIVATE: process.env.VEKTOR_JOB_FETCH_ALLOW_PRIVATE,

      /**
       * OpenTelemetry log export (OTLP/HTTP, JSON encoding). Logs keep going to
       * stdout/stderr regardless; a collector base URL adds a second sink and
       * `/v1/logs` is appended to it. Standard OTEL_* names so an existing
       * collector deployment configures the app unchanged.
       */
      OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      /** Extra request headers as `k1=v1,k2=v2` (e.g. an ingest token). */
      OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      /** Reported as `service.name`; defaults to "vektor". */
      OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,

      /**
       * Comma-separated list of extension sources the server will accept.
       * Valid values: upload, marketplace, system.
       * Defaults to all sources when unset.
       * Example: VEKTOR_EXTENSION_ALLOWED_SOURCES=marketplace,system
       */
      EXTENSION_ALLOWED_SOURCES: process.env.VEKTOR_EXTENSION_ALLOWED_SOURCES,
    } as const;
  }

  const publicEnv = publicEnvVars();
  return {
    SITE_URL: publicEnv.VEKTOR_SITE_URL,
    API_URL: publicEnv.VEKTOR_API_URL,
    COLLABORATION_HOST: publicEnv.VEKTOR_COLLABORATION_HOST,
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

export function isInMemoryDb(): boolean {
  return config().IN_MEMORY_DB === "1";
}

declare global {
  // Exposed for ad-hoc inspection from the browser/server console.
  // biome-ignore lint: globalThis augmentation requires var
  var config: typeof import("./config.ts").config;
}

globalThis.config = config;
