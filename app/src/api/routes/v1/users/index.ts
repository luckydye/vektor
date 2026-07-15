import { eq, inArray } from "drizzle-orm";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getSpaceMemberIds } from "#db/acl.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  requireUser,
  verifySpaceAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuthDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";

/**
 * GET /api/v1/users
 *
 * Returns minimal public profiles. To prevent a full user-directory dump and
 * PII (email) leak to any logged-in account, callers must scope the request:
 *   - `?id=<userId>`     → single minimal profile (id, name, image)
 *   - `?spaceId=<id>`    → members of a space the caller belongs to
 * A bare listing of all users is not permitted. Inviting people is done by
 * email via the permissions endpoint, so no user-directory endpoint is needed.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);
    const db = getAuthDb();

    const id = new URL(context.req.url).searchParams.get("id");
    const spaceId = new URL(context.req.url).searchParams.get("spaceId");

    // Minimal public profile fields only — never expose email here.
    const publicFields = {
      id: user.id,
      name: user.name,
      image: user.image,
    } as const;

    if (id) {
      const result = await db
        .select(publicFields)
        .from(user)
        .where(eq(user.id, id))
        .get();
      if (!result) {
        throw notFoundResponse("User");
      }
      return jsonResponse(result);
    }

    if (spaceId) {
      // Only members of the space may enumerate its members.
      await verifySpaceAccess(spaceId, caller.id);

      const memberIds = [...(await getSpaceMemberIds(spaceId))];
      // The space creator may not have an explicit ACL row; include the caller.
      if (!memberIds.includes(caller.id)) {
        memberIds.push(caller.id);
      }
      if (memberIds.length === 0) {
        return jsonResponse([]);
      }

      const members = await db
        .select(publicFields)
        .from(user)
        .where(inArray(user.id, memberIds));
      return jsonResponse(members);
    }

    throw badRequestResponse("Either 'id' or 'spaceId' query parameter is required");
  }, "Failed to list users");
