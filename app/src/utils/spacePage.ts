import type { AstroGlobal } from "astro";
import {
  getUserGroups,
  hasPermission,
  listUserPermissions,
  ResourceType,
} from "../db/acl.ts";
import { getSpaceBySlug, type Space } from "../db/spaces.ts";
import { isNoAuthMode, LOCAL_USER_ID } from "../noAuth.ts";

type SpacePageResult =
  | { space: Space; response?: undefined }
  | { space?: undefined; response: Response };

/**
 * Shared guard for space pages: requires a `spaceSlug` param and an existing
 * space. Returns either the resolved space or a Response (redirect/404) the
 * page should return directly.
 *
 * Note: this no longer redirects unauthenticated users to `/login` so that
 * spaces with `public` group access can be viewed without a session. Pages
 * that genuinely require an authenticated user (e.g. settings, new document)
 * must perform their own session check.
 */
export async function resolveSpacePage(
  astro: Pick<AstroGlobal, "locals" | "params" | "redirect">,
): Promise<SpacePageResult> {
  const { spaceSlug } = astro.params;

  if (!spaceSlug) {
    return { response: astro.redirect("/") };
  }

  const space = await getSpaceBySlug(spaceSlug);

  if (!space) {
    return {
      response: new Response(null, {
        status: 404,
        statusText: "Space not found",
      }),
    };
  }

  return { space };
}

/**
 * Resolves the effective role the current session user has in a space.
 * Returns "owner", a permission string (e.g. "editor", "viewer"), or null
 * for unauthenticated / no-access callers. Used to annotate initialSpace
 * so the client knows role-dependent UI (settings, new-doc) immediately.
 */
export async function resolveUserSpaceRole(
  astro: Pick<AstroGlobal, "locals">,
  space: Space,
): Promise<string | null> {
  const user = astro.locals.user;

  if (isNoAuthMode() && user?.id === LOCAL_USER_ID) return "owner";
  if (!user) return null;

  if (space.createdBy === user.id) return "owner";

  const userGroups = await getUserGroups(user.id);
  const permissions = await listUserPermissions(
    space.id,
    user.id,
    userGroups,
    ResourceType.SPACE,
  );
  const match = permissions.find(
    (p) => p.resourceType === ResourceType.SPACE && p.resourceId === space.id,
  );
  return match?.permission ?? null;
}

/**
 * ACL check for space pages: the caller must have viewer access to the space.
 * Unauthenticated callers are evaluated against the `public` group, so spaces
 * that grant viewer to `public` are accessible without a session.
 * Returns a 403 Response to return from the page, or null if access is granted.
 */
export async function requireSpaceViewer(
  astro: Pick<AstroGlobal, "locals">,
  space: Space,
): Promise<Response | null> {
  const user = astro.locals.user;
  const userId = user?.id || "";
  const userGroups = user ? await getUserGroups(user.id) : ["public"];

  const hasAccess = await hasPermission(
    space.id,
    ResourceType.SPACE,
    space.id,
    userId,
    "viewer",
    userGroups,
  );

  if (!hasAccess) {
    if (!astro.locals.session) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login" },
      });
    }
    return new Response(null, {
      status: 403,
      statusText: "Forbidden",
    });
  }

  return null;
}
