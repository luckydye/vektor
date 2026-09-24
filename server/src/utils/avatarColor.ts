import { hexToHsl, hslToHex } from "#utils/color.ts";

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
  const [hue, saturation] = hexToHsl(expandedHex);

  // A greyscale primary carries no usable hue — fall back to the brand default.
  return saturation === 0 ? defaultPrimaryHue : hue;
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
