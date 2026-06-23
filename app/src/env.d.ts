/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  // Note: 'import {} from ""' syntax does not work in .d.ts files.
  type PublicEnv = {
    VEKTOR_SITE_URL?: string;
    VEKTOR_API_URL?: string;
    VEKTOR_COLLABORATION_HOST?: string;
    VEKTOR_DEFAULT_SPACE?: string;
    AUTH_LOGIN?: string;
    OAUTH_PROVIDER_ID?: string;
    VEKTOR_NO_AUTH?: string;
  };

  interface Locals {
    user: import("better-auth").User | null;
    session: import("better-auth").Session | null;
    publicEnv: PublicEnv;
  }
}
