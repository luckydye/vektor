/**
 * HTTP Basic authentication for the protocols that only speak it — CalDAV
 * clients, git over HTTPS, anything else that cannot carry a session cookie.
 *
 * The username is the user's email and the password an access token, and the
 * identity that comes back carries the token rather than merely being found by
 * it. Callers must authorize against those grants: a token scoped to one space
 * at viewer level must not buy the user's own access everywhere else.
 */

import { eq } from "drizzle-orm";
import { isNoAuthMode, LOCAL_USER, LOCAL_USER_ID } from "#config";
import { getAuthDb } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { user } from "#db/schema/auth.ts";
import { type ValidateTokenResult, validateAccessToken } from "#db/space/accessTokens.ts";
import { listUserSpaces } from "#db/space/spaces.ts";

/**
 * The access token a Basic-auth client authenticated with.
 *
 * `spaceId` is the space whose store holds the token row. Access tokens live in
 * exactly one space's database, so that space is the only one a token can ever
 * reach — every other space the user belongs to is out of the token's scope by
 * construction, and `result` carries the ACL identity — the token's id — that says
 * what it may do *within* that space.
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
 * The returned identity carries the token that authenticated it: the token is
 * NOT merely a way to look the user up. Callers must authorize against
 * {@link BasicAuthUser.token} (see {@link requireBasicAuthUserAndAccess}), otherwise a
 * token scoped to one space at viewer level would grant the user's full access
 * to every space they belong to.
 */
export async function verifyBasicAuth(
  authHeader: string | null,
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

  const authDb = getAuthDb();
  const foundUser = await one(authDb.select().from(user).where(eq(user.email, email)));
  if (!foundUser) return null;

  // A token row exists only in the database of the space it was created in, so
  // this search establishes *which* space the token belongs to — it can never
  // "find" a space-A token by probing space B. The space it is found in is
  // carried out as the token's scope.
  const spaces = await listUserSpaces(foundUser.id);
  for (const space of spaces) {
    const result = await validateAccessToken(await openSpaceStore(space.id), token);
    if (result && result.token.createdBy === foundUser.id) {
      return {
        id: foundUser.id,
        email: foundUser.email,
        name: foundUser.name,
        token: { spaceId: space.id, result },
      };
    }
  }

  return null;
}
