/// <reference path="../.astro/types.d.ts" />

// Vue SFCs are only type-checked in isolation by editor tooling (Volar);
// `tsgo` has no Vue plugin, so plain .ts files importing a .vue component
// need this ambient fallback to resolve the module at all.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  >;
  // biome-ignore lint/style/noDefaultExport: Vue SFC module shape requires a default export
  export default component;
}

declare namespace App {
  // Note: 'import {} from ""' syntax does not work in .d.ts files.
  type PublicEnv = {
    VEKTOR_SITE_URL?: string;
    VEKTOR_API_URL?: string;
    VEKTOR_COLLABORATION_HOST?: string;
    VEKTOR_DEFAULT_SPACE?: string;
    AUTH_LOGIN?: string;
    OAUTH_PROVIDER_ID?: string;
    GOOGLE_AUTH_ENABLED?: string;
    VEKTOR_NO_AUTH?: string;
    VEKTOR_EXTENSION_ALLOWED_SOURCES?: string;
  };

  interface Locals {
    user: import("better-auth").User | null;
    session: import("better-auth").Session | null;
    publicEnv: PublicEnv;
  }
}
