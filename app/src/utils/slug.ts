/**
 * Latin letters NFKD leaves alone, being letters in their own right rather than
 * a base letter plus a combining mark. Without them `Æther` folds to `ther` and
 * `Straße` to `strae`.
 */
const latinLetterExpansions: Readonly<Record<string, string>> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ß: "ss",
  þ: "th",
  ð: "d",
  đ: "d",
  ħ: "h",
  ı: "i",
  ł: "l",
  ŋ: "n",
  ŧ: "t",
};

const latinLetterExpansionPattern = new RegExp(
  `[${Object.keys(latinLetterExpansions).join("")}]`,
  "gu",
);

/**
 * Plain ASCII rather than a per-language transliteration — `Über` becomes
 * `uber`, not `ueber` — so one rule covers every Latin-script language and no
 * slug depends on the writer's locale.
 */
export function foldToAscii(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(
      latinLetterExpansionPattern,
      (letter) => latinLetterExpansions[letter] ?? letter,
    );
}

/**
 * URL-safe slug for a piece of text.
 *
 * Scripts with no ASCII fold at all (CJK, Cyrillic, Arabic, Hebrew, Greek,
 * Thai, …) legitimately produce `""`, and the caller decides what to use
 * instead, because a title the slug cannot represent must never block a write.
 * Reserved names are the caller's business too: document and space slugs
 * compete with different routes.
 */
export function slugify(text: string) {
  return foldToAscii(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Suffixed silently rather than rejected: a document slug is derived from a
 * title the user typed, not typed as a slug, so there is nothing to correct.
 */
export const reservedDocumentSlugs: readonly string[] = ["new"];

export function isReservedDocumentSlug(slug: string): boolean {
  return reservedDocumentSlugs.includes(slug);
}

/**
 * First path segments the app itself owns, which a space slug must not claim.
 *
 * Each of these wins over the space catch-all `[spaceSlug]/[...all].astro`, so a
 * space sitting on one is created, listed in the switcher, and unreachable
 * forever. `test/slugs.spec.ts` fails on a new `src/pages/` route, `public/`
 * asset or `src/server.ts` route that is missing here.
 */
export const reservedSpaceSlugs: readonly string[] = [
  // src/pages/
  "404",
  "docs",
  "login",
  "new",
  "s",
  "spaces",
  // Answered by Hono before the Astro fallback, which only runs on a 404, so no
  // page file records them.
  "api",
  ".well-known",
  "metrics",
  // Astro's own output namespaces
  "_astro",
  "_image",
  "_server-islands",
  "_actions",
  // public/
  "onboarding",
  "favicon.ico",
  "robots.txt",
  "manifest.json",
  "manifest.dev.json",
  "sw.js",
  "llms.txt",
  "onboarding",
  "favicon_dark.png",
  "favicon_light.png",
  "favicon_dev.png",
  "180x180.png",
  "180x180_dev.png",
  "192x192.png",
  "192x192_dev.png",
  "512x512.png",
  "512x512_dev.png",
];

export function isReservedSpaceSlug(slug: string): boolean {
  return reservedSpaceSlugs.includes(slug.toLowerCase());
}

/**
 * Why a caller-supplied space slug cannot be used, or `undefined` when it can.
 *
 * Unlike a document slug this is a value somebody typed into a slug field, so
 * anything `slugify` would have rewritten is reported back rather than quietly
 * corrected — named in the message, because the rule alone does not explain
 * every rejection: `my-team-` holds nothing but lowercase letters and hyphens.
 */
export function spaceSlugRejection(input: string): string | undefined {
  const trimmed = input.trim();
  const slug = slugify(trimmed);

  if (!slug) {
    return "Slug must contain at least one lowercase letter or number";
  }
  if (slug !== trimmed.toLowerCase()) {
    return `Slug must be lowercase letters, numbers and single inner hyphens — try "${slug}"`;
  }
  if (isReservedSpaceSlug(slug)) {
    return `"${slug}" is reserved by Vektor — pick another slug`;
  }
  return undefined;
}

/** Storage form of a slug that has already passed {@link spaceSlugRejection}. */
export function canonicalSpaceSlug(input: string): string {
  return input.trim().toLowerCase();
}
