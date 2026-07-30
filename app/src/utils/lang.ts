import { hasInjectionContext, type InjectionKey, inject } from "vue";
import de from "#assets/lang/de.json";
import en from "#assets/lang/en.json";
import ko from "#assets/lang/ko.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue. API messages may also be
// passed through `t()`; unknown strings fall back to their original value.
export type TranslationKey = keyof typeof en;

// Every language file under assets/lang. Add a new <lang>.json file and
// register it here to make that language available. Static imports (rather
// than Vite's `import.meta.glob`) keep this working under plain runtimes such
// as `bun test`, where `import.meta.glob` is undefined.
const translations: Record<string, Record<string, string>> = { de, en, ko };
export const languageInjectionKey: InjectionKey<string> = Symbol("language");

function normalizeLang(lang: string): string {
  return lang.split("-")[0] || FALLBACK_LANG;
}

/**
 * The locale provided by the Vue app root (`SpaceApp.vue`), when we are inside a
 * component's injection context. Outside one — plain modules, custom elements,
 * tests — there is nothing to inject and `currentLang` falls back to the
 * environment locale.
 *
 * This module therefore imports the Vue runtime, so it must stay off the
 * server's document/serialization path; `test/server-frontend-imports.spec.ts`
 * enforces that. Locale-free timestamp parsing lives in `utils.ts`, and the
 * localized formatters that need `currentLang()` live in `datetime.ts`.
 */
function injectedLocale(): string | undefined {
  return hasInjectionContext() ? inject(languageInjectionKey, undefined) : undefined;
}

export function currentLang(): string {
  const injectedLang = injectedLocale();
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
