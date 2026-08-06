import { readStored, writeStored } from "#utils/clientStorage.ts";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "user-theme-preference";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Plain text rather than JSON: these entries predate this helper, so quoting them
 * now would reset everyone's theme once.
 */
const THEME_CODEC = {
  parse: (raw: string) => (isThemePreference(raw) ? raw : null),
  serialize: (preference: ThemePreference) => preference,
};

export function getStoredThemePreference(): ThemePreference {
  return readStored(THEME_STORAGE_KEY, THEME_CODEC) ?? "system";
}

/** Paired with the getter so callers never touch the key or its format. */
export function storeThemePreference(preference: ThemePreference): void {
  writeStored(THEME_STORAGE_KEY, preference, THEME_CODEC);
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }
  document.documentElement.setAttribute("data-theme", preference);
}
