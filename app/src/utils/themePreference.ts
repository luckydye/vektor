export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "user-theme-preference";

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function getStoredThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const storedPreference = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(storedPreference) ? storedPreference : "system";
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }
  document.documentElement.setAttribute("data-theme", preference);
}
