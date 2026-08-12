import { eq, inArray } from "drizzle-orm";
import { verifySpaceAccess } from "#acl/guards.ts";
import { getSpaceMemberIds } from "#acl/store.ts";
import {
  badRequestResponse,
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
        .select(profileFields)
        .from(user)
        .where(inArray(user.id, memberIds));
      return jsonResponse(members.map(toPublicProfile));
    }

    throw badRequestResponse("Either 'id' or 'spaceId' query parameter is required");
  }, "Failed to list users");
