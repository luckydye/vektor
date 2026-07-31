import de from "#assets/lang/de.json";
import en from "#assets/lang/en.json";
import ko from "#assets/lang/ko.json";

const FALLBACK_LANG = "en";

// The English file is the canonical catalogue. API messages may also be
// passed through `t()`; unknown strings fall back to their original value.
export type TranslationKey = keyof typeof en;

// Every language file under assets/lang. Add a new <lang>.json file and
// register it here to make that language available. Static imports (rather
// than Vite's `import.meta.glob`) keep this working under plain runtimes.
const translations: Record<string, Record<string, string>> = { de, en, ko };

function normalizeLang(lang: string): string {
  return lang.split("-")[0] || FALLBACK_LANG;
}

/**
 * How the ambient locale is found, installed by whoever owns request scope.
 *
 * A plain module-level variable was tried and **measured wrong**: with sixty
 * concurrent renders in mixed locales, 26 came out in the wrong language,
 * because one request's locale lands in the middle of another's render. The
 * locale has to be request-scoped, and this module cannot import the machinery
 * that scopes it — `test/server-frontend-imports.spec.ts` polices this path.
 *
 * So the scoping mechanism is injected rather than assumed:
 *
 * - the server installs an `AsyncLocalStorage`-backed resolver
 *   (`langScope.server.ts`), which is request-scoped and framework-free;
 * - the browser installs a plain one (`setClientLang`), where a module-level
 *   value is correct — one document, one reader, one locale.
 *
 * With no resolver installed, `currentLang()` falls back to the environment,
 * which is what plain modules, custom elements and tests get today.
 */
let resolveAmbientLang: (() => string | undefined) | null = null;

export function setLangResolver(resolve: (() => string | undefined) | null): void {
  resolveAmbientLang = resolve;
}

let clientLang: string | undefined;

/**
 * Sets the locale for this document. Browser only — calling it on the server
 * would reintroduce exactly the cross-request bleed described above, so the
 * server path goes through `langScope.server.ts` instead.
 */
export function setClientLang(lang: string | undefined): void {
  clientLang = lang;
}

export function currentLang(): string {
  const ambient = resolveAmbientLang?.() ?? clientLang;
  if (ambient) return normalizeLang(ambient);

  if (typeof navigator !== "undefined" && navigator.language) {
    return normalizeLang(navigator.language);
  }
  return FALLBACK_LANG;
}

// `lang` lets callers pass a resolved locale explicitly, for the cases that
// know better than the ambient one (a notification rendered for another user,
// say). Otherwise the ambient locale is used.
export function t(key: TranslationKey | string, lang?: string): string {
  const code = lang ? normalizeLang(lang) : currentLang();
  return translations[code]?.[key] ?? translations[FALLBACK_LANG]?.[key] ?? key;
}
