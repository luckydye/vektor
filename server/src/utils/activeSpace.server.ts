import { findUserSpaceBySlug, listUserSpaces } from "#db/space/spaces.ts";
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
  // The last-visited space is one lookup; listing every space is only for when it misses.
  if (lastVisitedSlug) {
    const lastVisited = await findUserSpaceBySlug(
      platform,
      userId ?? "",
      lastVisitedSlug,
    );
    if (lastVisited) return lastVisited.slug;
  }
  const userSpaces = await listUserSpaces(platform, userId ?? "");
  return userSpaces[0]?.slug ?? null;
}
