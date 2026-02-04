let _publicEnvVars: Record<string, string> | undefined;

const publicEnvVars = () => {
  if(_publicEnvVars) {
    return _publicEnvVars;
  }
  
  const script = document.getElementById('env') as HTMLScriptElement;
  if (!script) return {};
  try {
    _publicEnvVars = JSON.parse(script.textContent || '');
  } catch (error) {
    console.error('Failed to parse public environment variables:', error);
    return {};
  }
  
  return _publicEnvVars;
}

export function config() {  
  const process = globalThis.process || { env: {} };
  
  return {
    // Feature flags
    FEATURE_CANVAS: process.env.WIKI_FEATURE_CANVAS || publicEnvVars()?.WIKI_FEATURE_CANVAS,
        
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
    COLLABORATION_HOST: process.env.WIKI_COLLABORATION_HOST || publicEnvVars()?.WIKI_COLLABORATION_HOST,

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
  } as const;
}

globalThis.config = config;
