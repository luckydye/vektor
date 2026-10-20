import { listUserSpaces } from "#db/space/spaces.ts";
import type { Platform } from "#platform/platform.ts";

export const LAST_VISITED_SPACE_KEY = "lastVisitedSpace";

/**
 * The space a space-agnostic URL lands in: the space the user was last in, else
 * the first one they can reach. Null when they belong to no space at all.
 */
export async function resolveActiveSpaceSlug(
  platform: Platform,
  userId: string | undefined,
  lastVisitedSlug: string | undefined,
): Promise<string | null> {
  const userSpaces = await listUserSpaces(platform, userId ?? "");
  if (userSpaces.length === 0) return null;

  return (userSpaces.find((s) => s.slug === lastVisitedSlug) ?? userSpaces[0]).slug;
}
