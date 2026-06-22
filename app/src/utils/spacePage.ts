import type { AstroGlobal } from "astro";
import { getUserGroups, hasPermission, ResourceType } from "../db/acl.ts";
import { getSpaceBySlug, type Space } from "../db/spaces.ts";

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
    return new Response(null, {
      status: 403,
      statusText: "Forbidden",
    });
  }

  return null;
}
