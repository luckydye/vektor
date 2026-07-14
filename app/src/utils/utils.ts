import { currentLang } from "#utils/lang.ts";

function hexToHsl(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return rgbToHsl(r, g, b);
}

function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`;
}

function generateColorPalette(baseColor: string): Record<string, string> {
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

export function getTextColor(bgColor: string) {
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

export function formatDate(dateString: string | number | Date) {
  const date = normalizeTimestamp(dateString);
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
  const locale = currentLang();
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const formatRelativeDay = (days: number) => {
    const value = relativeTime.format(-days, "day");
    return value.charAt(0).toUpperCase() + value.slice(1);
  };

  if (diffInDays === 0) {
    return formatRelativeDay(0);
  } else if (diffInDays === 1) {
    return formatRelativeDay(1);
  } else if (diffInDays < 7) {
    return formatRelativeDay(diffInDays);
  } else {
    return date.toLocaleDateString(locale);
  }
}

export function formatRelativeTime(timestamp: number) {
  const now = Date.now();
  const diff = now - normalizeTimestamp(timestamp).getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const relativeTime = new Intl.RelativeTimeFormat(currentLang(), {
    numeric: "auto",
    style: "short",
  });

  if (days > 0) return relativeTime.format(-days, "day");
  if (hours > 0) return relativeTime.format(-hours, "hour");
  if (minutes > 0) return relativeTime.format(-minutes, "minute");
  return relativeTime.format(0, "second");
}

export function getUserInitials(userId: string) {
  return userId.slice(0, 2).toUpperCase();
}

export function normalizeTimestamp(value: string | number | Date): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number") {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Invalid numeric timestamp: ${value}`);
    }
    return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed;
}

export function slugify(text: string) {
  const reservedSlugs = ["new"];

  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (reservedSlugs.includes(slug)) {
    slug = `${slug}-1`;
  }

  return slug;
}

export function detectAppType(
  label: string,
): "jira" | "youtrack" | "linear" | "github" | "gitlab" | undefined {
  const lowerLabel = label.toLowerCase();

  if (lowerLabel.includes("jira")) {
    return "jira";
  }
  if (lowerLabel.includes("youtrack")) {
    return "youtrack";
  }
  if (lowerLabel.includes("linear")) {
    return "linear";
  }
  if (lowerLabel.includes("github")) {
    return "github";
  }
  if (lowerLabel.includes("gitlab")) {
    return "gitlab";
  }

  return undefined;
}

/**
 * Build a full space-scoped URL from a base-relative path (e.g. "/doc/foo").
 * The router base is "/{spaceSlug}/", so anchor `href` attributes must include
 * the space slug for middle-click / open-in-new-tab to resolve on the server.
 */
export function spacePath(spaceSlug: string | null | undefined, path: string): string {
  if (!spaceSlug) return path;
  return `/${spaceSlug}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Strip all script tags from HTML content to prevent XSS attacks
 */
export function stripScriptTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<script[^>]*>/gi, "");
}
