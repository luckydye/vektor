/**
 * The caller's OAuth groups, which every authorization decision resolves
 * against. Its own module rather than part of the ACL store: it reads the auth
 * database and the IdP sync, not any space's `acl` table, and the instance-level
 * gates need it without the store having to depend on them in turn.
 */

import { eq } from "drizzle-orm";
import { ensureFreshGroups } from "#acl/idpSync.ts";
import { GROUP_NAME_PATTERN, PUBLIC_GROUP } from "#acl/permissions.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { user } from "#db/schema/auth.ts";

/**
 * The groups this id belongs to, or none at all when no user carries it — a
 * credential's id, an account since deleted. Callers that need a group set for
 * an ACL query read empty as `[public]`; saying `[public]` from here instead
 * would claim a person exists, which is what let a non-person be told apart by
 * the shape of its id.
 */
export async function getUserGroups(userId: string): Promise<string[]> {
  const authDb = getAuthDb();
  // No auth database at all: nobody has groups, so everyone is just the public.
  if (!authDb) {
    return [PUBLIC_GROUP];
  }

  // Every authorization decision funnels through here, which is why the claim's
  // staleness is bounded at this point rather than at the request edge.
  await ensureFreshGroups(userId);

  const userRecord = await one(authDb.select().from(user).where(eq(user.id, userId)));
  if (!userRecord) return [];

  const groups = [PUBLIC_GROUP];

  if (userRecord.groups) {
    try {
      const userGroups = JSON.parse(userRecord.groups);
      if (Array.isArray(userGroups)) {
        // Defense in depth: do not trust stored groups blindly — only
        // well-formed names enter the authorization group set.
        groups.push(
          ...userGroups.filter(
            (g): g is string => typeof g === "string" && GROUP_NAME_PATTERN.test(g),
          ),
        );
      }
    } catch {
      // Keep just "public"
    }
  }

  return groups;
}
