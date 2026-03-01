/**
 * Generates a color palette from a base color for light mode
 * Creates shades from 10 (lightest) to 950 (darkest)
 */
export function generateColorPalette(baseColor: string): Record<string, string> {
  const hex = baseColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const [h, s, l] = rgbToHsl(r, g, b);

  const palette: Record<string, string> = {};

  // Generate shades
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
    const [newR, newG, newB] = hslToRgb(h, s, stop.lightness / 100);
    palette[stop.key] =
      `#${componentToHex(newR)}${componentToHex(newG)}${componentToHex(newB)}`;
  }

  return palette;
}

/**
 * Generates a dark mode color palette from a base color
 * Creates shades optimized for dark backgrounds
 */
export function generateDarkColorPalette(baseColor: string): Record<string, string> {
  const hex = baseColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);

  const [h, s, l] = rgbToHsl(r, g, b);

  const palette: Record<string, string> = {};

  // Generate dark mode shades (inverted lightness scale with adjusted saturation)
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
    const [newR, newG, newB] = hslToRgb(h, stop.saturation, stop.lightness / 100);
    palette[stop.key] =
      `#${componentToHex(newR)}${componentToHex(newG)}${componentToHex(newB)}`;
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
  return hex.length === 1 ? "0" + hex : hex;
}

/**
 * Generates CSS custom properties for the color palette
 */
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

export function formatDate(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffInMs = now.getTime() - date.getTime();
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInDays === 0) {
    return "Today";
  } else if (diffInDays === 1) {
    return "Yesterday";
  } else if (diffInDays < 7) {
    return `${diffInDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

export function formatRelativeTime(timestamp: number) {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "Just now";
}

export function getUserInitials(userId: string) {
  return userId.slice(0, 2).toUpperCase();
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
 * Strip all script tags from HTML content to prevent XSS attacks
 */
export function stripScriptTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<script[^>]*>/gi, "");
}
