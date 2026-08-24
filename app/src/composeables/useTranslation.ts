import { createContext, useContext } from "solid-js";
import { t, type TranslationKey } from "#utils/lang.ts";

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
