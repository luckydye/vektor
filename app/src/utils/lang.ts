import type { InjectionKey } from "vue";
import de from "#assets/lang/de.json";
import en from "#assets/lang/en.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue. API messages may also be
// passed through `t()`; unknown strings fall back to their original value.
export type TranslationKey = keyof typeof en;

// Every language file under assets/lang. Add a new <lang>.json file and
// register it here to make that language available. Static imports (rather
// than Vite's `import.meta.glob`) keep this working under plain runtimes such
// as `bun test`, where `import.meta.glob` is undefined.
const translations: Record<string, Record<string, string>> = { de, en };
export const languageInjectionKey: InjectionKey<string> = Symbol("language");

function normalizeLang(lang: string): string {
  return lang.split("-")[0] || FALLBACK_LANG;
}

let localeResolver: (() => string | undefined) | null = null;

/**
 * Registers the Vue-injected locale lookup. Called for its side effect by
 * `#utils/langVue.ts`, which the app root imports.
 *
 * This module is reached from server code (document serialization pulls in
 * `utils.ts`, which formats relative times), and importing Vue here dragged the
 * whole Vue runtime and compiler into the server process and into every
 * serialization worker. Keeping the injection lookup behind this seam lets the
 * server translate strings without a UI framework; with no resolver registered
 * `currentLang` simply falls through to the environment locale.
 */
export function setLocaleResolver(resolver: (() => string | undefined) | null): void {
  localeResolver = resolver;
}

export function currentLang(): string {
  const injectedLang = localeResolver?.();
  if (injectedLang) {
    return normalizeLang(injectedLang);
  }

  if (typeof navigator !== "undefined" && navigator.language) {
    return normalizeLang(navigator.language);
  }
  return FALLBACK_LANG;
}

// `lang` lets server-rendered callers (where `navigator` is undefined) pass
// their resolved locale explicitly. On the client it is otherwise omitted and
// the browser language is used.
export function t(key: TranslationKey | string, lang?: string): string {
  const code = lang ? normalizeLang(lang) : currentLang();
  return translations[code]?.[key] ?? translations[FALLBACK_LANG]?.[key] ?? key;
}
