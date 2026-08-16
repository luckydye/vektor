import { canAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { config } from "#config";
import { getSpaceBySlug, listUserSpaces } from "#db/space/spaces.ts";

export const LAST_VISITED_SPACE_KEY = "lastVisitedSpace";

/**
 * The space a space-agnostic URL lands in: the configured default when the user
 * can reach it, else the space they were last in, else the first one they can
 * reach. Null when they belong to no space at all.
 */
export async function resolveActiveSpaceSlug(
  userId: string | undefined,
  lastVisitedSlug: string | undefined,
): Promise<string | null> {
  const defaultSlug = config().DEFAULT_SPACE;
  const defaultSpace = defaultSlug ? await getSpaceBySlug(defaultSlug) : null;

  if (defaultSpace) {
    const reachable = await canAccess(
      defaultSpace.id,
      { type: ResourceType.SPACE, id: defaultSpace.id },
      userId ?? null,
      Permission.VIEWER,
    );
    if (reachable) return defaultSpace.slug;
  }

  const userSpaces = await listUserSpaces(userId ?? "");
  if (userSpaces.length === 0) return null;

  return (userSpaces.find((s) => s.slug === lastVisitedSlug) ?? userSpaces[0]).slug;
}
