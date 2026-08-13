/** Inverse of `slugify` for display: "my-extension" → "My Extension". */
export function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Latin letters NFKD leaves alone, because they are a letter in their own right
 * rather than a base letter plus a combining mark. Without these, `Æther`
 * slugifies to `ther` and `Straße` to `strae`.
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
 * Fold text down to ASCII: decompose, drop the combining marks, then expand the
 * letters that carry no separable mark.
 *
 * The fold is plain ASCII rather than a per-language transliteration — `Über`
 * becomes `uber`, not `ueber` — so one rule covers every Latin-script language
 * identically and no slug depends on the writer's locale.
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
 * Thai, …) legitimately produce `""`. That is not an error — the caller decides
 * what to use instead, because a title the slug cannot represent must never
 * block a write. Reserved names are the caller's business too: a document slug
 * and a space slug compete with different routes, see `reservedDocumentSlugs`
 * and `reservedSpaceSlugs`.
 */
export function slugify(text: string) {
  return foldToAscii(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * First path segments inside a space (`/{spaceSlug}/…`) that a document slug
 * must not claim.
 *
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
 * Every static route in `src/pages/` and every asset in `public/` wins over the
 * space catch-all `src/pages/[spaceSlug]/[...all].astro`, and `/api` plus
 * `/.well-known/*` never reach Astro at all — so a space sitting on one of
 * these is created, listed in the switcher, and unreachable forever.
 *
 * `test/slugs.spec.ts` fails when `src/pages/` or `public/` gains a top-level
 * entry that is missing here, so a new page cannot silently reintroduce the
 * collision.
 */
export const reservedSpaceSlugs: readonly string[] = [
  // src/pages/
  "404",
  "docs",
  "login",
  "new",
  // Server-owned prefixes (src/server.ts, never handed to Astro). Hono answers
  // these before the Astro fallback, which only runs on a 404, so they are not
  // in `src/pages/` and the test below cannot discover them — a route added to
  // `src/server.ts` has to be added here by hand.
  "api",
  ".well-known",
  "metrics",
  // Astro's own output namespaces
  "_astro",
  "_image",
  "_server-islands",
  "_actions",
  // public/
  "favicon.ico",
  "robots.txt",
  "manifest.json",
  "manifest.dev.json",
  "sw.js",
  "llms.txt",
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
 * The one rule set behind space creation, space update and the create dialog, so
 * the three cannot drift apart — creation used to sanitize silently while the
 * update endpoint stored anything at all.
 *
 * Unlike a document slug this is a value somebody typed into a slug field, so a
 * value `slugify` would have had to rewrite is reported back instead of being
 * quietly corrected. The message names the form that would be stored, because
 * the rule alone does not always explain the rejection: `my-team-` holds nothing
 * but lowercase letters and hyphens and is still not a slug.
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

/**
 * Canonical form of a space slug that has already passed
 * {@link spaceSlugRejection}.
 */
export function canonicalSpaceSlug(input: string): string {
  return input.trim().toLowerCase();
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

/** Byte count as a short human label: "812 B", "3.4 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
