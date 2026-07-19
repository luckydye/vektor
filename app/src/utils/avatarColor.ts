const compoundOffsets = [30, 150, 210, 330];
const defaultPrimaryHue = 283;

/**
 * FNV-1a 32-bit hash of a normalized seed (trimmed + lowercased). Seeding by a
 * user's email keeps their generated color stable and identical across avatar
 * and collaboration surfaces.
 */
export function hashAvatarSeed(seed: string | null | undefined): number {
  const normalizedSeed = seed?.trim().toLowerCase() ?? "";
  let hash = 0x811c9dc5;

  for (let index = 0; index < normalizedSeed.length; index += 1) {
    hash ^= normalizedSeed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function getPrimaryColorHue(): number {
  if (typeof document === "undefined") return defaultPrimaryHue;

  const primaryColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-primary")
    .trim();
  const hex = primaryColor.match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
  if (!hex) return defaultPrimaryHue;

  const expandedHex =
    hex.length === 3 ? [...hex].map((value) => value.repeat(2)).join("") : hex;
  const red = Number.parseInt(expandedHex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(expandedHex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(expandedHex.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  if (delta === 0) return defaultPrimaryHue;
  if (max === red) return (60 * ((green - blue) / delta) + 360) % 360;
  if (max === green) return 60 * ((blue - red) / delta + 2);
  return 60 * ((red - green) / delta + 4);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hueSegment = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const match = lightness - chroma / 2;

  let red = 0;
  let green = 0;
  let blue = 0;

  if (hueSegment < 1) [red, green] = [chroma, secondary];
  else if (hueSegment < 2) [red, green] = [secondary, chroma];
  else if (hueSegment < 3) [green, blue] = [chroma, secondary];
  else if (hueSegment < 4) [green, blue] = [secondary, chroma];
  else if (hueSegment < 5) [red, blue] = [secondary, chroma];
  else [red, blue] = [chroma, secondary];

  const componentToHex = (component: number) =>
    Math.round((component + match) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;
}

/**
 * Turns a precomputed seed hash into a high-lightness pastel offset from the
 * app's primary hue. Exported for callers that already need the hash (e.g. to
 * pick a matching avatar SVG).
 */
export function avatarColorFromHash(hash: number): string {
  const primaryColorHue = getPrimaryColorHue();
  const hueVariation = ((hash >>> 24) % 17) - 8;
  const hue =
    (primaryColorHue + compoundOffsets[hash % compoundOffsets.length] + hueVariation) %
    360;
  const saturation = 65 + ((hash >>> 8) % 26);
  const lightness = 74 + ((hash >>> 16) % 13);

  return hslToHex(hue, saturation / 100, lightness / 100);
}

/** Generated identity color for a seed (typically a user's email). */
export function getAvatarColor(seed: string | null | undefined): string {
  return avatarColorFromHash(hashAvatarSeed(seed));
}
