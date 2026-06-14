import type en from "../assets/lang/en.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue: its keys define every string
// that can be translated, so `t()` only accepts keys that actually exist.
export type TranslationKey = keyof typeof en;

// Eagerly bundle every language file under assets/lang. Adding a new
// <lang>.json file is enough to make that language available here.
const modules = import.meta.glob<Record<string, string>>("../assets/lang/*.json", {
  eager: true,
  import: "default",
});

const translations: Record<string, Record<string, string>> = {};
for (const path in modules) {
  const lang = path.match(/([^/]+)\.json$/)?.[1];
  if (lang) {
    translations[lang] = modules[path];
  }
}

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
