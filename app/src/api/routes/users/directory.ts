import { desc } from "drizzle-orm";
import { isInstanceAdmin } from "#acl/instanceGroups.ts";
import { GROUP_NAME_PATTERN, PUBLIC_GROUP } from "#acl/permissions.ts";
import {
  forbiddenResponse,
  jsonResponse,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getAuthDb } from "#db/client/db.ts";
import { user } from "#db/schema/auth.ts";
import { resolveProfileImage } from "#utils/gravatar.ts";

/**
 * The stored group claim as a list, without the freshness bound and the
 * synthetic `public` that {@link import("#acl/userGroups.ts").getUserGroups}
 * adds: this is the register printing what the IdP last said, not a decision
 * being authorized. Malformed names are dropped for the same reason as there —
 * nothing the IdP wrote is trusted to be a group name.
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
 * GET /api/v1/users/directory
 *
 * Every account on the instance — the listing `/api/v1/users` refuses to serve,
 * because it carries the email and group claim of people the caller shares no
 * space with. Instance admins only, who are already owner on every space that
 * exists, so this tells them nothing they could not read a space at a time.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);
    if (!(await isInstanceAdmin(caller.id))) {
      throw forbiddenResponse("You are not allowed to list the instance's users");
    }

    const rows = await getAuthDb()
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
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        image: resolveProfileImage(row),
        groups: storedGroups(row.groups),
        createdAt: row.createdAt,
      })),
    );
  }, "Failed to list the instance's users");
