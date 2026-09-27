import { eq } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference } from "#db/schema/space.ts";
import { maxWeeklyAITokens } from "#db/space/aiConfig.ts";
import { getAIUsage } from "#db/space/aiUsage.ts";

const KEY = "aiWeeklyTokenLimit";

/** Read this space's current UTC-week estimated token usage and limits.
 * @tag AI
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );
    return jsonResponse(await getAIUsage(await openSpaceStore(spaceId)));
  }, "Failed to read AI usage");

/** Set a space budget up to the operator's maximum.
 * @tag AI
 */
export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );
    const body = await parseJsonBody<{ limit?: number }>(context.req.raw);
    const limit = body && typeof body === "object" ? body.limit : undefined;
    if (
      limit === undefined ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > maxWeeklyAITokens()
    ) {
      throw badRequestResponse(
        `limit must be a positive integer at most ${maxWeeklyAITokens()}`,
      );
    }
    const store = await openSpaceStore(spaceId);
    const now = new Date();
    await store.tx(async (tx) => {
      const [existing] = await tx.db
        .select({ id: preference.id })
        .from(preference)
        .where(eq(preference.key, KEY))
        .limit(1);
      if (existing) {
        await tx.db
          .update(preference)
          .set({ value: String(limit), updatedAt: now })
          .where(eq(preference.id, existing.id));
      } else {
        await tx.db.insert(preference).values({
          id: createId("preference"),
          key: KEY,
          value: String(limit),
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    return jsonResponse(await getAIUsage(store));
  }, "Failed to update AI limit");
