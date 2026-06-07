import type { APIRoute } from "astro";
import { eq, inArray } from "drizzle-orm";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  requireUser,
  verifySpaceAccess,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import { getAuthDb } from "#db/db.ts";
import { user } from "#db/schema/auth.ts";
import { getSpaceMemberIds } from "#db/acl.ts";

/**
 * GET /api/v1/users
 *
 * Returns minimal public profiles. To prevent a full user-directory dump and
 * PII (email) leak to any logged-in account, callers must scope the request:
 *   - `?id=<userId>`                    → single minimal profile (id, name, image)
 *   - `?spaceId=<id>`                   → members of a space the caller belongs to
 *   - `?spaceId=<id>&scope=candidates`  → directory for adding members; restricted
 *                                         to space OWNERS (includes email so an
 *                                         owner can disambiguate users to invite)
 * A bare listing of all users is no longer permitted.
 */
export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);
    const db = getAuthDb();

    const id = context.url.searchParams.get("id");
    const spaceId = context.url.searchParams.get("spaceId");

    // Minimal public profile fields only — never expose email here.
    const publicFields = {
      id: user.id,
      name: user.name,
      image: user.image,
    } as const;

    if (id) {
      const result = await db.select(publicFields).from(user).where(eq(user.id, id)).get();
      if (!result) {
        throw notFoundResponse("User");
      }
      return jsonResponse(result);
    }

    if (spaceId) {
      // Owner-only directory for inviting new members. Includes email so the
      // owner can tell users apart; gated behind ownership of this space.
      if (context.url.searchParams.get("scope") === "candidates") {
        await verifySpaceRole(spaceId, caller.id, "owner");
        const candidates = await db
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            image: user.image,
          })
          .from(user);
        return jsonResponse(candidates);
      }

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
