import { isHexColor } from "#utils/color.ts";
import { isSafeImageUrl, sanitizeSvgMarkup } from "#utils/html.ts";

/** Keys for settings that apply to an entire space. */
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
 * Every space preference, and what a valid value for it looks like.
 *
 * The map is the allow-list: a space preference is rendered on every page of the
 * space, for every member, and several of them are rendered *as markup or as
 * CSS* (`logoSvg` through `innerHTML`, `brandColor` into a style attribute and
 * into the generated palette). Accepting arbitrary keys with arbitrary values —
 * which is what a bare size cap amounts to — makes each one an injection
 * channel, so anything not described here is refused.
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
 */
const MAX_PREFERENCES_BYTES = 512 * 1024;

/**
 * The preferences to store for a space write, or the first reason to refuse it.
 * `undefined` in and `undefined` out: a write that does not mention preferences
 * leaves the stored ones alone.
 *
 * The single gate for both space write paths, which turn a refusal into a 400 —
 * it takes the request body's value as it comes, so the shape and the size are
 * checked here too rather than at each caller.
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
    // Not "unknown": `ai:provider` and its siblings are real preferences, they
    // are just written by the AI settings route rather than through here.
    const rule = PREFERENCE_RULES.get(key);
    if (!rule) return { error: `"${key}" is not a space preference set here` };
    if (typeof raw !== "string") return { error: `${key} must be a string` };

    if (raw === "") {
      validated[key] = "";
      continue;
    }

    const result = rule(raw);
    if ("error" in result) return result;
    validated[key] = result.value;
  }

  return { preferences: { ...validated } };
}
