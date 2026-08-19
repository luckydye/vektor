import { Permission, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, hasPermission } from "#acl/store.ts";
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
    const canAccess = await hasPermission(
      defaultSpace.id,
      ResourceType.SPACE,
      defaultSpace.id,
      userId ?? "",
      Permission.VIEWER,
      await getUserGroups(userId ?? ""),
    );
    if (canAccess) return defaultSpace.slug;
  }

  const userSpaces = await listUserSpaces(userId ?? "");
  if (userSpaces.length === 0) return null;

  return (userSpaces.find((s) => s.slug === lastVisitedSlug) ?? userSpaces[0]).slug;
}
