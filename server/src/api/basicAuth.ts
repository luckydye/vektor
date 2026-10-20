/**
 * HTTP Basic authentication for the protocols that only speak it — git over
 * HTTPS, anything else that cannot carry a session cookie.
 *
 * The username is the user's email and the password an access token, and the
 * identity that comes back carries the token rather than merely being found by
 * it. Callers must authorize against those grants: a token scoped to one space
 * at viewer level must not buy the user's own access everywhere else.
 */

import { eq } from "drizzle-orm";
import type { ApiContext } from "#api/server/types.ts";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#config";
import { isActiveSpace } from "#db/auth/spaceIndex.ts";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import { type ValidateTokenResult, validateAccessToken } from "#db/space/accessTokens.ts";
import type { Platform } from "#platform/platform.ts";

/**
 * The access token a Basic-auth client authenticated with.
 *
 * `spaceId` is the space the URL named and whose store holds the token row, the
 * only space the token can reach. `result` carries the token's id, the ACL
 * identity that says what it may do there.
 */
export interface BasicAuthToken {
  spaceId: string;
  result: ValidateTokenResult;
}

export interface BasicAuthUser {
  id: string;
  email: string;
  name: string;
  /**
   * Set only for callers that authenticated with an access token over Basic
   * auth. Its presence means the caller's authority is the *token's* ACL
   * grants, not the user's own access — the user identity only records who
   * delegated the token (and whose name new documents are attributed to).
   * Session callers leave it undefined and keep being authorized against their
   * own ACL.
   */
  token?: BasicAuthToken;
}

/**
 * Authenticate a request using HTTP Basic auth.
 * Username is the user's email, password is an access token (at_...).
 *
 * The token is checked only in `spaceId`, the space the request URL names. The
 * returned identity carries the token, and callers must authorize against {@link BasicAuthUser.token}.
 */
export async function verifyBasicAuth(
  platform: Platform,
  authHeader: string | null,
  spaceId: string,
): Promise<BasicAuthUser | null> {
  if (!authHeader?.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = atob(authHeader.slice(6));
  } catch {
    return null;
  }

  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) return null;

  const email = decoded.slice(0, colonIdx);
  const token = decoded.slice(colonIdx + 1);

  if (isNoAuthMode() && email === LOCAL_USER.email) {
    return { id: LOCAL_USER_ID, email: LOCAL_USER.email, name: LOCAL_USER.name };
  }

  if (!(await isActiveSpace(platform, spaceId))) return null;

  const authDb = getAuthDb(platform);
  const foundUser = await one(authDb.select().from(user).where(eq(user.email, email)));
  if (!foundUser) return null;

  const result = await validateAccessToken(
    await openSpaceStore(platform, spaceId),
    token,
  );
  if (!result || result.token.createdBy !== foundUser.id) return null;

  return {
    id: foundUser.id,
    email: foundUser.email,
    name: foundUser.name,
    token: { spaceId, result },
  };
}

/**
 * The caller of a protocol that also speaks Basic auth: the session user when
 * there is one, else the Basic-auth user checked in `spaceId`.
 */
export async function verifyBasicAuthUser(
  context: ApiContext,
  spaceId: string,
): Promise<BasicAuthUser | null> {
  const sessionUser = context.var.user;
  if (sessionUser) {
    return { id: sessionUser.id, email: sessionUser.email, name: sessionUser.name };
  }
  return verifyBasicAuth(
    context.var.platform,
    context.req.raw.headers.get("Authorization"),
    spaceId,
  );
}
