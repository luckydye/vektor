import type { AstroGlobal } from "astro";
import { getUserGroups, hasPermission, ResourceType } from "../db/acl.ts";
import { getSpaceBySlug, type Space } from "../db/spaces.ts";

type SpacePageResult =
  | { space: Space; response?: undefined }
  | { space?: undefined; response: Response };

/**
 * Shared guard for space pages: requires a session, a `spaceSlug` param, and
 * an existing space. Returns either the resolved space or a Response
 * (redirect/404) the page should return directly.
 */
export async function resolveSpacePage(
  astro: Pick<AstroGlobal, "locals" | "params" | "redirect">,
): Promise<SpacePageResult> {
  if (!astro.locals.session) {
    return { response: astro.redirect("/login") };
  }

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
 * ACL check for space pages: the user must be a member (viewer) of the space.
 * Returns a 403 Response to return from the page, or null if access is granted.
 */
export async function requireSpaceViewer(
  astro: Pick<AstroGlobal, "locals">,
  space: Space,
): Promise<Response | null> {
  const userGroups = await getUserGroups(astro.locals.user!.id);
  const hasAccess = await hasPermission(
    space.id,
    ResourceType.SPACE,
    space.id,
    astro.locals.user!.id,
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
