import de from "#assets/lang/de.json";
import en from "#assets/lang/en.json";
import es from "#assets/lang/es.json";
import ja from "#assets/lang/ja.json";
import ko from "#assets/lang/ko.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue. API messages may also be
// passed through `t()`; unknown strings fall back to their original value.
export type TranslationKey = keyof typeof en;

// Every language file under assets/lang. Add a new <lang>.json file and
// register it here to make that language available. Static imports (rather
// than Vite's `import.meta.glob`) keep this working under plain runtimes.
const translations: Record<string, Record<string, string>> = { de, en, es, ja, ko };

export function normalizeLang(lang: string): string {
  return lang.split("-")[0] || FALLBACK_LANG;
}

/** The browser locale for non-Solid client code such as custom elements. */
export function browserLang(): string {
  const documentLang =
    typeof document !== "undefined" ? document.documentElement.lang : "";
  const navigatorLang = typeof navigator !== "undefined" ? navigator.language : "";
  return normalizeLang(documentLang || navigatorLang || FALLBACK_LANG);
}

/** Translate a catalogue key using an explicitly supplied locale. */
export function t(key: TranslationKey | string, lang: string): string {
  const code = normalizeLang(lang);
  return translations[code]?.[key] ?? translations[FALLBACK_LANG]?.[key] ?? key;
}

/** Close the canonical translator over a locale at an application boundary. */
export function createTranslator(lang: string) {
  return (key: TranslationKey | string) => t(key, lang);
}
