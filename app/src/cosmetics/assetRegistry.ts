import type {
  CosmeticAsset,
  CosmeticLoadout,
  CosmeticSlot,
  PublicUserAppearance,
} from "./types.ts";

function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const cosmeticAssets = [
  {
    id: "frame-orbit",
    slot: "avatarFrame",
    kind: "image",
    name: "Orbit",
    description: "A violet orbit with a tiny passing moon.",
    width: 64,
    height: 64,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="orbit" x1="8" y1="8" x2="56" y2="56">
            <stop stop-color="#8b5cf6"/>
            <stop offset="1" stop-color="#38bdf8"/>
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="27" fill="none" stroke="url(#orbit)" stroke-width="4"/>
        <ellipse cx="32" cy="32" rx="31" ry="12" fill="none" stroke="#c4b5fd" stroke-width="2" transform="rotate(-24 32 32)"/>
        <circle cx="56" cy="20" r="4" fill="#fef08a" stroke="#713f12" stroke-width="1.5"/>
      </svg>
    `),
  },
  {
    id: "frame-sunrise",
    slot: "avatarFrame",
    kind: "image",
    name: "Sunrise",
    description: "A warm frame with hand-drawn rays.",
    width: 64,
    height: 64,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
        <g fill="none" stroke-linecap="round">
          <circle cx="32" cy="32" r="27" stroke="#fb7185" stroke-width="4"/>
          <circle cx="32" cy="32" r="30" stroke="#fbbf24" stroke-width="2" stroke-dasharray="3 5"/>
          <path d="M32 0v5M32 59v5M0 32h5M59 32h5M9 9l4 4M51 51l4 4M55 9l-4 4M13 51l-4 4" stroke="#f59e0b" stroke-width="2.5"/>
        </g>
      </svg>
    `),
  },
  {
    id: "cursor-cloud-cat",
    slot: "cursorCompanion",
    kind: "image",
    name: "Cloud cat",
    description: "A small sleepy cat that follows your pointer.",
    width: 44,
    height: 36,
    animated: true,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 36">
        <path d="M8 15 5 7l9 5c2-2 5-3 8-3s6 1 8 3l9-5-3 9c2 2 3 5 3 8 0 7-7 10-17 10S5 31 5 24c0-4 1-7 3-9Z" fill="#f8fafc" stroke="#334155" stroke-width="2" stroke-linejoin="round"/>
        <path d="M14 22c1 1 3 1 4 0M26 22c1 1 3 1 4 0M20 26c1 2 3 2 4 0" fill="none" stroke="#334155" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M3 26c4-2 7-2 10-1M31 25c4-1 7 0 10 2" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: "cursor-jelly",
    slot: "cursorCompanion",
    kind: "image",
    name: "Jelly",
    description: "A cheerful blue jelly with a gentle bounce.",
    width: 38,
    height: 38,
    animated: true,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 38">
        <path d="M5 22C5 12 11 5 19 5s14 7 14 17v8c-3 0-3-3-6-3s-3 3-6 3-3-3-6-3-3 3-6 3c-2 0-4-1-4-3v-5Z" fill="#7dd3fc" stroke="#075985" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="14" cy="19" r="1.8" fill="#0c4a6e"/>
        <circle cx="24" cy="19" r="1.8" fill="#0c4a6e"/>
        <path d="M15 23c2 2 6 2 8 0" fill="none" stroke="#0c4a6e" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: "caret-spark",
    slot: "caretDecoration",
    kind: "image",
    name: "Spark",
    description: "A bright spark beside your live caret.",
    width: 32,
    height: 32,
    animated: true,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <path d="m16 2 2.7 8.7L28 13l-8.2 4.2L21 27l-6.2-7.2L6 24l4.5-8.2L4 9l9.2 2.1L16 2Z" fill="#facc15" stroke="#a16207" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="26" cy="5" r="2.2" fill="#fb7185"/>
      </svg>
    `),
  },
  {
    id: "caret-sprout",
    slot: "caretDecoration",
    kind: "image",
    name: "Sprout",
    description: "A tiny green sprout growing beside your caret.",
    width: 32,
    height: 32,
    animated: true,
    src: svgDataUri(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
        <path d="M16 28V13" fill="none" stroke="#166534" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M16 15C8 15 5 10 5 5c7 0 11 3 11 10Z" fill="#86efac" stroke="#166534" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M16 18c0-7 4-11 11-11 0 6-3 11-11 11Z" fill="#4ade80" stroke="#166534" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M10 28h12" fill="none" stroke="#854d0e" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `),
  },
] as const satisfies readonly CosmeticAsset[];

const assetsById = new Map<string, CosmeticAsset>(
  cosmeticAssets.map((asset) => [asset.id, asset] as const),
);
const registryListeners = new Set<() => void>();

function isCosmeticSlot(value: unknown): value is CosmeticSlot {
  return (
    value === "avatarFrame" ||
    value === "cursorCompanion" ||
    value === "caretDecoration"
  );
}

function isRenderableSource(src: string): boolean {
  return (
    (src.startsWith("/") && !src.startsWith("//")) ||
    src.startsWith("https://") ||
    /^data:image\/(?:png|webp|gif|svg\+xml)[;,]/.test(src)
  );
}

function isValidCosmeticAsset(asset: unknown): asset is CosmeticAsset {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
  const candidate = asset as Partial<CosmeticAsset>;
  return (
    typeof candidate.id === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,95}$/i.test(candidate.id) &&
    isCosmeticSlot(candidate.slot) &&
    candidate.kind === "image" &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    candidate.name.length <= 120 &&
    typeof candidate.description === "string" &&
    candidate.description.length <= 300 &&
    typeof candidate.src === "string" &&
    isRenderableSource(candidate.src) &&
    typeof candidate.width === "number" &&
    Number.isFinite(candidate.width) &&
    candidate.width > 0 &&
    candidate.width <= 512 &&
    typeof candidate.height === "number" &&
    Number.isFinite(candidate.height) &&
    candidate.height > 0 &&
    candidate.height <= 512 &&
    (candidate.animated === undefined || typeof candidate.animated === "boolean")
  );
}

export function listCosmeticAssets(): readonly CosmeticAsset[] {
  return cosmeticAssets;
}

export function getCosmeticAsset(id: string | null | undefined): CosmeticAsset | null {
  if (!id) return null;
  return assetsById.get(id) ?? null;
}

/**
 * Adds already-verified manifest assets to the frontend registry. This is the
 * adapter seam for Vektor Cloud: signature verification and fetching stay
 * outside the renderer, while malformed or executable descriptors are dropped.
 */
export function registerCosmeticAssets(
  assets: readonly unknown[],
): readonly CosmeticAsset[] {
  const accepted = assets.filter(isValidCosmeticAsset);
  for (const asset of accepted) assetsById.set(asset.id, asset);
  if (accepted.length > 0) {
    for (const listener of registryListeners) listener();
  }
  return accepted;
}

export function subscribeCosmeticRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

export function isCosmeticForSlot(
  id: string | null | undefined,
  slot: CosmeticSlot,
): boolean {
  return getCosmeticAsset(id)?.slot === slot;
}

export function sanitizeCosmeticLoadout(loadout: unknown): CosmeticLoadout {
  if (!loadout || typeof loadout !== "object" || Array.isArray(loadout)) return {};
  const candidate = loadout as CosmeticLoadout;
  return {
    avatarFrame: isCosmeticForSlot(candidate.avatarFrame, "avatarFrame")
      ? candidate.avatarFrame
      : undefined,
    cursorCompanion: isCosmeticForSlot(candidate.cursorCompanion, "cursorCompanion")
      ? candidate.cursorCompanion
      : undefined,
    caretDecoration: isCosmeticForSlot(candidate.caretDecoration, "caretDecoration")
      ? candidate.caretDecoration
      : undefined,
  };
}

export function appearanceFromLoadout(loadout: CosmeticLoadout): PublicUserAppearance {
  const sanitized = sanitizeCosmeticLoadout(loadout);
  return {
    avatarFrame: sanitized.avatarFrame,
    cursorCompanion: sanitized.cursorCompanion,
    caretDecoration: sanitized.caretDecoration,
  };
}
