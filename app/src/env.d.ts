/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  // Note: 'import {} from ""' syntax does not work in .d.ts files.
  type PublicEnv = {
    WIKI_FEATURE_CANVAS?: string;
    WIKI_SITE_URL?: string;
    WIKI_API_URL?: string;
    WIKI_COLLABORATION_HOST?: string;
    WIKI_DEFAULT_SPACE?: string;
    OAUTH_PROVIDER_ID?: string;
    VEKTOR_NO_AUTH?: string;
  };

  interface Locals {
    user: import("better-auth").User | null;
    session: import("better-auth").Session | null;
    publicEnv: PublicEnv;
  }
}

declare module "express";
