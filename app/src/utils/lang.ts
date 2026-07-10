import de from "#assets/lang/de.json";
import en from "#assets/lang/en.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue: its keys define every string
// that can be translated, so `t()` only accepts keys that actually exist.
export type TranslationKey = keyof typeof en;

// Every language file under assets/lang. Add a new <lang>.json file and
// register it here to make that language available. Static imports (rather
// than Vite's `import.meta.glob`) keep this working under plain runtimes such
// as `bun test`, where `import.meta.glob` is undefined.
const translations: Record<string, Record<string, string>> = { de, en };

function normalizeLang(lang: string): string {
  return lang.split("-")[0] || FALLBACK_LANG;
}

function currentLang(): string {
  if (typeof navigator !== "undefined" && navigator.language) {
    return normalizeLang(navigator.language);
  }
  return FALLBACK_LANG;
}

// `lang` lets server-rendered callers (Astro pages, where `navigator` is
// undefined) pass the resolved locale explicitly, e.g. `Astro.preferredLocale`.
// On the client it is omitted and the browser language is used.
export function t(key: TranslationKey, lang?: string): string {
  const code = lang ? normalizeLang(lang) : currentLang();
  return translations[code]?.[key] ?? translations[FALLBACK_LANG]?.[key] ?? key;
}
