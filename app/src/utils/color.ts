/**
 * Color math shared across the app: hex/HSL/RGB conversion, the brand palette
 * generator that feeds the CSS custom properties, and the contrast + hex-format
 * helpers used by category chips and the cursor-color preference.
 *
 * The seeded per-user color *derivation* lives in `avatarColor.ts`, but it uses
 * the conversions here rather than carrying its own copy.
 */

/** Hue (0-360), saturation and lightness (0-1) of a 6-digit `#rrggbb` color. */
export function hexToHsl(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return rgbToHsl(r, g, b);
}

/** `#rrggbb` for a hue in degrees (0-360) plus saturation/lightness in 0-1. */
export function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

/**
 * The light-mode brand ramp a base color produces, keyed by Tailwind-style
 * stop. `generatePaletteCss` turns this into the app's custom properties;
 * anything rendering outside the stylesheet — notification email — reads the
 * stops directly so it lands on the same colors the space's UI uses.
 */
export function generateColorPalette(baseColor: string): Record<string, string> {
  const [h, s] = hexToHsl(baseColor);

  const palette: Record<string, string> = {};

  const stops = [
    { key: "10", lightness: 95 },
    { key: "50", lightness: 90 },
    { key: "100", lightness: 85 },
    { key: "200", lightness: 75 },
    { key: "300", lightness: 65 },
    { key: "400", lightness: 55 },
    { key: "500", lightness: 45 },
    { key: "600", lightness: 35 },
    { key: "700", lightness: 25 },
    { key: "800", lightness: 18 },
    { key: "900", lightness: 12 },
    { key: "950", lightness: 7 },
  ];

  for (const stop of stops) {
    palette[stop.key] = hslToHex(h, s, stop.lightness / 100);
  }

  return palette;
}

function generateDarkColorPalette(baseColor: string): Record<string, string> {
  const [h, s] = hexToHsl(baseColor);

  const palette: Record<string, string> = {};

  const stops = [
    { key: "10", lightness: 12, saturation: s * 0.6 },
    { key: "50", lightness: 16, saturation: s * 0.65 },
    { key: "100", lightness: 20, saturation: s * 0.7 },
    { key: "200", lightness: 28, saturation: s * 0.75 },
    { key: "300", lightness: 38, saturation: s * 0.8 },
    { key: "400", lightness: 48, saturation: s * 0.85 },
    { key: "500", lightness: 58, saturation: s * 0.9 },
    { key: "600", lightness: 68, saturation: s * 0.95 },
    { key: "700", lightness: 78, saturation: s },
    { key: "800", lightness: 85, saturation: s },
    { key: "900", lightness: 90, saturation: s * 0.95 },
    { key: "950", lightness: 95, saturation: s * 0.9 },
  ];

  for (const stop of stops) {
    palette[stop.key] = hslToHex(h, stop.saturation, stop.lightness / 100);
  }

  return palette;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h /= 360;

  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function componentToHex(c: number): string {
  const hex = c.toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}

export function generatePaletteCss(baseColor: string) {
  return {
    light: Object.entries(generateColorPalette(baseColor))
      .map(([key, value]) => `--color-primary-${key}: ${value};`)
      .join("\n  "),
    dark: Object.entries(generateDarkColorPalette(baseColor))
      .map(([key, value]) => `--color-primary-${key}: ${value};`)
      .join("\n  "),
  };
}

// Accepts undefined: a category may have no colour, and the guard below is
// already the answer for that case.
export function getTextColor(bgColor: string | undefined) {
  if (!bgColor) {
    return "#1F2937";
  }

  const hex = bgColor.replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  return brightness > 155 ? "#1F2937" : "#FFFFFF";
}

/** True for a full 6-digit hex color (`#rrggbb`), the only format we persist. */
export function isHexColor(value: string | null): value is string {
  return /^#[0-9a-f]{6}$/i.test(value ?? "");
}

/**
 * A brand color as ink on a light surface: its own hue and saturation at the
 * lightness `generateColorPalette` gives the `600` stop, so another space's name
 * reads the way `text-primary-600` reads for the space you are in. Taking the hex
 * as given would leave a pastel brand illegible and a near-black one flat.
 */
export function brandTextColor(color: string | undefined): string | undefined {
  if (!color || !isHexColor(color)) return undefined;

  const [hue, saturation] = hexToHsl(color);
  return hslToHex(hue, saturation, 0.35);
}
