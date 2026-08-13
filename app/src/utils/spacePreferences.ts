import { isHexColor } from "#utils/color.ts";
import { isSafeImageUrl, sanitizeSvgMarkup } from "#utils/html.ts";

/**
 * The preference keys the app itself reads. Not the set of keys a space may
 * hold: preferences are an open key-value store, and anything may put its own
 * settings there. These are the ones this codebase names.
 */
export const spacePreferenceKeys = {
  brandColor: "brandColor",
  description: "description",
  logoSvg: "logoSvg",
  pinnedDocumentId: "pinnedDocumentId",
  workflowCreationEnabled: "workflowCreationEnabled",
} as const;

/**
 * Workflows remain available for spaces created before this preference existed.
 * Only an explicit false value disables creating new workflow documents.
 */
export function isWorkflowCreationEnabled(
  preferences: Record<string, string> | null | undefined,
): boolean {
  return preferences?.[spacePreferenceKeys.workflowCreationEnabled] !== "false";
}

/** Longest a free-text preference may be. */
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * The value a preference is stored as, or why it was refused.
 *
 * A rule may rewrite its value — `logoSvg` is stored sanitized — so the write
 * path has to persist what comes back rather than what came in.
 */
type PreferenceRule = (value: string) => { value: string } | { error: string };

/**
 * The preferences this app renders, and what a valid value for each looks like.
 *
 * A key with no rule here is stored as the opaque text it is — the store is open
 * on purpose. A key gets a rule when the app does something with its value other
 * than show it as text: `logoSvg` is injected as markup, `brandColor` goes into a
 * style attribute and into the generated palette, and a value that is markup or
 * CSS is an injection channel unless it is checked on the way in.
 *
 * So: anything that starts rendering a preference as markup, as CSS or as a URL
 * either gives it a rule here or sanitizes at the render site. The render sites
 * that exist today do both (see `Icon.tsx`).
 *
 * A `Map`, not an object literal: keys arrive from a JSON request body, and
 * `"__proto__"` is a lookup an object would answer with something truthy.
 */
const PREFERENCE_RULES = new Map<string, PreferenceRule>([
  [
    spacePreferenceKeys.brandColor,
    (value) =>
      isHexColor(value)
        ? { value }
        : { error: "brandColor must be a hex color, e.g. #1e293b" },
  ],
  [
    spacePreferenceKeys.description,
    (value) =>
      value.length <= MAX_DESCRIPTION_LENGTH
        ? { value }
        : { error: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters` },
  ],
  [
    spacePreferenceKeys.logoSvg,
    (value) => {
      // Either an inline SVG document or a URL to an image — the space selector
      // renders the first as markup and the second as an `<img src>`.
      if (value.trimStart().startsWith("<")) {
        const svg = sanitizeSvgMarkup(value);
        return svg
          ? { value: svg }
          : { error: "logoSvg must be an <svg> document or an image URL" };
      }
      return isSafeImageUrl(value)
        ? { value }
        : { error: "logoSvg must be an <svg> document or an image URL" };
    },
  ],
  [
    spacePreferenceKeys.pinnedDocumentId,
    (value) =>
      /^[\w-]{1,64}$/.test(value)
        ? { value }
        : { error: "pinnedDocumentId must be a document id" },
  ],
  [
    spacePreferenceKeys.workflowCreationEnabled,
    (value) =>
      value === "true" || value === "false"
        ? { value }
        : { error: "workflowCreationEnabled must be 'true' or 'false'" },
  ],
]);

/**
 * Preferences are embedded in every space read and list response, so an
 * oversized value (a multi-megabyte inline logo, say) bloats every request that
 * carries it and can stall request bodies behind dev and reverse proxies.
 *
 * This is the budget the open store is bounded by, rather than a list of the
 * keys it may hold.
 */
const MAX_PREFERENCES_BYTES = 512 * 1024;

/** What a key may be spelled with, so it survives a URL, a query and a diff. */
const PREFERENCE_KEY_PATTERN = /^[a-z\d_.:-]{1,64}$/i;

/**
 * Keys that name something other than a preference. `preferences[key] = value`
 * against `__proto__` on a plain object writes a prototype instead of an entry —
 * `getSpace` rebuilds the map that way — so the key would be silently lost at
 * best. They are refused rather than made to work: nothing needs them.
 */
const RESERVED_PREFERENCE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Preferences that decide something for the whole space rather than for the
 * member writing them, and so take the role their own settings page takes.
 *
 * `ai:*` is the space's AI provider config, which `settings-ai-provider.ts`
 * gates at `OWNER`: whoever sets `ai:baseUrl` chooses the host every member's
 * prompts are sent to. Writing it here is fine — it is a preference like any
 * other — but not at a lower role than the page that owns it.
 *
 * The value is not re-validated here. `ai:baseUrl` is checked against the SSRF
 * policy where that settings route stores it, and again by the `safeFetch` that
 * reads it, which is the check that actually holds for a value already stored.
 */
const OWNER_ONLY_PREFERENCE_PREFIXES = ["ai:"];

/**
 * Does writing these preferences require space ownership rather than write
 * access? `PATCH /spaces/:id` asks before it picks the role to verify.
 */
export function preferencesRequireSpaceOwner(
  preferences: Record<string, string> | undefined,
): boolean {
  if (!preferences) return false;

  return Object.keys(preferences).some(
    (key) =>
      key === spacePreferenceKeys.workflowCreationEnabled ||
      OWNER_ONLY_PREFERENCE_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}

/**
 * The preferences to store for a space write, or the first reason to refuse it.
 * `undefined` in and `undefined` out: a write that does not mention preferences
 * leaves the stored ones alone.
 *
 * The single gate for both space write paths, which turn a refusal into a 400 —
 * it takes the request body's value as it comes, so the shape and the size are
 * checked here too rather than at each caller.
 *
 * Any key is storable. What is checked is the key's spelling, the total size, and
 * the value of the keys in `PREFERENCE_RULES` — the ones this app renders as
 * something other than text.
 *
 * An empty string is how the client clears a preference (unpinning a document
 * sends `pinnedDocumentId: ""`), so it is accepted for every key without being
 * run through that key's rule.
 */
export function validateSpacePreferences(
  preferences: unknown,
): { preferences: Record<string, string> | undefined } | { error: string } {
  if (preferences === undefined) return { preferences: undefined };

  if (
    typeof preferences !== "object" ||
    preferences === null ||
    Array.isArray(preferences)
  ) {
    return { error: "preferences must be an object" };
  }

  if (
    new TextEncoder().encode(JSON.stringify(preferences)).length > MAX_PREFERENCES_BYTES
  ) {
    return { error: "preferences must be smaller than 512 KB" };
  }

  const validated: Record<string, string> = Object.create(null);

  for (const [key, raw] of Object.entries(preferences)) {
    if (!PREFERENCE_KEY_PATTERN.test(key) || RESERVED_PREFERENCE_KEYS.has(key)) {
      return { error: `"${key}" is not a usable preference key` };
    }

    if (typeof raw !== "string") return { error: `${key} must be a string` };

    if (raw === "") {
      validated[key] = "";
      continue;
    }

    // No rule means the app does not interpret this key, so its value is text.
    const rule = PREFERENCE_RULES.get(key);
    if (!rule) {
      validated[key] = raw;
      continue;
    }

    const result = rule(raw);
    if ("error" in result) return result;
    validated[key] = result.value;
  }

  return { preferences: { ...validated } };
}
