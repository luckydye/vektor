import { hasInjectionContext, inject } from "vue";
import { languageInjectionKey, setLocaleResolver } from "#utils/lang.ts";

/**
 * Wires `currentLang()` to the locale provided by the Vue app root.
 *
 * Imported for its side effect by `SpaceApp.vue` — the component that provides
 * `languageInjectionKey` — so every component that could resolve the injection
 * has this registered. `lang.ts` itself stays framework-free because server
 * code reaches it while serializing documents; see `setLocaleResolver`.
 */
setLocaleResolver(() =>
  hasInjectionContext() ? inject(languageInjectionKey, undefined) : undefined,
);
