import { listUserSpaces } from "#db/space/spaces.ts";

export const LAST_VISITED_SPACE_KEY = "lastVisitedSpace";

/**
 * The space a space-agnostic URL lands in: the space the user was last in, else
 * the first one they can reach. Null when they belong to no space at all.
 */
export async function resolveActiveSpaceSlug(
  userId: string | undefined,
  lastVisitedSlug: string | undefined,
): Promise<string | null> {
  const userSpaces = await listUserSpaces(userId ?? "");
  if (userSpaces.length === 0) return null;

  return (userSpaces.find((s) => s.slug === lastVisitedSlug) ?? userSpaces[0]).slug;
}
