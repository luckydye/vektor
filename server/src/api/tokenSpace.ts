/**
 * The space a request names for its access token. A token is only ever checked
 * in the space its caller names, so nothing scans spaces to find where it lives.
 */

import { badRequestResponse, notFoundResponse } from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { isActiveSpace } from "#db/auth/spaceIndex.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { isPersonalToken } from "#db/space/accessTokens.ts";

/** The `?space=` of this request; a 400 that says what to pass when it is missing. */
export function requireSpaceQuery(context: ApiContext): string {
  const spaceId = new URL(context.req.url).searchParams.get("space");
  if (!spaceId) {
    throw badRequestResponse(
      "Add ?space=<spaceId>, naming the space the access token belongs to",
    );
  }
  return spaceId;
}

/** The store of the space named by `?space=`, when it holds a token `userId` issued. */
export async function openPersonalTokenStore(
  context: ApiContext,
  userId: string,
  tokenId: string,
): Promise<SpaceStore> {
  const spaceId = requireSpaceQuery(context);
  if (!(await isActiveSpace(context.var.platform, spaceId))) {
    throw notFoundResponse("Access token");
  }
  const store = await openSpaceStore(context.var.platform, spaceId);
  if (!(await isPersonalToken(store, userId, tokenId))) {
    throw notFoundResponse("Access token");
  }
  return store;
}
