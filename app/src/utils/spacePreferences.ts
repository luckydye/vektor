import { highestPermission, Permission } from "#acl/permissions.ts";
import { isHexColor } from "#utils/color.ts";
import { isSafeImageUrl, sanitizeSvgMarkup } from "#utils/html.ts";

/**
 * Space preferences: one open key-value store per space, for anything that has
 * to remember a setting about it.
 *
 * A key is either **core** — a bare name, this app's own settings, the ones
 * `spacePreferenceKeys` names — or **namespaced**, `namespace:name`, which is
 * how everything else takes a corner of the store without colliding with the app
 * or with another namespace. Any namespace may be written; one only needs an
 * entry in `PREFERENCE_NAMESPACES` when it takes more than write access on the
 * space, or when its values are the member's own rather than the space's.
 *
 * The same `preference` table also holds per-*user* rows, distinguished by
 * `preference.userId`. Those are a different store, reached only by the code that
 * owns them (`emailNotificationPreferences.ts`, `userProfiles.ts`) and never by a
 * space write. They are namespaced too — `user:space_muted`, `ai:user_profile` —
 * so the grammar covers the whole table rather than the space's half of it.
 */

/**
 * The core preference keys the app itself reads. Not the set of keys a space may
 * hold — the store is open — just the ones this codebase names.
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

/** Separates a namespace from the name of a preference inside it. */
const PREFERENCE_NAMESPACE_SEPARATOR = ":";

/** The namespaces this codebase claims. Any other name is free to use. */
export const spacePreferenceNamespaces = {
  ai: "ai",
  user: "user",
} as const;

/** A namespace name: short, and spelled like an identifier. */
const PREFERENCE_NAMESPACE_PATTERN = /^[a-z\d_-]{1,32}$/i;

/**
 * A name within a namespace. Separators are allowed *inside* it — a namespace
 * owner structures its own names, and one of them addresses a document
 * (`user:document_muted:<documentId>`).
 */
const PREFERENCE_NAME_PATTERN = /^[a-z\d_.:-]{1,96}$/i;

/** A preference key, split into the namespace that owns it and the name in it. */
export interface PreferenceKey {
  /** `null` for a core preference, which is the app's own flat namespace. */
  readonly namespace: string | null;
  readonly name: string;
}

/**
 * The parts of a preference key, or `null` if it is not a usable key.
 *
 * The namespace is what precedes the *first* separator, so a name keeps whatever
 * structure its owner gave it. A key with no separator at all is core: this
 * app's own settings, the flat names in `spacePreferenceKeys`.
 */
export function parsePreferenceKey(key: string): PreferenceKey | null {
  const separator = key.indexOf(PREFERENCE_NAMESPACE_SEPARATOR);

  if (separator === -1) {
    return PREFERENCE_NAME_PATTERN.test(key) ? { namespace: null, name: key } : null;
  }

  const namespace = key.slice(0, separator);
  const name = key.slice(separator + 1);
  if (!PREFERENCE_NAMESPACE_PATTERN.test(namespace)) return null;
  if (!PREFERENCE_NAME_PATTERN.test(name)) return null;
  return { namespace, name };
}

/** A key inside a namespace, which is the only place the separator is spelled. */
export function preferenceKey(namespace: string, name: string): string {
  return `${namespace}${PREFERENCE_NAMESPACE_SEPARATOR}${name}`;
}

/**
 * Whose rows a namespace's preferences are.
 *
 * `"space"` means one value for the space, stored with no user — what a
 * preference has always been here. `"user"` means one value per member, stored
 * against `preference.userId`: the member's own view of the space, which is
 * theirs to set and nobody else's to read.
 */
export type PreferenceScope = "space" | "user";

interface PreferenceNamespaceRules {
  readonly scope: PreferenceScope;
  /** Role a space write must hold to set anything in the namespace. */
  readonly writeRole: Permission;
}

/**
 * The namespaces with rules of their own. A namespace absent from here is a
 * space-level one open at `EDITOR` — being a namespace is not a permission to be
 * granted, and claiming one is not an act that needs approving.
 */
const PREFERENCE_NAMESPACES = new Map<string, PreferenceNamespaceRules>([
  [
    // The space's AI provider, also written by `settings-ai-provider.ts`, which
    // gates it at OWNER: whoever sets `ai:baseUrl` picks the host every member's
    // prompts are sent to. The *value* is not re-checked here — that route
    // validates it against the SSRF policy, and `safeFetch` validates it again on
    // read, which is the check that holds for a value already stored.
    spacePreferenceNamespaces.ai,
    { scope: "space", writeRole: Permission.OWNER },
  ],
  [
    // A member's own settings for a space. Written at `VIEWER` because they
    // decide nothing for anyone else — a viewer may keep their own state, and a
    // space-wide role is still required, so a lone document grant does not carry
    // space-wide storage with it.
    spacePreferenceNamespaces.user,
    { scope: "user", writeRole: Permission.VIEWER },
  ],
]);

/** Core preferences that decide something for the space rather than a member. */
const OWNER_ONLY_CORE_PREFERENCES = new Set<string>([
  spacePreferenceKeys.workflowCreationEnabled,
]);

function namespaceRules(key: string): PreferenceNamespaceRules | undefined {
  const parsed = parsePreferenceKey(key);
  if (!parsed?.namespace) return undefined;
  return PREFERENCE_NAMESPACES.get(parsed.namespace);
}

/** Whose row this preference is: the space's, or the member writing it. */
export function preferenceScope(key: string): PreferenceScope {
  return namespaceRules(key)?.scope ?? "space";
}

function preferenceWriteRole(key: string): Permission {
  const parsed = parsePreferenceKey(key);
  // Unreachable for a validated key, and not a key to hand out cheaply.
  if (!parsed) return Permission.OWNER;

  if (parsed.namespace !== null) {
    return PREFERENCE_NAMESPACES.get(parsed.namespace)?.writeRole ?? Permission.EDITOR;
  }

  return OWNER_ONLY_CORE_PREFERENCES.has(parsed.name)
    ? Permission.OWNER
    : Permission.EDITOR;
}

/**
 * The role a space write must hold to set these preferences — the strongest any
 * one of them asks for. `PATCH /spaces/:id` verifies it before writing.
 */
export function requiredPreferenceWriteRole(
  preferences: Record<string, string> | undefined,
): Permission {
  return (
    highestPermission(Object.keys(preferences ?? {}).map(preferenceWriteRole)) ??
    Permission.VIEWER
  );
}

/**
 * Validated preferences split by whose rows they are, since the two halves are
 * stored by different writers: the space's by `updateSpace`, the member's by
 * `setUserPreferences` against their own user id.
 */
export function splitPreferencesByScope(preferences: Record<string, string>): {
  space: Record<string, string>;
  user: Record<string, string>;
} {
  const space: Record<string, string> = {};
  const user: Record<string, string> = {};

  for (const [key, value] of Object.entries(preferences)) {
    if (preferenceScope(key) === "user") user[key] = value;
    else space[key] = value;
  }

  return { space, user };
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
    if (!parsePreferenceKey(key)) {
      return {
        error: `"${key}" is not a usable preference key: a name, or "namespace:name"`,
      };
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
