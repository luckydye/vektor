/**
 * Reading the canvas's themed colours out of CSS, and the dark-mode question.
 *
 * The canvas paints to a `<canvas>` element, so it cannot inherit colours the
 * way DOM does — it has to resolve the custom properties itself and repaint
 * when the theme changes. Extracted from `Canvas.vue` (plan section 6); the
 * element the variables are resolved against is a parameter rather than a ref.
 */

interface CanvasThemeColors {
  gridMajor: string;
  gridMinor: string;
  ink: string;
  chromeText: string;
}

const CANVAS_THEME_FALLBACKS: CanvasThemeColors = {
  gridMajor: "rgba(15, 23, 42, 0.13)",
  gridMinor: "rgba(15, 23, 42, 0.07)",
  ink: "#0f172a",
  chromeText: "#1e3a8a",
};

/** One custom property, resolved against `source`, or the fallback. */
function cssVar(
  source: Element | null | undefined,
  name: string,
  fallback: string,
): string {
  if (typeof window === "undefined") return fallback;
  const element = source ?? document.documentElement;
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}

/**
 * Every colour the canvas paints with.
 *
 * Read together and cached by the caller: `getComputedStyle` forces style
 * resolution, and doing it per frame per colour would show up in a drag.
 */
export function readCanvasTheme(
  source: Element | null | undefined,
  fallbacks: Partial<CanvasThemeColors> = {},
): CanvasThemeColors {
  const resolved = { ...CANVAS_THEME_FALLBACKS, ...fallbacks };
  return {
    gridMajor: cssVar(source, "--canvas-grid-major", resolved.gridMajor),
    gridMinor: cssVar(source, "--canvas-grid-minor", resolved.gridMinor),
    ink: cssVar(source, "--canvas-ink-color", resolved.ink),
    chromeText: cssVar(source, "--canvas-section-title-text", resolved.chromeText),
  };
}

/**
 * Whether the canvas should paint dark.
 *
 * An explicit `data-theme` wins; otherwise follow the system preference. Same
 * precedence the stylesheet uses, so the painted and DOM halves agree.
 */
export function isDarkMode(): boolean {
  if (typeof window === "undefined") return false;
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
