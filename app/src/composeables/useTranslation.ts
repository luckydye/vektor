import { createContext, useContext } from "solid-js";
import { browserLang, type TranslationKey, t } from "#utils/lang.ts";

export const LocaleContext = createContext<string>();

export function useLocale(): string {
  const lang = useContext(LocaleContext);
  if (!lang) throw new Error("LocaleContext is missing");
  return lang;
}

/** Solid convenience over the canonical `t(key, lang)` API. */
export function useTranslation() {
  const lang = useLocale();
  return (key: TranslationKey | string) => t(key, lang);
}

/**
 * Translator that also works with no reactive owner active — DOM event
 * handlers, editor plugins — where context lookup finds nothing and
 * `useTranslation` would throw.
 */
export function useOptionalTranslation() {
  const lang = useContext(LocaleContext) ?? browserLang();
  return (key: TranslationKey | string) => t(key, lang);
}
