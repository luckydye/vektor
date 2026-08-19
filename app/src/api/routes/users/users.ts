import { desc, eq, inArray } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import {
  GROUP_NAME_PATTERN,
  Permission,
  PUBLIC_GROUP,
  ResourceType,
} from "#acl/permissions.ts";
import { getSpaceMemberIds } from "#acl/store.ts";
import {
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { user } from "#db/schema/auth.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

/**
 * The stored group claim as a list, without the freshness bound and the
 * synthetic `public` that {@link import("#acl/userGroups.ts").getUserGroups}
 * adds: the register prints what the IdP last said, it does not authorize
 * anything. Malformed names are dropped for the same reason as there — nothing
 * the IdP wrote is trusted to be a group name.
 */
function storedGroups(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (group): group is string =>
        typeof group === "string" &&
        group !== PUBLIC_GROUP &&
        GROUP_NAME_PATTERN.test(group),
    );
  } catch {
    return [];
  }
}

/**
 * GET /api/v1/users
 *
 * How much of the user table a caller may see, which is a different answer for
 * an ordinary member than for whoever administers the instance:
 *   - `?id=<userId>`     → single minimal profile (id, name, image)
 *   - `?spaceId=<id>`    → members of a space the caller belongs to, the same
 *                          minimal profiles
 *   - unscoped           → the register: every account with its email, group
 *                          claim and join date. Instance admins only.
 *
 * The scoped forms are deliberately narrow, and stay so: they are what any
 * signed-in account may ask, and an unscoped listing there would dump the table
 * and every address in it. The register is the same listing behind the one gate
 * that makes it answerable — an instance admin is owner on every space that
 * exists, so it shows them nothing they could not read a space at a time —
 * which is why a caller who does not administer the instance gets 403 rather
 * than a 400 telling them to scope the request. Inviting people is still done
 * by email through the permissions endpoint; nobody needs the register for that.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);
    const db = getAuthDb();

    const id = new URL(context.req.url).searchParams.get("id");
    const spaceId = new URL(context.req.url).searchParams.get("spaceId");

    // Email is selected only so resolveProfileImage can derive a Gravatar URL
    // from it; toPublicProfile drops it again, so it never leaves the server.
    const profileFields = {
      id: user.id,
      name: user.name,
      image: user.image,
      email: user.email,
    } as const;

    const toPublicProfile = (row: {
      id: string;
      name: string;
      image: string | null;
      email: string;
    }) => ({
      id: row.id,
      name: row.name,
      image: resolveProfileImage(row),
    });

    if (id) {
      const result = await one(
        db.select(profileFields).from(user).where(eq(user.id, id)),
      );
      if (!result) {
        throw notFoundResponse("User");
      }
      return jsonResponse(toPublicProfile(result));
    }

    if (spaceId) {
      // Only members of the space may enumerate its members.
      await verifyAccess(
        spaceId,
        { type: ResourceType.SPACE, id: spaceId },
        caller.id,
        Permission.VIEWER,
      );

      const memberIds = [...(await getSpaceMemberIds(spaceId))];
      // The space creator may not have an explicit ACL row; include the caller.
      if (!memberIds.includes(caller.id)) {
        memberIds.push(caller.id);
      }
      if (memberIds.length === 0) {
        return jsonResponse([]);
      }

      const members = await db
        .select(profileFields)
        .from(user)
        .where(inArray(user.id, memberIds));
      return jsonResponse(members.map(toPublicProfile));
    }

    if (!(await isInstanceAdmin(caller.id))) {
      throw forbiddenResponse("You are not allowed to list the instance's users");
    }

    const accounts = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        groups: user.groups,
        createdAt: user.createdAt,
      })
      .from(user)
      .orderBy(desc(user.createdAt));

    return jsonResponse(
      accounts.map((row) => ({
        id: row.id,
        name: row.name,
        // The register's reason for existing, unlike toPublicProfile above.
        email: row.email,
        image: resolveProfileImage(row),
        groups: storedGroups(row.groups),
        createdAt: row.createdAt,
      })),
    );
  }, "Failed to list users");
